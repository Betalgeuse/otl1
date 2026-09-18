import { correctMilestone } from "./community-milestones";
import type { CommunityContext } from "./community-runtime";
import { textReply } from "./community-runtime";
import { removeReactions } from "./community-social";
import type { CommunityDay } from "./community-types";
import { object, string } from "./input";

export async function undoChange(context: CommunityContext, key: string): Promise<void> {
  const record = await context.store.getRecord({ ...context.scope, key });
  if (record?.kind !== "undo") {
    await textReply(context, "되돌릴 기록을 찾지 못했어요.");
    return;
  }
  const data = object(record.body);
  const undoKey = string(data.undoKey);
  const result = await context.store.change({
    ...context.scope,
    date: string(data.date),
    key: context.key,
    action: "undo",
    syncLegacy: context.scope.channelId === context.env.COMMUNITY_PUBLIC_CHANNEL_ID,
    undoKey,
    delivery: { source: context.source, thread: context.thread, undoKey: null },
  });
  if (result.conflict) {
    await textReply(context, "그 뒤에 기록이 바뀌어 이 변경은 되돌릴 수 없어요.");
    return;
  }
  if (!result.changed) {
    await textReply(context, "이미 되돌린 기록이에요.");
    return;
  }
  const names = Array.isArray(data.names)
    ? data.names.filter((name): name is string => typeof name === "string")
    : [];
  await removeReactions(context.env.SLACK_BOT_TOKEN, {
    channel: context.scope.channelId,
    ts: string(data.source),
    names,
  });
  await publishStatus(context, result.day, null, result.gardenDeliveryKey);
  await correctMilestone(context, undoKey);
  await textReply(context, "방금 변경을 되돌렸어요. ↩️");
}

export async function publishStatus(
  context: CommunityContext,
  day: CommunityDay,
  undoKey: string | null,
  deliveryKey?: string,
): Promise<string> {
  if (!context.env.COMMUNITY_CLOCK) throw new Error("Garden coordinator unavailable");
  return context.env.COMMUNITY_CLOCK.getByName(
    `${context.scope.teamId}:${context.scope.channelId}`,
  ).publishGarden({
    userId: context.scope.userId,
    channelId: context.scope.channelId,
    date: day.date,
    source: context.source,
    thread: context.thread,
    key: context.key,
    undoKey,
    ...(deliveryKey ? { deliveryKey } : {}),
  });
}
