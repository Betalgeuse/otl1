import { restoreUnseenBugQuestion } from "./community-bug-answer-guard";
import { armBugDeliveryClock } from "./community-bug-clock-client";
import { bugQuestionTemplate, deliverBugQuestion } from "./community-bug-delivery";
import {
  deliverBugReceipt,
  deliverBugSummary,
  deliverPrivateBugOutbox,
} from "./community-bug-delivery-messages";
import { replayBugDelivery } from "./community-bug-delivery-replay";
import { advanceBugDialogue } from "./community-bug-dialogue";
import {
  appendBugAnswer,
  bugFieldsForDatabase,
  containsSensitiveBugText,
  storedBugFields,
} from "./community-bug-facts";
import { digestBugText, writeBugPrivateObject } from "./community-bug-private";
import { readBugPrivateReport } from "./community-bug-private-report";
import { resumeBugDialogue } from "./community-bug-resume";
import { canonicalJson, isBugField } from "./community-bug-schema";
import { bugDialogueInput, exhaustBugReport } from "./community-bug-session-state";
import { CommunityBugStore } from "./community-bug-store";
import { postFeedbackAdminReview } from "./community-feedback";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { InputError } from "./input";
import { NeonStore } from "./store";

export async function continueBugReport(
  context: CommunityContext,
  answer: string,
  expectedQuestionId?: string,
): Promise<boolean> {
  if (context.thread === context.source && expectedQuestionId === undefined) return false;
  const store = new CommunityBugStore(new NeonStore(context.env.DATABASE_URL));
  const active = await store.findActiveDraft({
    teamId: context.scope.teamId,
    reporterId: context.scope.userId,
    sourceOpaqueRef: `slack:${context.scope.teamId}:${context.scope.channelId}:${context.thread}`,
  });
  if (!active) return false;
  if (
    active.needsInfoStartedAt &&
    Date.parse(active.needsInfoStartedAt) <= Date.now() - 86_400_000
  ) {
    await exhaustBugReport(context, active, active.currentRevision.objectDigest);
    return true;
  }
  const question = active.questions.findLast((item) => !item.answered);
  if (!question || !isBugField(question.fieldName)) {
    return resumeBugDialogue(context, active);
  }
  if (expectedQuestionId && expectedQuestionId !== question.questionId) {
    await replayBugDelivery(context);
    return true;
  }
  if (/^(버그 제보 )?취소$/.test(answer.trim())) {
    await ephemeral(context, {
      text: "버그 제보를 잠시 멈췄어요. 같은 스레드에서 ‘버그 제보 계속’이라고 알려주세요.",
    });
    return true;
  }
  if (/^버그 제보 계속$/.test(answer.trim())) {
    if (!(await replayBugDelivery(context))) await resumeBugDialogue(context, active);
    return true;
  }
  if (await restoreUnseenBugQuestion(context, active, question)) return true;
  const parsed = appendBugAnswer(
    await readBugPrivateReport(context, active),
    question.fieldName,
    context.source,
    answer,
  );
  const result = await advanceBugDialogue(bugDialogueInput(active, parsed));
  if (result.status === "confirmed") throw new InputError("이미 확인된 제보예요.");
  const privateIncident =
    (result.packet.impact.status === "known" &&
      result.packet.impact.value === "security_privacy") ||
    containsSensitiveBugText(answer);
  const encrypted = await writeBugPrivateObject(context, active.bugId, active.packetRevision + 1, {
    parsed,
  });
  const packetRevision = await store.answerRevision({
    ...encrypted,
    bugId: active.bugId,
    reporterId: active.reporterId,
    questionId: question.questionId,
    answerDigest: await digestBugText(answer),
    answerOpaqueRef: encrypted.opaqueRef,
    expectedPacketRevision: active.packetRevision,
    idempotencyKey: `answer:${context.key}`,
    privacy: privateIncident,
    sanitizedFields: bugFieldsForDatabase(storedBugFields(result.packet), privateIncident),
    completeness: { status: result.status },
  });
  if (privateIncident) {
    await deliverPrivateBugOutbox(context, {
      bugId: active.bugId,
      reporterId: active.reporterId,
      packetRevision,
    });
    const observedAt = Date.now();
    await armBugDeliveryClock(context.env, {
      reason: "due",
      observedAt,
      nextDue: observedAt + 1_000,
    });
    return true;
  }
  if (result.status === "needs_info") {
    const questionId = `${active.bugId}:q${active.questions.length + 1}:${result.question.field}`;
    const templateId = bugQuestionTemplate(result.question.field);
    await store.transition({
      bugId: active.bugId,
      toState: "needs_info",
      actors: ["reporter", "deterministic_worker"],
      guard: { stillIncomplete: true },
      evidence: {
        answerRevision: packetRevision,
        completenessResult: result.status,
        questionId,
        fieldName: result.question.field,
        templateVersion: templateId,
        questionText: result.question.text,
      },
      expectedRevision: active.revision,
      idempotencyKey: `question:${context.key}`,
    });
    const observedAt = Date.now();
    const startedAt = active.needsInfoStartedAt
      ? Date.parse(active.needsInfoStartedAt)
      : observedAt;
    await armBugDeliveryClock(context.env, {
      reason: "due",
      observedAt,
      nextDue: startedAt + 86_400_000,
    });
    await deliverBugQuestion(context, {
      bugId: active.bugId,
      reporterId: active.reporterId,
      packetRevision,
      questionId,
      fieldName: result.question.field,
      templateId,
      question: result.question,
    });
    return true;
  }
  if (result.status === "exhausted") {
    await exhaustBugReport(context, active, encrypted.objectDigest, packetRevision);
    return true;
  }
  if (result.status === "awaiting_confirmation") {
    await deliverBugSummary(context, {
      bugId: active.bugId,
      reporterId: active.reporterId,
      packetRevision,
      revision: active.revision,
      label: active.bugId,
      fields: result.summary.fields,
    });
    return true;
  }
  await ephemeral(context, { text: "이 제보는 운영자 확인이 필요해요." });
  return true;
}

