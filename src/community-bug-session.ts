import { restoreUnseenBugQuestion } from "./community-bug-answer-guard";
import { armBugDeliveryClock } from "./community-bug-clock-client";
import { findActiveBugDraftForContext } from "./community-bug-context";
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
import {
  analyzeFeedback,
  confirmCompactFeedback,
  fallbackFeedbackAnalysis,
  postFeedbackAdminReview,
} from "./community-feedback";
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
  const active = await findActiveBugDraftForContext(store, context);
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
  if (!privateIncident && active.source.opaqueRef.startsWith("slack-feedback:")) {
    const actual = result.packet.actual.status === "known" ? result.packet.actual.value.trim() : "";
    const expected =
      result.packet.expected.status === "known" ? result.packet.expected.value.trim() : "";
    const analysis = context.env.AI
      ? await analyzeFeedback(context.env.AI, { actual, expected }).catch(() =>
          fallbackFeedbackAnalysis({ actual, expected }),
        )
      : fallbackFeedbackAnalysis({ actual, expected });
    if (analysis.ready && actual && expected) {
      const nextDraft = { ...active, packetRevision };
      await confirmCompactFeedback(context, {
        draft: nextDraft,
        parsed,
        sourceOpaqueRef: active.source.opaqueRef,
        reporterId: active.reporterId,
        fromState: "needs_info",
      });
      await postFeedbackAdminReview(context, {
        feedbackId: active.bugId,
        packetRevision: packetRevision + 1,
      });
      return true;
    }
    if (active.questions.length >= 3) {
      await exhaustBugReport(context, active, encrypted.objectDigest, packetRevision);
      return true;
    }
    const field = analysis.questionField ?? (expected ? "actual" : "expected");
    const question = {
      field,
      kind: "free_text" as const,
      text:
        analysis.question ??
        (field === "actual"
          ? "지금 어떤 점이 가장 불편한지 한 가지 사례로 알려주실래요?"
          : "이 의견이 반영되면 사용자가 무엇을 할 수 있게 되면 좋을까요?"),
    };
    const questionId = `${active.bugId}:q${active.questions.length + 1}:${field}`;
    const templateId = "question.feedback-context.v1";
    await store.transition({
      bugId: active.bugId,
      toState: "needs_info",
      actors: ["reporter", "deterministic_worker"],
      guard: { stillIncomplete: true },
      evidence: {
        answerRevision: packetRevision,
        completenessResult: "needs_info",
        questionId,
        fieldName: field,
        templateVersion: templateId,
        questionText: question.text,
      },
      expectedRevision: active.revision,
      idempotencyKey: `question:${context.key}`,
    });
    await deliverBugQuestion(context, {
      bugId: active.bugId,
      reporterId: active.reporterId,
      packetRevision,
      questionId,
      fieldName: field,
      templateId,
      question,
    });
    return true;
  }
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
