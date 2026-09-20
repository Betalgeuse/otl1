import { customBotEmoji, randomCustomEmoji } from "./community-emoji";
import { introductionButton } from "./community-introduction";
import type { CommunityEnv } from "./community-runtime";
import { addReactions, callSlack } from "./community-social";
import { CommunityStore } from "./community-store";
import { object, string } from "./input";
import { NeonStore } from "./store";

export async function welcomeTownhallMember(
  event: Record<string, unknown>,
  env: CommunityEnv,
): Promise<boolean> {
  if (
    event.type !== "member_joined_channel" &&
    !(event.type === "message" && event.subtype === "channel_join")
  )
    return false;
  const channelId = string(event.channel);
  if (!env.COMMUNITY_RELEASE_CHANNEL_ID || channelId !== env.COMMUNITY_RELEASE_CHANNEL_ID)
    return true;
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
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  const scope = { teamId: env.SLACK_TEAM_ID, channelId, userId, key: "townhall-welcome" };
  const text = `<@${userId}> 어서 오세요!!!! 🎉🐧🙌\n*ONE THING* 하나씩, 같이 해봐요!!!${env.COMMUNITY_PUBLIC_CHANNEL_ID ? ` 오늘 최우선순위로 먼저 해결할 중요한 일 한 가지를 <#${env.COMMUNITY_PUBLIC_CHANNEL_ID}>에 편하게 남겨주세요 🌱` : ""}\n다들 환영 이모지 하나씩 부탁해요!!! <!channel> 🥳`;
  await store.putRecord({
    ...scope,
    kind: "welcome",
    body: { source: string(event.ts ?? event.event_ts ?? ""), text },
  });
  if (!(await store.claimRecord(scope))) return true;
  const renderedText = await customBotEmoji(env.SLACK_BOT_TOKEN, text);
  const sent = await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
    channel: channelId,
    text: renderedText,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: renderedText } },
      { type: "actions", elements: [introductionButton()] },
    ],
    unfurl_links: false,
  });
  await store.finishRecord(scope, "sent");
  await addReactions(env.SLACK_BOT_TOKEN, {
    channel: channelId,
    ts: string(sent.ts),
    names: await randomCustomEmoji(env.SLACK_BOT_TOKEN),
  });
  return true;
}
