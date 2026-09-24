import { object, string } from "./input";

export function communityEditRelevant(
  editTs: unknown,
  isFeedbackThread: boolean,
  text: string,
): boolean {
  return editTs === undefined || isFeedbackThread || /후기|회고|수정|정정|변경/.test(text);
}

export function messageEvent(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.type !== "message" || raw.subtype !== "message_changed") return raw;
  const message = object(raw.message);
  if (message.bot_id || message.subtype) return raw;
  const edited = message.edited ? object(message.edited) : null;
  const changedAt = string(edited?.ts ?? raw.event_ts ?? raw.ts);
  return {
    ...message,
    channel: raw.channel,
    type: "message",
    subtype: undefined,
    edit_ts: changedAt,
    thread_ts: message.thread_ts ?? message.ts,
  };
}
