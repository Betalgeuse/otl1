import { armBugDeliveryClock } from "./community-bug-clock-client";
import { bugQuestionTemplate, deliverBugQuestion } from "./community-bug-delivery";
import { deliverBugSummary, deliverPrivateBugOutbox } from "./community-bug-delivery-messages";
import { replayBugDelivery } from "./community-bug-delivery-replay";
import { advanceBugDialogue } from "./community-bug-dialogue";
import {
  claimBugTextEntry,
  finishBugTextEntry,
  startBugTextEntry,
} from "./community-bug-entry-session";
import {
  containsSensitiveBugText,
  initialBugFieldsForDatabase,
  type ParsedBugReport,
  storedBugFields,
} from "./community-bug-facts";
import { isBugReportMessage, parseBugIntakeCandidate } from "./community-bug-intent";
import { digestBugText, randomBugIdentity, writeBugPrivateObject } from "./community-bug-private";
import { bugReportCandidates } from "./community-bug-report";
import { confirmBugReport, continueBugReport } from "./community-bug-session";
import { openBugReportModal, parseBugReportModal } from "./community-bug-slack";
import { CommunityBugStore } from "./community-bug-store";
import type { BugDraft } from "./community-bug-types";
import { type CommunityContext, textReply } from "./community-runtime";
import { InputError } from "./input";
import { NeonStore, StoreError } from "./store";

export {
  confirmBugReport,
  continueBugReport,
  isBugReportMessage,
  openBugReportModal,
  parseBugIntakeCandidate,
  parseBugReportModal,
  replayBugDelivery,
};

async function startBugReport(
  context: CommunityContext,
  parsed: ParsedBugReport,
): Promise<BugDraft> {
  const bugId = randomBugIdentity("BUG");
  const source = {
    kind: "slack_thread",
    opaqueRef: `slack:${context.scope.teamId}:${context.scope.channelId}:${context.thread}`,
  };
  const dialogue = await advanceBugDialogue({
    bugId,
    expectedRevision: 1,
    currentRevision: 1,
    source,
    messages: parsed.messages,
    candidates: parsed.candidates,
    now: new Date().toISOString(),
  });
  if (dialogue.status === "confirmed") throw new InputError("이미 확인된 제보예요.");
  const privateIncident =
    (dialogue.packet.impact.status === "known" &&
      dialogue.packet.impact.value === "security_privacy") ||
    parsed.messages.some((message) => containsSensitiveBugText(message.text));
  const databaseFields = initialBugFieldsForDatabase(
    storedBugFields(dialogue.packet),
    privateIncident,
  );
  const store = new CommunityBugStore(new NeonStore(context.env.DATABASE_URL));
  const encrypted = await writeBugPrivateObject(context, bugId, 1, { parsed });
  const createInput = {
    ...encrypted,
    bugId,
    teamId: context.scope.teamId,
    publicAlias: randomBugIdentity("B"),
    reporterId: context.scope.userId,
    source: "slack" as const,
    sourceOpaqueRef: source.opaqueRef,
    sourceChannelId: context.scope.channelId,
    sourceThread: context.thread,
    idempotencyKey: `slack:${context.scope.teamId}:${context.scope.channelId}:${context.source}`,
    sanitizedFields: {
      title: privateIncident ? "비공개 버그 제보" : "Slack 버그 제보",
      ...databaseFields,
      privacy: privateIncident,
    },
  };
  let draft: BugDraft;
  try {
    draft = await store.createDraft(createInput);
  } catch (error) {
    try {
      draft = await store.createDraft(createInput);
    } catch (reconciliationError) {
      if (
        error instanceof StoreError &&
        reconciliationError instanceof StoreError &&
        error.code === "access" &&
        reconciliationError.code === "access"
      ) {
        await context.env.BUG_PRIVATE_OBJECTS?.delete(encrypted.opaqueRef);
      }
      throw error;
    }
  }
  if (draft.bugId !== bugId) await context.env.BUG_PRIVATE_OBJECTS?.delete(encrypted.opaqueRef);
  if (privateIncident) {
    await deliverPrivateBugOutbox(context, {
      bugId: draft.bugId,
      reporterId: context.scope.userId,
      packetRevision: draft.packetRevision,
    });
    const observedAt = Date.now();
    await armBugDeliveryClock(context.env, {
      reason: "due",
      observedAt,
      nextDue: observedAt + 1_000,
    });
    return draft;
  }
  if (dialogue.status === "awaiting_confirmation") {
    await deliverBugSummary(context, {
      bugId: draft.bugId,
      reporterId: context.scope.userId,
      packetRevision: draft.packetRevision,
      revision: draft.revision,
      label: draft.publicAlias,
      fields: dialogue.summary.fields,
    });
    return draft;
  }
  if (dialogue.status !== "needs_info") throw new InputError("운영자 확인이 필요해요.");
  const questionId = `${draft.bugId}:q1:${dialogue.question.field}`;
  const templateId = bugQuestionTemplate(dialogue.question.field);
  await store.transition({
    bugId: draft.bugId,
    toState: "needs_info",
    actors: ["deterministic_worker"],
    guard: { missingRequiredField: true },
    evidence: {
      reasonCodes: [`missing:${dialogue.question.field}`],
      questionId,
      fieldName: dialogue.question.field,
      templateVersion: templateId,
      questionText: dialogue.question.text,
    },
    expectedRevision: draft.revision,
    idempotencyKey: `question:${context.key}`,
  });
  const observedAt = Date.now();
  await armBugDeliveryClock(context.env, {
    reason: "due",
    observedAt,
    nextDue: observedAt + 86_400_000,
  });
  await deliverBugQuestion(context, {
    bugId: draft.bugId,
    reporterId: context.scope.userId,
    packetRevision: draft.packetRevision,
    questionId,
    fieldName: dialogue.question.field,
    templateId,
    question: dialogue.question,
  });
  return draft;
}

