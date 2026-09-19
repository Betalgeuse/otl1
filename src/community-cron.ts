import { armBugDeliveryClock } from "./community-bug-clock-client";
import { runDueGardenDeliveries } from "./community-garden-delivery";
import { runMembershipDue } from "./community-membership-schedule";
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
    let garden: { readonly processed: number } = { processed: 0 };
    try {
      garden = await runDueGardenDeliveries(env, channel, scheduledTime);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(
        JSON.stringify({
          event: "community.cron.queue.failed",
          queue: "garden",
          errorType: error.name,
        }),
      );
    }
    const membership = await runMembershipDue(
      env,
      new NeonStore(env.DATABASE_URL),
      channel,
      scheduledTime,
    );
    if (membership.nextCursor && env.COMMUNITY_CLOCK && channel === env.COMMUNITY_PUBLIC_CHANNEL_ID)
      await env.COMMUNITY_CLOCK.getByName(`${env.SLACK_TEAM_ID}:${channel}`).armMembershipScan(
        channel,
        membership.nextCursor,
      );
    let result: { readonly common: number; readonly personal: number } = { common: 0, personal: 0 };
    try {
      result = await runCommunitySchedule(
        { ...env, COMMUNITY_CHANNEL_ID: channel, COMMUNITY_ADMIN_ID: env.COMMUNITY_ADMIN_ID },
        new CommunityStore(new NeonStore(env.DATABASE_URL)),
        new Date(scheduledTime),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(
        JSON.stringify({
          event: "community.cron.queue.failed",
          queue: "reminders",
          errorType: error.name,
        }),
      );
    }
    console.log(
      JSON.stringify({
        event: "community.cron",
        scheduledTime,
        gardenProcessed: garden.processed,
        membershipPossiblyMore: membership.possiblyMore,
        ...result,
      }),
    );
  }
}
