import type { BugAnswerAction } from "./community-bug-actions";
import {
  confirmBugReport,
  continueBugReport,
  openBugReportModal,
  parseBugReportModal,
  submitBugReportModal,
} from "./community-bugs";
import { startCodexFeedback } from "./community-feedback";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { InputError, object, string } from "./input";

type WaitUntil = (promise: Promise<unknown>) => void;

export async function handleBugView(
  id: string,
  view: Record<string, unknown>,
  context: CommunityContext,
  waitUntil: WaitUntil,
): Promise<Response | null> {
  if (id !== "community_bug_submit") return null;
  const values = object(view.state).values;
  const parsed = parseBugReportModal(values);
  if ("errors" in parsed)
    return Response.json({ response_action: "errors", errors: parsed.errors });
  waitUntil(
    submitBugReportModal(context, values).catch(async (error: unknown) => {
      await ephemeral(context, {
        text:
          error instanceof InputError
            ? error.message
            : "버그 제보 접수를 확인하지 못했어요. 운영자에게 문의해 주세요.",
      });
    }),
  );
  return new Response(null, { status: 200 });
}

export async function handleBugAction(
  id: string,
  bugAnswerAction: BugAnswerAction | null,
  context: CommunityContext,
  key: string,
  value: Record<string, unknown>,
  triggerId: unknown,
  waitUntil: WaitUntil,
): Promise<Response | null> {
  if (id === "community_feedback_admin_start") {
    await startCodexFeedback(context, {
      feedbackId: string(value.feedbackId),
      publicAlias: string(value.publicAlias),
      sourceChannel: string(value.sourceChannel),
      sourceThread: string(value.sourceThread),
    });
    return new Response(null, { status: 200 });
  }
  if (id === "community_bug_open") {
    await openBugReportModal(context, string(triggerId));
    return new Response(null, { status: 200 });
  }
  if (id === "community_bug_confirm") {
    const revision = value.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
      throw new InputError("버그 제보 버전을 확인할 수 없어요.");
    waitUntil(
      confirmBugReport(context, key, revision).catch(async (error: unknown) => {
        await ephemeral(context, {
          text:
            error instanceof InputError
              ? error.message
              : "버그 제보 확인을 완료하지 못했어요. 최신 초안을 다시 확인해 주세요.",
        });
      }),
    );
    return new Response(null, { status: 200 });
  }
  if (!bugAnswerAction) return null;
  const answer = string(value.answer).trim();
  const questionId = string(value.questionId);
  if (!answer || !questionId) throw new InputError("버그 제보 답변을 확인할 수 없어요.");
  waitUntil(
    (async () => {
      try {
        const handled = await continueBugReport(context, answer, questionId);
        if (!handled) throw new InputError("이 질문과 연결된 버그 제보를 찾지 못했어요.");
      } catch (error: unknown) {
        await ephemeral(context, {
          text:
            error instanceof InputError
              ? error.message
              : "버그 제보 답변을 저장하지 못했어요. 같은 스레드에서 다시 알려주세요.",
        });
      }
    })(),
  );
  return new Response(null, { status: 200 });
}
