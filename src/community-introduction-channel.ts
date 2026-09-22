import { introductionActionBlock, introductionLine } from "./community-introduction";
import { type CommunityContext, type CommunityEnv, ephemeral } from "./community-runtime";
import { callSlack } from "./community-social";
import { CommunityStore } from "./community-store";
import { koreaDate, list, object, string } from "./input";
import { NeonStore } from "./store";

function isJoin(event: Record<string, unknown>): boolean {
  return (
    event.type === "member_joined_channel" ||
    (event.type === "message" && event.subtype === "channel_join")
  );
}

async function humanMember(userId: string, env: CommunityEnv): Promise<boolean> {
  if (!/^[UW][A-Z0-9]+$/.test(userId) || userId === env.COMMUNITY_BOT_USER_ID) return false;
  const user = object((await callSlack(env.SLACK_BOT_TOKEN, "users.info", { user: userId })).user);
  return (
    user.id === userId &&
    user.is_bot === false &&
    user.is_app_user !== true &&
    user.deleted !== true
  );
}

export async function welcomeIntroductionMember(
  event: Record<string, unknown>,
  env: CommunityEnv,
): Promise<boolean> {
  if (!isJoin(event) || !env.COMMUNITY_INTRO_CHANNEL_ID) return false;
  const channelId = string(event.channel);
  if (channelId !== env.COMMUNITY_INTRO_CHANNEL_ID) return false;
  const userId = string(event.user);
  if (event.bot_id || !(await humanMember(userId, env))) return true;
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  const scope = {
    teamId: env.SLACK_TEAM_ID,
    channelId,
    userId,
    key: "introduction-channel-welcome",
  };
  await store.putRecord({
    ...scope,
    kind: "introduction_welcome",
    body: { source: string(event.ts ?? event.event_ts ?? "") },
  });
  if (!(await store.claimRecord(scope))) return true;
  const existing = await store.introduction(env.SLACK_TEAM_ID, userId);
  const text = existing
    ? `<@${userId}> 자기소개 채널에 오신 걸 환영해요! 기존 소개를 확인하거나 수정할 수 있어요.`
    : `<@${userId}> 자기소개 채널에 오신 걸 환영해요! 아직 소개가 없어요. 180자 안에서 알려주세요.`;
  try {
    await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: channelId,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }, introductionActionBlock()],
      unfurl_links: false,
    });
    await store.finishRecord(scope, "sent");
  } catch (error) {
    await store.finishRecord(scope, "failed");
    throw error;
  }
  return true;
}

function chunks(lines: readonly string[]): readonly string[] {
  const result: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > 2800) {
      result.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line}`;
  }
  if (current) result.push(current);
  return result;
}

export async function showIntroductionDirectory(context: CommunityContext): Promise<void> {
  const introductions = await context.store.introductions(context.scope.teamId);
  if (!introductions.length) {
    await ephemeral(context, {
      text: "아직 등록된 자기소개가 없어요.",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "아직 등록된 자기소개가 없어요." } },
        introductionActionBlock(),
      ],
    });
    return;
  }
  const pages = chunks(introductions.map(introductionLine));
  for (const [index, page] of pages.entries())
    await ephemeral(context, {
      text: `*우리의 자기소개${pages.length > 1 ? ` ${index + 1}/${pages.length}` : ""}*\n${page}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*우리의 자기소개${pages.length > 1 ? ` ${index + 1}/${pages.length}` : ""}*\n${page}`,
          },
        },
        introductionActionBlock(),
      ],
      unfurl_links: false,
    });
}

async function channelMemberIds(env: CommunityEnv): Promise<readonly string[]> {
  const result: string[] = [];
  let cursor = "";
  do {
    const page = await callSlack(env.SLACK_BOT_TOKEN, "conversations.members", {
      channel: string(env.COMMUNITY_INTRO_CHANNEL_ID),
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    result.push(...list(page.members).map(string));
    cursor = string(object(page.response_metadata ?? {}).next_cursor ?? "");
  } while (cursor);
  return result;
}

export async function remindMissingIntroductions(context: CommunityContext): Promise<void> {
  if (context.scope.userId !== context.env.COMMUNITY_ADMIN_ID) {
    await ephemeral(context, { text: "미작성자 안내는 운영자만 보낼 수 있어요." });
    return;
  }
  const introduced = new Set(
    (await context.store.introductions(context.scope.teamId)).map((entry) => entry.userId),
  );
  const missing: string[] = [];
  for (const userId of await channelMemberIds(context.env))
    if (!introduced.has(userId) && (await humanMember(userId, context.env))) missing.push(userId);
  if (!missing.length) {
    await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: context.scope.channelId,
      text: "모두 자기소개를 남겼어요! 🙌",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "모두 자기소개를 남겼어요! 🙌" } },
        introductionActionBlock(),
      ],
    });
    return;
  }
  for (const page of chunks(missing.map((userId) => `<@${userId}>`)))
    await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: context.scope.channelId,
      text: `${page}\n아직 자기소개가 없어요. 180자 안에서 서로를 알려주세요!`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${page}\n아직 자기소개가 없어요. 180자 안에서 서로를 알려주세요!`,
          },
        },
        introductionActionBlock(),
      ],
    });
}

export async function handleIntroductionChannelMessage(
  event: Record<string, unknown>,
  env: CommunityEnv,
): Promise<boolean> {
  if (!env.COMMUNITY_INTRO_CHANNEL_ID || event.channel !== env.COMMUNITY_INTRO_CHANNEL_ID)
    return false;
  if (isJoin(event)) return welcomeIntroductionMember(event, env);
  if (event.type !== "message" || event.bot_id || event.subtype !== undefined) return true;
  const userId = string(event.user);
  const source = string(event.ts);
  if (!/^[UW][A-Z0-9]+$/.test(userId) || Math.abs(Date.now() / 1000 - Number(source)) > 300)
    return true;
  const raw = string(event.text);
  const text = (
    env.COMMUNITY_BOT_USER_ID ? raw.split(`<@${env.COMMUNITY_BOT_USER_ID}>`).join("") : raw
  ).trim();
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  const context: CommunityContext = {
    env,
    store,
    scope: { teamId: env.SLACK_TEAM_ID, channelId: string(event.channel), userId },
    source,
    thread: string(event.thread_ts ?? event.ts),
    date: koreaDate(Number(source)),
    key: `introduction-message:${source}`,
  };
  if (/^자기소개 (모두 보기|목록)$/.test(text)) {
    await showIntroductionDirectory(context);
    return true;
  }
  if (/^자기소개 (현황|미작성자 안내)$/.test(text)) {
    await remindMissingIntroductions(context);
    return true;
  }
  return true;
}
