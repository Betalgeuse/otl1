import { parseGuideFileIds, type WelcomeGuideContent } from "./community-guide-content";
import { welcomeGuideLink } from "./community-guide-surface";
import type { CommunityEnv } from "./community-runtime";
import { callSlack } from "./community-social";
import { InputError, list, object, string } from "./input";
import { NeonStore } from "./store";

export {
  executeWelcomeGuideCommand,
  inspectWelcomeGuideSource,
  publishWelcomeGuide,
} from "./community-guide-publish";

const GUIDE_VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

type PublishedGuide = WelcomeGuideContent & {
  readonly version: string;
};

type GuideDeliveryEnv = Pick<
  CommunityEnv,
  | "SLACK_TEAM_ID"
  | "SLACK_BOT_TOKEN"
  | "GUIDE_DATABASE_URL"
  | "COMMUNITY_WELCOME_CHANNEL_ID"
  | "COMMUNITY_BOT_USER_ID"
  | "COMMUNITY_GUIDE_CANVAS_ID"
  | "COMMUNITY_GUIDE_CANVAS_URL"
  | "COMMUNITY_GUIDE_ANCHOR_TS"
> & {
  readonly GUIDE_ADMIN_DATABASE_URL?: string;
};

export type WelcomeGuideRepairEnv = Omit<GuideDeliveryEnv, "GUIDE_ADMIN_DATABASE_URL"> & {
  readonly GUIDE_ADMIN_DATABASE_URL: string;
};

export type WelcomeGuideDelivery = {
  readonly delivered: boolean;
  readonly version: string;
  readonly contentHash: string;
  readonly messageTs?: string;
};

function publishedGuide(value: unknown): PublishedGuide {
  const row = object(value);
  const ids = list(row.orderedFileIds).map(string);
  const first = ids[0];
  const second = ids[1];
  if (!first || !second || ids.length !== 2)
    throw new InputError("발행된 환영 안내 이미지를 확인해 주세요.");
  const version = string(row.version);
  const hash = string(row.hash);
  if (!GUIDE_VERSION.test(version) || !/^[0-9a-f]{64}$/.test(hash))
    throw new InputError("발행된 환영 안내 버전을 확인해 주세요.");
  return {
    version,
    hash,
    body: string(row.body),
    orderedFileIds: parseGuideFileIds(`${first},${second}`),
  };
}

async function isDeliverableMember(userId: string, env: GuideDeliveryEnv): Promise<boolean> {
  const profile = object(
    (await callSlack(env.SLACK_BOT_TOKEN, "users.info", { user: userId })).user,
  );
  return (
    profile.id === userId &&
    profile.is_bot === false &&
    profile.is_app_user !== true &&
    profile.deleted !== true
  );
}

async function deliverPublishedGuide(
  userId: string,
  reason: "join" | "targeted_repair",
  env: GuideDeliveryEnv,
): Promise<WelcomeGuideDelivery> {
  const channelId = env.COMMUNITY_WELCOME_CHANNEL_ID;
  const botUserId = env.COMMUNITY_BOT_USER_ID;
  if (!channelId) throw new InputError("환영 안내 채널 설정이 필요합니다.");
  if (!botUserId || !/^U[A-Z0-9]+$/.test(botUserId))
    throw new InputError("OT1L 봇 게시자 설정이 필요합니다.");
  const admin = reason === "targeted_repair";
  const connectionString = admin ? env.GUIDE_ADMIN_DATABASE_URL : env.GUIDE_DATABASE_URL;
  if (!connectionString)
    throw new InputError(
      admin ? "환영 안내 관리자 DB 설정이 필요합니다." : "환영 안내 DB 설정이 필요합니다.",
    );
  const store = new NeonStore(connectionString);
  const executeFunction = admin ? "otl.guide_admin_execute" : "otl.guide_runtime_execute";
  const latestOperation = admin ? "repair_latest" : "latest";
  const claimOperation = admin ? "repair_claim" : "claim";
  const finishOperation = admin ? "repair_finish" : "finish";
  const scope = { teamId: env.SLACK_TEAM_ID, channelId, userId };
  const guide = publishedGuide(
    await store.queryJson(`SELECT ${executeFunction}($1,$2::jsonb)`, [
      latestOperation,
      JSON.stringify(scope),
    ]),
  );
  const identity = { ...scope, version: guide.version, hash: guide.hash, reason };
  const claimed = await store.queryJson(`SELECT ${executeFunction}($1,$2::jsonb)`, [
    claimOperation,
    JSON.stringify(identity),
  ]);
  if (claimed !== true)
    return { delivered: false, version: guide.version, contentHash: guide.hash };
  let sent: Record<string, unknown>;
  try {
    const message = welcomeGuideLink(userId, env);
    sent = await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: channelId,
      ...message,
      unfurl_links: false,
      unfurl_media: false,
    });
    const sentMessage = object(sent.message);
    if (sentMessage.user !== botUserId || typeof sentMessage.bot_id !== "string")
      throw new InputError("OT1L 봇 게시자를 확인하지 못했습니다.");
  } catch (error) {
    await store.queryJson(`SELECT ${executeFunction}($1,$2::jsonb)`, [
      finishOperation,
      JSON.stringify({ ...identity, status: "failed" }),
    ]);
    throw error;
  }
  const messageTs = string(sent.ts);
  const finished = await store.queryJson(`SELECT ${executeFunction}($1,$2::jsonb)`, [
    finishOperation,
    JSON.stringify({ ...identity, status: "sent", messageTs }),
  ]);
  if (finished !== true) throw new InputError("환영 안내 전달 상태를 확정하지 못했습니다.");
  return { delivered: true, version: guide.version, contentHash: guide.hash, messageTs };
}

export async function replaceWelcomeGuideForUser(
  userId: string,
  env: WelcomeGuideRepairEnv,
): Promise<WelcomeGuideDelivery> {
  if (!/^[UW][A-Z0-9]+$/.test(userId)) throw new InputError("환영 안내 대상 회원을 확인해 주세요.");
  if (!(await isDeliverableMember(userId, env)))
    throw new InputError("환영 안내 대상 회원을 확인할 수 없습니다.");
  return deliverPublishedGuide(userId, "targeted_repair", env);
}

export async function deliverWelcomeGuide(
  event: Record<string, unknown>,
  env: CommunityEnv,
): Promise<boolean> {
  if (
    event.type !== "member_joined_channel" &&
    !(event.type === "message" && event.subtype === "channel_join")
  )
    return false;
  if (!env.COMMUNITY_WELCOME_CHANNEL_ID || event.channel !== env.COMMUNITY_WELCOME_CHANNEL_ID)
    return false;
  const userId = string(event.user);
  if (!/^[UW][A-Z0-9]+$/.test(userId) || event.bot_id) return true;
  if (!(await isDeliverableMember(userId, env))) return true;
  await deliverPublishedGuide(userId, "join", env);
  return true;
}
