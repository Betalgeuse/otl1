import type { ClockBinding } from "./community-bug-clock-client";
import { callSlack } from "./community-social";
import type { CommunityStore } from "./community-store";
import type { CommunityScope } from "./community-types";
import { InputError, type Json, object, string } from "./input";
import type { IntentAI } from "./intent";

export type CommunityEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly SLACK_BOT_TOKEN: string;
  readonly DATABASE_URL: string;
  readonly BOARD_SIGNING_SECRET: string;
  readonly PUBLIC_BASE_URL: string;
  readonly COMMUNITY_ENABLED?: string;
  readonly COMMUNITY_BOT_USER_ID?: string;
  readonly DATABASE_MAINTENANCE?: string;
  readonly COMMUNITY_CLOCK?: ClockBinding;
  readonly COMMUNITY_CHANNEL_ID?: string;
  readonly COMMUNITY_ADMIN_ID?: string;
  readonly COMMUNITY_PUBLIC_CHANNEL_ID?: string;
  readonly COMMUNITY_FEEDBACK_CHANNEL_ID?: string;
  readonly COMMUNITY_RELEASE_CHANNEL_ID?: string;
  readonly COMMUNITY_WELCOME_CHANNEL_ID?: string;
  readonly COMMUNITY_INTRO_CHANNEL_ID?: string;
  readonly COMMUNITY_GUIDE_SOURCE_TS?: string;
  readonly AI?: IntentAI;
  readonly INTENT_RATE_LIMITER?: {
    limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
  readonly BUG_PRIVATE_KEK?: string;
  readonly BUG_PRIVATE_KEK_VERSION?: string;
  readonly BUG_PRIVATE_OBJECTS?: {
    put(key: string, value: ArrayBuffer): Promise<unknown>;
    get?(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
    delete(key: string): Promise<void>;
  };
};
export type CommunityContext = {
  readonly env: CommunityEnv;
  readonly store: CommunityStore;
  readonly scope: CommunityScope;
  readonly date: string;
  readonly thread: string;
  readonly source: string;
  readonly key: string;
  readonly bugTextEntryState?: "missing" | "active" | "expired" | "consumed";
};
export function scopedValue(scope: CommunityScope, key: string): string {
  return JSON.stringify({ ownerId: scope.userId, key });
}
export function actionIdentity(data: Record<string, unknown>, env: CommunityEnv, actionId = "") {
  const teamId = string(object(data.team).id);
  const userId = string(object(data.user).id);
  const channelId = data.container
    ? string(object(data.container).channel_id)
    : string(object(JSON.parse(string(object(data.view).private_metadata))).channelId);
  const bugAction = [
    "community_bug_open",
    "community_bug_submit",
    "community_bug_confirm",
    "community_bug_answer",
  ].includes(actionId);
  const introductionAction = [
    "community_introduction",
    "community_introduction_submit",
    "community_introduction_directory",
  ].includes(actionId);
  const expandedChannelAllowed =
    (bugAction &&
      [
        env.COMMUNITY_RELEASE_CHANNEL_ID,
        env.COMMUNITY_INTRO_CHANNEL_ID,
        env.COMMUNITY_FEEDBACK_CHANNEL_ID,
      ].includes(channelId)) ||
    (introductionAction &&
      [env.COMMUNITY_RELEASE_CHANNEL_ID, env.COMMUNITY_INTRO_CHANNEL_ID].includes(channelId));
  const feedbackActionDenied = channelId === env.COMMUNITY_FEEDBACK_CHANNEL_ID && !bugAction;
  if (
    teamId !== env.SLACK_TEAM_ID ||
    feedbackActionDenied ||
    (![env.COMMUNITY_CHANNEL_ID, env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(channelId) &&
      !expandedChannelAllowed) ||
    (channelId === env.COMMUNITY_CHANNEL_ID && userId !== env.COMMUNITY_ADMIN_ID) ||
    !/^[UW][A-Z0-9]+$/.test(userId)
  )
    throw new InputError("이 동작은 사용할 수 없습니다.");
  return { teamId, channelId, userId };
}
export async function post(context: CommunityContext, message: Json): Promise<string> {
  const payload = payloadRecord(message);
  const result = await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
    ...payload,
    channel: context.scope.channelId,
    thread_ts: context.thread,
  });
  return string(result.ts);
}
export async function textReply(context: CommunityContext, text: string): Promise<void> {
  await post(context, { text });
}

export async function ephemeral(context: CommunityContext, message: Json): Promise<string> {
  const result = await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postEphemeral", {
    ...payloadRecord(message),
    channel: context.scope.channelId,
    user: context.scope.userId,
  });
  return string(result.message_ts);
}

export function payloadRecord(value: Json): { readonly [key: string]: Json } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InputError("메시지 형식이 올바르지 않습니다.");
  return Object.fromEntries(Object.entries(value));
}
