import { replayBugDelivery } from "./community-bug-delivery-replay";
import {
  claimBugTextEntry,
  finishBugTextEntry,
  startBugTextEntry,
} from "./community-bug-entry-session";
import { isBugReportMessage, parseBugIntakeCandidate } from "./community-bug-intent";
import { digestBugText } from "./community-bug-private";
import { bugReportCandidates } from "./community-bug-report";
import { confirmBugReport, continueBugReport } from "./community-bug-session";
import { openBugReportModal, parseBugReportModal } from "./community-bug-slack";
import { startBugReport } from "./community-bug-start";
import { analyzeFeedback, fallbackFeedbackAnalysis } from "./community-feedback";
import { type CommunityContext, textReply } from "./community-runtime";
import { object } from "./input";

export {
  confirmBugReport,
  continueBugReport,
  isBugReportMessage,
  openBugReportModal,
  parseBugIntakeCandidate,
  parseBugReportModal,
  replayBugDelivery,
};

export async function submitBugReportModal(
  context: CommunityContext,
  values: unknown,
): Promise<Readonly<Record<string, string>> | null> {
  const parsed = parseBugReportModal(values);
  if ("errors" in parsed) return parsed.errors;
  const submittedFields = object(values);
  const compactFeedback = !["steps", "location", "occurredAt", "frequency", "impact"].some(
    (field) => submittedFields[field] !== undefined,
  );
  const actual = parsed.messages.find((message) => message.id === "form:actual")?.text ?? "";
  const expected = parsed.messages.find((message) => message.id === "form:expected")?.text ?? "";
  const analysis = compactFeedback
    ? context.env.AI
      ? await analyzeFeedback(context.env.AI, { actual, expected }).catch(() =>
          fallbackFeedbackAnalysis({ actual, expected }),
        )
      : fallbackFeedbackAnalysis({ actual, expected })
    : undefined;
  await startBugReport(context, parsed, analysis);
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