export async function submitBugReportModal(
  context: CommunityContext,
  values: unknown,
): Promise<Readonly<Record<string, string>> | null> {
  const parsed = parseBugReportModal(values);
  if ("errors" in parsed) return parsed.errors;
  await startBugReport(context, parsed);
  return null;
}

export async function handleBugReportMessage(
  context: CommunityContext,
  text: string,
): Promise<boolean> {
  const initialIntent = parseBugIntakeCandidate(
    text,
    [context.env.COMMUNITY_CHANNEL_ID, context.env.COMMUNITY_FEEDBACK_CHANNEL_ID].includes(
      context.scope.channelId,
    ),
  );
  const shouldInspectEntry =
    context.thread !== context.source &&
    (context.bugTextEntryState === undefined
      ? initialIntent === null
      : context.bugTextEntryState !== "missing");
  if (shouldInspectEntry) {
    const session = await claimBugTextEntry(context);
    if (session === "active") {
      const message = { id: context.source, text: text.trim(), at: new Date().toISOString() };
      try {
        await startBugReport(context, {
          messages: [message],
          candidates: bugReportCandidates(message.id, message.text),
        });
        await finishBugTextEntry(context, "sent");
      } catch (error) {
        await finishBugTextEntry(context, "failed");
        throw error;
      }
      return true;
    }
    if (session === "expired") {
      await textReply(
        context,
        "버그 제보 입력 시간이 지났어요. 새 메시지로 ‘버그제보’라고 알려주세요.",
      );
      return true;
    }
    if (session === "consumed") {
      if (await continueBugReport(context, text)) return true;
      await textReply(
        context,
        "이 입력은 이미 처리했어요. 진행 중인 질문에 답하거나 ‘버그 제보 계속’이라고 알려주세요.",
      );
      return true;
    }
  }
  const intent = initialIntent;
  if (!intent) return false;
  if (intent.kind === "entry") {
    await startBugTextEntry(context, await digestBugText(text));
    await textReply(context, "어떤 문제가 발생했나요? 이 스레드에 메시지로 알려주세요.");
    return true;
  }
  const report = intent.report;
  const message = { id: context.source, text: report, at: new Date().toISOString() };
  const candidates = bugReportCandidates(message.id, report);
  const sensitive = /개인정보|보안|토큰|비밀번호|노출/.exec(report);
  if (sensitive?.[0])
    candidates.push({
      field: "impact",
      messageId: message.id,
      start: sensitive.index,
      end: sensitive.index + sensitive[0].length,
      quote: sensitive[0],
      value: "security_privacy",
    });
  await startBugReport(context, { messages: [message], candidates });
  return true;
}
