import type { BugDelivery, BugDeliveryDestination } from "./community-bug-delivery-store";
import type { CommunityContext } from "./community-runtime";
import { payloadRecord } from "./community-runtime";
import { callSlack } from "./community-social";
import type { Json } from "./input";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function isBotMessage(value: Record<string, unknown>, context: CommunityContext): boolean {
  if (context.env.COMMUNITY_BOT_USER_ID) return value.user === context.env.COMMUNITY_BOT_USER_ID;
  return typeof value.bot_id === "string" || value.subtype === "bot_message";
}

function exactRenderedPayload(
  value: Record<string, unknown>,
  message: Json,
  bugId: string,
): boolean {
  const expected = payloadRecord(message);
  if (!canonical(expected).includes(bugId)) return false;
  return Object.entries(expected).every(([key, item]) => canonical(value[key]) === canonical(item));
}

async function history(
  context: CommunityContext,
  destination: Exclude<BugDeliveryDestination, "reporter_ephemeral">,
): Promise<readonly Record<string, unknown>[]> {
  const channel =
    destination === "reporter_thread" ? context.scope.channelId : context.env.COMMUNITY_CHANNEL_ID;
  if (!channel) return [];
  const result = await callSlack(
    context.env.SLACK_BOT_TOKEN,
    destination === "reporter_thread" ? "conversations.replies" : "conversations.history",
    destination === "reporter_thread"
      ? { channel, ts: context.thread, limit: 100 }
      : { channel, limit: 50 },
  );
  const messages = result.messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export async function reconcileAcceptedBugDelivery(
  context: CommunityContext,
  delivery: BugDelivery,
  message: Json,
): Promise<string | null> {
  if (delivery.attempts <= 1 || delivery.destination === "reporter_ephemeral") return null;
  const messages = await history(context, delivery.destination);
  const match = messages.find(
    (item) => isBotMessage(item, context) && exactRenderedPayload(item, message, delivery.bugId),
  );
  return typeof match?.ts === "string" ? match.ts : null;
}
