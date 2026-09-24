import type { ParsedBugReport } from "./community-bug-facts";
import { digestBugText } from "./community-bug-private";
import { escapeSlackText } from "./community-messages";
import type { CommunityContext } from "./community-runtime";
import { callSlack } from "./community-social";
import { InputError, list, object, string } from "./input";

function feedbackIntakeRef(context: CommunityContext): string {
  return `slack-feedback:${context.scope.teamId}:${context.scope.userId}:${context.key}`;
}

export async function feedbackBugIdentity(context: CommunityContext): Promise<{
  readonly bugId: string;
  readonly sourceOpaqueRef: string;
}> {
  const sourceOpaqueRef = feedbackIntakeRef(context);
  const digest = await digestBugText(sourceOpaqueRef);
  return { bugId: `BUG-${digest.slice(0, 20).toUpperCase()}`, sourceOpaqueRef };
}

function field(parsed: ParsedBugReport, id: string): string {
  return parsed.messages.find((message) => message.id === id)?.text.trim() ?? "";
}

function sourceUrl(context: CommunityContext): string {
  const { teamId, channelId } = context.scope;
  return `https://app.slack.com/client/${teamId}/${channelId}/thread/${channelId}-${context.thread}`;
}

async function existingFeedbackThread(
  context: CommunityContext,
  channelId: string,
  bugId: string,
): Promise<string | null> {
  const history = await callSlack(context.env.SLACK_BOT_TOKEN, "conversations.history", {
    channel: channelId,
    limit: 200,
  });
  for (const value of list(history.messages)) {
    const message = object(value);
    if (
      message.thread_ts === undefined &&
      typeof message.text === "string" &&
      message.text.includes(`버그 키: ${bugId}`)
    )
      return string(message.ts);
  }
  return null;
}

export async function canonicalFeedbackContext(
  context: CommunityContext,
  parsed: ParsedBugReport,
  bugId: string,
): Promise<CommunityContext> {
  const channelId = context.env.COMMUNITY_FEEDBACK_CHANNEL_ID;
  if (!channelId) throw new InputError("피드백 채널을 확인해 주세요.");
  const existing = await existingFeedbackThread(context, channelId, bugId);
  const actual = field(parsed, "form:actual") || parsed.messages[0]?.text.trim() || "피드백";
  const expected = field(parsed, "form:expected");
  const text = `<@${context.scope.userId}> 님이 피드백을 남겼어요.\n\n*내용*\n${escapeSlackText(actual)}${expected ? `\n\n*바라는 변화*\n${escapeSlackText(expected)}` : ""}\n\n<${sourceUrl(context)}|처음 남긴 위치>\n버그 키: ${bugId}`;
  const thread =
    existing ??
    string(
      (
        await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
          channel: channelId,
          text,
          unfurl_links: false,
          unfurl_media: false,
        })
      ).ts,
    );
  return {
    ...context,
    scope: { ...context.scope, channelId },
    source: thread,
    thread,
  };
}
