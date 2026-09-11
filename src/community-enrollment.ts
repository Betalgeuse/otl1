import { armCommunityClock } from "./community-clock";
import type { CommunityEnv } from "./community-runtime";
import { callSlack } from "./community-social";
import { CommunityStore } from "./community-store";
import { object, string } from "./input";
import { NeonStore } from "./store";

export async function enrollReminderMember(
  event: Record<string, unknown>,
  env: CommunityEnv,
): Promise<void> {
  if (
    !env.COMMUNITY_PUBLIC_CHANNEL_ID ||
    event.channel !== env.COMMUNITY_PUBLIC_CHANNEL_ID ||
    !(
      event.type === "member_joined_channel" ||
      (event.type === "message" && event.subtype === "channel_join")
    )
  )
    return;
  const userId = string(event.user);
  if (!/^[UW][A-Z0-9]+$/.test(userId) || event.bot_id) return;
  const user = object((await callSlack(env.SLACK_BOT_TOKEN, "users.info", { user: userId })).user);
  if (
    user.id !== userId ||
    user.is_bot !== false ||
    user.deleted === true ||
    user.is_app_user === true
  )
    return;
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  await store.enrollReminders({
    teamId: env.SLACK_TEAM_ID,
    channelId: env.COMMUNITY_PUBLIC_CHANNEL_ID,
    userId,
  });
  await armCommunityClock(env, env.COMMUNITY_PUBLIC_CHANNEL_ID);
}
