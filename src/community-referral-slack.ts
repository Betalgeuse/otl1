import { handleInviteAdminAction, type InviteAdminEnv } from "./community-invite-admin";
import { handleReferralTeamJoin, type ReferralJoinEnv } from "./community-referral-join";
import { handleReferralLinkMessage, type ReferralLinkEnv } from "./community-referral-link";
import type { ReferralRuntimeStore, ReferralSlackPort } from "./community-referral-types";
import { callSlack } from "./community-social";
import { InputError, object, string } from "./input";
import { verifySlack } from "./signing";

export type ReferralSlackEnv = InviteAdminEnv &
  ReferralJoinEnv &
  ReferralLinkEnv & {
    readonly SLACK_SIGNING_SECRET: string;
    readonly SLACK_BOT_TOKEN: string;
  };

function uuidFromHex(hex: string): string {
  const padded = hex.padEnd(32, "0").slice(0, 32);
  return `${padded.slice(0, 8)}-${padded.slice(8, 12)}-4${padded.slice(13, 16)}-8${padded.slice(17, 20)}-${padded.slice(20)}`;
}

async function effectUuid(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return uuidFromHex(hex);
}

export function referralSlackPort(
  env: Pick<ReferralSlackEnv, "SLACK_BOT_TOKEN">,
): ReferralSlackPort {
  return {
    async postEphemeral(input) {
      const result = await callSlack(env.SLACK_BOT_TOKEN, "chat.postEphemeral", {
        channel: input.channelId,
        user: input.userId,
        text: input.text,
      });
      return string(result.message_ts);
    },
    async postAdmin(input) {
      const result = await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
        channel: input.adminId,
        text: input.text,
        blocks: input.blocks,
        client_msg_id: await effectUuid(input.effectKey),
      });
      return string(result.ts);
    },
    async postJoinIntroduction(input) {
      const opened = object(
        await callSlack(env.SLACK_BOT_TOKEN, "conversations.open", { users: input.userId }),
      );
      const channelId = string(object(opened.channel).id);
      const result = await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
        channel: channelId,
        text: input.text,
        blocks: input.blocks,
        client_msg_id: await effectUuid(input.effectKey),
      });
      return string(result.ts);
    },
    async person(userId) {
      const result = object(
        (await callSlack(env.SLACK_BOT_TOKEN, "users.info", { user: userId })).user,
      );
      const profile = object(result.profile);
      return {
        id: string(result.id),
        teamId: string(result.team_id),
        email: string(profile.email),
        isBot: result.is_bot === true,
        isApp: result.is_app_user === true,
        deleted: result.deleted === true,
      };
    },
  };
}

async function routeEvent(
  data: Record<string, unknown>,
  env: ReferralSlackEnv,
  store: ReferralRuntimeStore,
  slack: ReferralSlackPort,
): Promise<boolean> {
  if (data.type !== "event_callback" || data.team_id !== env.SLACK_TEAM_ID) return false;
  const event = object(data.event);
  if (event.type === "team_join") {
    const user = object(event.user);
    return handleReferralTeamJoin(
      {
        teamId: env.SLACK_TEAM_ID,
        eventId: string(data.event_id),
        userId: string(user.id),
      },
      env,
      store,
      slack,
    );
  }
  if (event.type !== "message" || event.subtype !== undefined || event.bot_id !== undefined)
    return false;
  return handleReferralLinkMessage(
    {
      teamId: env.SLACK_TEAM_ID,
      channelId: string(event.channel),
      userId: string(event.user),
      text: string(event.text),
    },
    env,
    store,
    slack,
  );
}

async function routeInteraction(
  data: Record<string, unknown>,
  env: ReferralSlackEnv,
  store: ReferralRuntimeStore,
  slack: ReferralSlackPort,
): Promise<boolean> {
  if (data.type !== "block_actions") return false;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const first = actions[0];
  if (!first) return false;
  const action = object(first);
  return handleInviteAdminAction(
    {
      teamId: string(object(data.team).id),
      userId: string(object(data.user).id),
      actionId: string(action.action_id),
      value: string(action.value),
      actionTs: string(action.action_ts),
    },
    env,
    store,
    slack,
  );
}

export async function handleReferralSlackRequest(
  request: Request,
  env: ReferralSlackEnv,
  store: ReferralRuntimeStore,
  slack: ReferralSlackPort = referralSlackPort(env),
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !["/slack/events", "/slack/interactions"].includes(path))
    return new Response("Not found", { status: 404 });
  const body = await request.text();
  if ((await verifySlack(request, body, env.SLACK_SIGNING_SECRET)) === null)
    return new Response("Unauthorized", { status: 401 });
  try {
    if (path === "/slack/events") {
      const handled = await routeEvent(object(JSON.parse(body)), env, store, slack);
      return new Response(null, { status: handled ? 200 : 204 });
    }
    const raw = new URLSearchParams(body).get("payload");
    if (!raw) throw new InputError("지원하지 않는 요청 형식입니다.");
    const handled = await routeInteraction(object(JSON.parse(raw)), env, store, slack);
    return new Response(null, { status: handled ? 200 : 204 });
  } catch (error) {
    if (error instanceof InputError || error instanceof SyntaxError)
      return Response.json({ response_type: "ephemeral", text: error.message }, { status: 200 });
    throw error;
  }
}
