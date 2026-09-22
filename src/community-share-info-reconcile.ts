import type { CommunityEnv } from "./community-runtime";
import { handleShareInfoMessage, shareInfoChannelIds } from "./community-share-info";
import { callSlack } from "./community-social";
import { CommunityStore } from "./community-store";
import { koreaDate, list, object, string } from "./input";
import { NeonStore } from "./store";

const LOOKBACK_SECONDS = 20 * 60;

export async function reconcileShareInfoChannels(
  env: CommunityEnv,
  scheduledTime: number,
  store: CommunityStore = new CommunityStore(new NeonStore(env.DATABASE_URL)),
): Promise<number> {
  let processed = 0;
  for (const channelId of shareInfoChannelIds(env)) {
    const history = await callSlack(env.SLACK_BOT_TOKEN, "conversations.history", {
      channel: channelId,
      oldest: String(scheduledTime / 1_000 - LOOKBACK_SECONDS),
      inclusive: true,
      limit: 20,
    });
    const messages = list(history.messages).map(object).toReversed();
    for (const message of messages) {
      const event = object({ ...message, channel: channelId });
      const source = string(event.ts);
      const userId = string(event.user ?? "");
      if (!/^[UW][A-Z0-9]+$/.test(userId)) continue;
      if (
        await handleShareInfoMessage(event, {
          env,
          store,
          scope: { teamId: env.SLACK_TEAM_ID, channelId, userId },
          source,
          thread: string(event.thread_ts ?? source),
          date: koreaDate(Number(source)),
          key: `share-info-reconcile:${source}`,
        })
      )
        processed += 1;
    }
  }
  return processed;
}
