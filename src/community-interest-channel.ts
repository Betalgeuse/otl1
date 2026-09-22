import type { CommunityEnv } from "./community-runtime";
import { InputError, object, string } from "./input";

export async function assertPrivateInterestAdminChannel(env: CommunityEnv): Promise<string> {
  const channelId = env.INTEREST_ADMIN_CHANNEL_ID;
  if (!channelId || channelId === env.COMMUNITY_PUBLIC_CHANNEL_ID || !env.SLACK_BOT_TOKEN)
    throw new InputError("비공개 관리자 채널을 확인할 수 없습니다.");
  const url = new URL("https://slack.com/api/conversations.info");
  url.searchParams.set("channel", channelId);
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(6000),
    redirect: "manual",
  });
  if (!response.ok) throw new InputError("비공개 관리자 채널을 확인할 수 없습니다.");
  const data = object(await response.json());
  if (data.ok !== true) throw new InputError("비공개 관리자 채널을 확인할 수 없습니다.");
  const channel = object(data.channel);
  if (
    string(channel.id) !== channelId ||
    channel.is_private !== true ||
    channel.is_im === true ||
    channel.is_mpim === true ||
    channel.is_ext_shared === true ||
    channel.is_archived === true ||
    (channel.context_team_id !== undefined && channel.context_team_id !== env.SLACK_TEAM_ID)
  )
    throw new InputError("비공개 관리자 채널을 확인할 수 없습니다.");
  return channelId;
}
