import { armBugDeliveryClock } from "./community-bug-clock-client";
import type { CommunityEnv } from "./community-runtime";
import { runCommunitySchedule } from "./community-scheduler";
import { CommunityStore } from "./community-store";
import { NeonStore } from "./store";

export async function communityCron(env: CommunityEnv, scheduledTime: number): Promise<void> {
  try {
    await armBugDeliveryClock(env, { reason: "cron", observedAt: scheduledTime });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "community.bug.clock.arm.failed",
        scheduledTime,
        code: "boundary_failure",
        failure: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
  if (env.COMMUNITY_ENABLED !== "true" || env.DATABASE_MAINTENANCE === "true") return;
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
