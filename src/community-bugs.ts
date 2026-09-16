import { bugQuestionTemplate, deliverBugQuestion } from "./community-bug-delivery";
import { deliverBugHandoff, deliverBugSummary } from "./community-bug-delivery-messages";
import { replayBugDelivery } from "./community-bug-delivery-replay";
import { advanceBugDialogue } from "./community-bug-dialogue";
import { bugCandidate, type ParsedBugReport, storedBugFields } from "./community-bug-facts";
import { randomBugIdentity, writeBugPrivateObject } from "./community-bug-private";
import { confirmBugReport, continueBugReport } from "./community-bug-session";
import {
  bugEntryPayload,
  isBugReportMessage,
  openBugReportModal,
  parseBugReportModal,
} from "./community-bug-slack";
import { CommunityBugStore } from "./community-bug-store";
import type { BugDraft } from "./community-bug-types";
import { type CommunityContext, post } from "./community-runtime";
import { InputError } from "./input";
import { NeonStore } from "./store";

export {
  confirmBugReport,
  continueBugReport,
  isBugReportMessage,
  openBugReportModal,
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
  const encrypted = await writeBugPrivateObject(context, bugId, 1, parsed);
  const store = new CommunityBugStore(new NeonStore(context.env.DATABASE_URL));
  let draft: BugDraft;
  try {
    draft = await store.createDraft({
      ...encrypted,
      bugId,
      teamId: context.scope.teamId,
      publicAlias: randomBugIdentity("B"),
      reporterId: context.scope.userId,
      source: "slack",
      sourceOpaqueRef: source.opaqueRef,
      sourceChannelId: context.scope.channelId,
      sourceThread: context.thread,
      idempotencyKey: `slack:${context.scope.teamId}:${context.scope.channelId}:${context.source}`,
      sanitizedFields: {
        title:
          dialogue.packet.actual.status === "known"
            ? dialogue.packet.actual.value.slice(0, 160)
            : "Slack 버그 제보",
        ...storedBugFields(dialogue.packet),
        privacy:
          dialogue.packet.impact.status === "known" &&
          dialogue.packet.impact.value === "security_privacy",
      },
    });
  } catch (error) {
    await context.env.BUG_PRIVATE_OBJECTS?.delete(encrypted.opaqueRef);
    throw error;
  }
  if (draft.bugId !== bugId) await context.env.BUG_PRIVATE_OBJECTS?.delete(encrypted.opaqueRef);
  if (
    dialogue.packet.impact.status === "known" &&
    dialogue.packet.impact.value === "security_privacy"
  ) {
    await store.transition({
      bugId: draft.bugId,
      toState: "private_incident",
      actors: ["deterministic_worker"],
      guard: { privacyOrSecurity: true },
      evidence: { intakeDigest: encrypted.objectDigest },
      expectedRevision: draft.revision,
      idempotencyKey: `private:${context.key}`,
    });
    await deliverBugHandoff(context, {
      bugId: draft.bugId,
      reporterId: context.scope.userId,
      packetRevision: draft.packetRevision,
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
  if (!isBugReportMessage(text)) return false;
  if (text.trim() === "버그 제보") {
    await post(context, bugEntryPayload(context));
    return true;
  }
  const report = text.trim().replace(/^버그\s*:\s*/s, "");
  const message = { id: context.source, text: report, at: new Date().toISOString() };
  const candidates = [bugCandidate("actual", message.id, report)];
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
