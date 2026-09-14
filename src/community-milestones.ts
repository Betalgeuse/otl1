import { customBotEmoji, randomCustomEmoji } from "./community-emoji";
import { escapeSlackText } from "./community-messages";
import type { CommunityContext } from "./community-runtime";
import { addReactions, callSlack } from "./community-social";
import type { ChangeResult } from "./community-types";
import { object, string } from "./input";

export async function emitMilestones(
  context: CommunityContext,
  result: ChangeResult,
): Promise<void> {
  const target =
    context.scope.channelId === context.env.COMMUNITY_CHANNEL_ID
      ? context.scope.channelId
      : context.scope.channelId === context.env.COMMUNITY_PUBLIC_CHANNEL_ID
        ? context.env.COMMUNITY_RELEASE_CHANNEL_ID
        : undefined;
  if (!target) return;
  const old = await context.store.getRecord({ ...context.scope, key: "history-boundary" });
  const boundary = old ? object(old.body) : {};
  const milestones = [
    {
      kind: "first_registration",
      enabled: result.firstRegistration === true,
      label: "첫 *ONE THING* 등록",
      detail: result.day.goal,
    },
    {
      kind: "first_goal",
      enabled: result.firstGoal && boundary.firstGoalKnown !== false,
      label: "첫 *ONE THING* 완료",
      detail: result.day.goal,
    },
    {
      kind: "first_reflection",
      enabled: result.firstReflection && boundary.firstReflectionKnown !== false,
      label: "첫 후기",
      detail: result.day.reflection,
    },
  ].filter((item) => item.enabled);
  for (const milestone of milestones) {
    const scope = { ...context.scope, channelId: target, key: `auto-milestone:${milestone.kind}` };
    await context.store.putRecord({
      ...scope,
      kind: "milestone_dispatch",
      body: {
        sourceChannel: context.scope.channelId,
        source: context.source,
        date: result.day.date,
        undoKey: result.undoKey,
        kind: milestone.kind,
      },
    });
    if (!(await context.store.claimRecord(scope))) continue;
    const header = await customBotEmoji(
      context.env.SLACK_BOT_TOKEN,
      `<@${context.scope.userId}>님의 ${milestone.label}!!!! 🎉🐧`,
    );
    const footer = await customBotEmoji(
      context.env.SLACK_BOT_TOKEN,
      "첫걸음 같이 축하해 주세요!!! 🙌",
    );
    const text = `${header}\n${escapeSlackText(milestone.detail)}\n${footer}`;
    const response = await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: target,
      text,
      unfurl_links: false,
    });
    const ts = string(response.ts);
    await context.store.putRecord({
      ...context.scope,
      key: `milestone-message:${result.undoKey}:${milestone.kind}`,
      kind: "milestone_message",
      body: { channel: target, ts, label: milestone.label, undoKey: result.undoKey },
    });
    await context.store.finishRecord(scope, "sent");
    try {
      await addReactions(context.env.SLACK_BOT_TOKEN, {
        channel: target,
        ts,
        names: await randomCustomEmoji(context.env.SLACK_BOT_TOKEN),
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "milestone.reaction.failed",
          type: error instanceof Error ? error.name : "Unknown",
        }),
      );
    }
  }
}

export async function correctMilestone(context: CommunityContext, key: string): Promise<void> {
  const records = await context.store.listRecords(context.scope, "milestone_message");
  for (const record of records) {
    const data = object(record.body);
    if (record.key !== `milestone-message:${key}` && data.undoKey !== key) continue;
    await callSlack(context.env.SLACK_BOT_TOKEN, "chat.update", {
      channel: typeof data.channel === "string" ? data.channel : context.scope.channelId,
      ts: string(data.ts),
      text: "이 기록은 작성자가 되돌렸어요. 첫 기록 축하도 정정합니다.",
      blocks: [],
    });
  }
}
