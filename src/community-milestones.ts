import { customBotEmoji } from "./community-emoji";
import { shoutoutSuggestionMessage } from "./community-messages";
import { type CommunityContext, post, scopedValue } from "./community-runtime";
import { callSlack } from "./community-social";
import type { ChangeResult } from "./community-types";
import { object, string } from "./input";

export async function emitMilestones(
  context: CommunityContext,
  result: ChangeResult,
): Promise<void> {
  if (!result.firstGoal && !result.firstReflection) return;
  const boundary = await context.store.getRecord({ ...context.scope, key: "history-boundary" });
  const old = boundary ? object(boundary.body) : null;
  if (
    old &&
    ((result.firstGoal && old.firstGoalKnown === false) ||
      (result.firstReflection && old.firstReflectionKnown === false))
  )
    return;
  const label = [
    result.firstGoal ? "첫 원씽 완료" : null,
    result.firstReflection ? "첫 후기" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  const key = `milestone:${result.undoKey}`;
  await context.store.putRecord({
    ...context.scope,
    key,
    kind: "milestone",
    body: { source: context.source, date: context.date, label },
  });
  const ts = await post(
    context,
    shoutoutSuggestionMessage({
      userId: context.scope.userId,
      text: await customBotEmoji(
        context.env.SLACK_BOT_TOKEN,
        `${context.scope.channelId === context.env.COMMUNITY_CHANNEL_ID ? "이 테스트 공간 " : ""}${label}!!!! 같이 박수!!! 🐧🎉\n동료에게도 원씽 응원 한마디 보내볼까요?`,
      ),
      value: scopedValue(context.scope, key),
    }),
  );
  await context.store.putRecord({
    ...context.scope,
    key: `milestone-message:${result.undoKey}`,
    kind: "milestone_message",
    body: { ts, label },
  });
}
export async function correctMilestone(context: CommunityContext, key: string): Promise<void> {
  const record = await context.store.getRecord({
    ...context.scope,
    key: `milestone-message:${key}`,
  });
  if (!record) return;
  const data = object(record.body);
  await callSlack(context.env.SLACK_BOT_TOKEN, "chat.update", {
    channel: context.scope.channelId,
    ts: string(data.ts),
    text: "이 기록은 작성자가 되돌렸어요. 첫 달성 축하도 정정합니다.",
    blocks: [],
  });
}