export async function confirmBugReport(
  context: CommunityContext,
  bugId: string,
  expectedRevision: number,
): Promise<void> {
  const store = new CommunityBugStore(new NeonStore(context.env.DATABASE_URL));
  const draft = await store.getDraft({
    teamId: context.scope.teamId,
    bugId,
    reporterId: context.scope.userId,
  });
  if (draft.state === "triaged" && draft.currentRevision.confirmedPacket) {
    await deliverBugReceipt(context, {
      bugId,
      reporterId: draft.reporterId,
      packetRevision: draft.packetRevision,
    });
    return;
  }
  if (draft.revision !== expectedRevision)
    throw new InputError("최신 버그 초안을 다시 확인해 주세요.");
  const result = await advanceBugDialogue({
    ...bugDialogueInput(draft, await readBugPrivateReport(context, draft)),
    expectedRevision: draft.packetRevision + 1,
    currentRevision: draft.packetRevision + 1,
    reporterConfirmedAt: new Date().toISOString(),
  });
  if (result.status !== "confirmed") throw new InputError("최신 버그 초안을 다시 확인해 주세요.");
  const encrypted = await writeBugPrivateObject(
    context,
    bugId,
    draft.packetRevision + 1,
    {
      confirmedAt: result.packet.confirmation.confirmedAt,
      packetDigest: result.packet.packetDigest,
    },
    "bug_packet.v1",
  );
  const confirmed = await store.confirmPacket({
    packet: result.packet,
    storage: {
      ...encrypted,
      canonicalEvidence: canonicalJson(result.evidence),
      evidenceObjectDigest: encrypted.objectDigest,
      teamId: context.scope.teamId,
      reporterId: context.scope.userId,
      expectedPacketRevision: draft.packetRevision,
      idempotencyKey: `confirm:${context.key}`,
    },
  });
  await store.transition({
    bugId,
    toState: "triaged",
    actors: draft.state === "new" ? ["deterministic_worker"] : ["reporter", "deterministic_worker"],
    guard:
      draft.state === "new"
        ? { formComplete: true, privacyFalse: true }
        : { allMissingSupplied: true },
    evidence: { packetDigest: confirmed.packetDigest },
    expectedRevision: draft.revision,
    idempotencyKey: `triage:${context.key}`,
  });
  await deliverBugReceipt(context, {
    bugId,
    reporterId: draft.reporterId,
    packetRevision: draft.packetRevision + 1,
  });
  await postFeedbackAdminReview(context, {
    feedbackId: bugId,
    packetRevision: draft.packetRevision + 1,
  });
}
