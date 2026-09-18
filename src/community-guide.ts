import {
  guideBlocks,
  parseGuideFileIds,
  type WelcomeGuideContent,
} from "./community-guide-content";
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

async function isDeliverableMember(userId: string, env: CommunityEnv): Promise<boolean> {
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
  env: CommunityEnv,
): Promise<WelcomeGuideDelivery> {
  const channelId = env.COMMUNITY_WELCOME_CHANNEL_ID;
  const botUserId = env.COMMUNITY_BOT_USER_ID;
  if (!channelId) throw new InputError("환영 안내 채널 설정이 필요합니다.");
  if (!botUserId || !/^U[A-Z0-9]+$/.test(botUserId))
    throw new InputError("OT1L 봇 게시자 설정이 필요합니다.");
  const store = new NeonStore(env.DATABASE_URL);
  const scope = { teamId: env.SLACK_TEAM_ID, channelId, userId };
  const guide = publishedGuide(
    await store.queryJson("SELECT otl.guide_execute($1,$2::jsonb)", [
      "latest",
      JSON.stringify(scope),
    ]),
  );
  const identity = { ...scope, version: guide.version, hash: guide.hash, reason };
  const claimed = await store.queryJson("SELECT otl.guide_execute($1,$2::jsonb)", [
    "claim",
    JSON.stringify(identity),
  ]);
  if (claimed !== true)
    return { delivered: false, version: guide.version, contentHash: guide.hash };
  let sent: Record<string, unknown>;
  try {
    sent = await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: channelId,
      text: `<@${userId}> 어서 오세요!!! 처음 오셨다면 이 안내부터 함께 읽어주세요.\n\n${guide.body}`,
      blocks: guideBlocks(userId, guide),
      unfurl_links: false,
      unfurl_media: false,
    });
    const sentMessage = object(sent.message);
    if (sentMessage.user !== botUserId || typeof sentMessage.bot_id !== "string")
      throw new InputError("OT1L 봇 게시자를 확인하지 못했습니다.");
  } catch (error) {
    await store.queryJson("SELECT otl.guide_execute($1,$2::jsonb)", [
      "finish",
      JSON.stringify({ ...identity, status: "failed" }),
    ]);
    throw error;
  }
  const messageTs = string(sent.ts);
  const finished = await store.queryJson("SELECT otl.guide_execute($1,$2::jsonb)", [
    "finish",
    JSON.stringify({ ...identity, status: "sent", messageTs }),
  ]);
  if (finished !== true) throw new InputError("환영 안내 전달 상태를 확정하지 못했습니다.");
  return { delivered: true, version: guide.version, contentHash: guide.hash, messageTs };
}

export async function replaceWelcomeGuideForUser(
  userId: string,
  env: CommunityEnv,
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
