import type { CommunityEnv } from "./community-runtime";
import { CommunitySlackError, callSlack } from "./community-social";
import { InputError, object, string } from "./input";
import { NeonStore } from "./store";

async function readGuide(env: CommunityEnv, channel: string, timestamp: string) {
  const url = new URL("https://slack.com/api/conversations.history");
  for (const [key, value] of Object.entries({
    channel,
    oldest: timestamp,
    latest: timestamp,
    inclusive: "true",
    limit: "1",
  }))
    url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(6000),
    redirect: "manual",
  });
  const result = object(await response.json());
  if (!response.ok || result.ok !== true) throw new CommunitySlackError("guide_source_unavailable");
  const source = object(Array.isArray(result.messages) ? result.messages[0] : undefined);
  if (
    source.ts !== timestamp ||
    source.user !== env.COMMUNITY_ADMIN_ID ||
    source.subtype ||
    source.bot_id
  )
    throw new InputError("관리자가 작성한 원본 안내글을 확인할 수 없습니다.");
  const body = string(source.text);
  if (!body.trim() || body.length > 38000) throw new InputError("안내글 본문을 확인해 주세요.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { body, hash, editedTs: source.edited ? string(object(source.edited).ts) : timestamp };
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
  if (!env.COMMUNITY_ADMIN_ID || !env.COMMUNITY_GUIDE_SOURCE_TS)
    throw new InputError("환영 안내글 설정이 필요합니다.");
  const userId = string(event.user);
  if (!/^[UW][A-Z0-9]+$/.test(userId) || event.bot_id) return true;
  const profile = object(
    (await callSlack(env.SLACK_BOT_TOKEN, "users.info", { user: userId })).user,
  );
  if (
    profile.id !== userId ||
    profile.is_bot !== false ||
    profile.is_app_user === true ||
    profile.deleted === true
  )
    return true;
  const guide = await readGuide(
    env,
    env.COMMUNITY_WELCOME_CHANNEL_ID,
    env.COMMUNITY_GUIDE_SOURCE_TS,
  );
  const store = new NeonStore(env.DATABASE_URL);
  const scope = { teamId: env.SLACK_TEAM_ID, channelId: env.COMMUNITY_WELCOME_CHANNEL_ID, userId };
  const claimed = await store.queryJson("SELECT otl.guide_execute($1,$2::jsonb)", [
    "claim",
    JSON.stringify({
      ...scope,
      ...guide,
      authorId: env.COMMUNITY_ADMIN_ID,
      sourceTs: env.COMMUNITY_GUIDE_SOURCE_TS,
    }),
  ]);
  if (claimed !== true) return true;
  // Automatic copies retain the guide but never repeat its workspace-wide notifications.
  const safeBody = guide.body
    .replace(/<!(channel|here|everyone)>/g, "@$1")
    .replace(/<[^>]*>|https?:\/\/\S+|\*?(?:원씽|\b(?:one\s*thing|onthing)\b)\*?/gi, (part) =>
      part.startsWith("<") || /^https?:/i.test(part) ? part : "*ONE THING*",
    );
  let sent: Record<string, unknown>;
  try {
    sent = await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: scope.channelId,
      text: `<@${userId}> 어서 오세요!!! 처음 오셨다면 이 안내부터 함께 읽어주세요.\n\n${safeBody}`,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    // A failed or ambiguous send is held for operator reconciliation, never auto-replayed.
    await store.queryJson("SELECT otl.guide_execute($1,$2::jsonb)", [
      "finish",
      JSON.stringify({ ...scope, status: "failed" }),
    ]);
    throw error;
  }
  await store.queryJson("SELECT otl.guide_execute($1,$2::jsonb)", [
    "finish",
    JSON.stringify({ ...scope, status: "sent", messageTs: string(sent.ts) }),
  ]);
  return true;
}
