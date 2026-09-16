import { runDueBugDeliveries } from "./community-bug-delivery-scheduler";
import type { CommunityEnv } from "./community-runtime";
import { runCommunitySchedule } from "./community-scheduler";
import { CommunityStore } from "./community-store";
import { NeonStore } from "./store";

export async function communityCron(env: CommunityEnv, scheduledTime: number): Promise<void> {
  if (env.COMMUNITY_ENABLED !== "true" || env.DATABASE_MAINTENANCE === "true") return;
  await runDueBugDeliveries(env, scheduledTime);
  if (!env.COMMUNITY_ADMIN_ID) return;
  const channels = [env.COMMUNITY_CHANNEL_ID, env.COMMUNITY_PUBLIC_CHANNEL_ID].filter(
    (v): v is string => Boolean(v),
  );
  for (const channel of new Set(channels)) {
    const result = await runCommunitySchedule(
      { ...env, COMMUNITY_CHANNEL_ID: channel, COMMUNITY_ADMIN_ID: env.COMMUNITY_ADMIN_ID },
      new CommunityStore(new NeonStore(env.DATABASE_URL)),
      new Date(scheduledTime),
    );
    console.log(JSON.stringify({ event: "community.cron", scheduledTime, channel, ...result }));
  }
}
