import { runDueBugDeliveries } from "./community-bug-delivery-scheduler";
import type { CommunityEnv } from "./community-runtime";

const ACTIVE_TICK_MS = 5 * 60 * 1_000;
const SAFETY_SCAN_MS = 60 * 60 * 1_000;

export type ClockStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
};

type BugClockState = {
  readonly activityDue: number | null;
  readonly nextDue: number | null;
  readonly safetyDue: number;
};

export function bugDeliveryClockName(teamId: string): string {
  return `bug-delivery:${teamId}`;
}

export async function readBugClockState(
  storage: ClockStorage,
  now: number,
): Promise<BugClockState> {
  const [activityDue, nextDue, safetyDue] = await Promise.all([
    storage.get<number>("bugActivityDue"),
    storage.get<number>("bugNextDue"),
    storage.get<number>("bugSafetyDue"),
  ]);
  return {
    activityDue: activityDue ?? null,
    nextDue: nextDue ?? null,
    safetyDue: safetyDue ?? now + SAFETY_SCAN_MS,
  };
}

export function nextBugClockAlarm(state: BugClockState): number {
  return Math.min(
    state.safetyDue,
    state.activityDue ?? Number.POSITIVE_INFINITY,
    state.nextDue ?? Number.POSITIVE_INFINITY,
  );
}

export async function runBugDeliveryClockAlarm(
  env: CommunityEnv,
  storage: ClockStorage,
  scheduledTime: number,
): Promise<void> {
  const state = await readBugClockState(storage, scheduledTime);
  const workDue = nextBugClockAlarm(state) <= scheduledTime;
  if (!workDue || env.DATABASE_MAINTENANCE === "true" || env.COMMUNITY_ENABLED !== "true") {
    const next = workDue ? scheduledTime + ACTIVE_TICK_MS : nextBugClockAlarm(state);
    await storage.setAlarm(next);
    await storage.put("lastRun", { at: scheduledTime, skipped: true });
    return;
  }

  await storage.setAlarm(scheduledTime + ACTIVE_TICK_MS);
  if (state.activityDue !== null && state.activityDue <= scheduledTime)
    await storage.delete("bugActivityDue");
  if (state.nextDue !== null && state.nextDue <= scheduledTime) await storage.delete("bugNextDue");
  await storage.put("bugSafetyDue", scheduledTime + SAFETY_SCAN_MS);
  try {
    const maintenance = await runDueBugDeliveries(env, scheduledTime, async (nextDue) => {
      const current = await storage.get<number>("bugNextDue");
      await storage.put("bugNextDue", Math.min(current ?? nextDue, nextDue));
    });
    if (maintenance.possiblyMore)
      await storage.put("bugActivityDue", scheduledTime + ACTIVE_TICK_MS);
    await storage.setAlarm(nextBugClockAlarm(await readBugClockState(storage, scheduledTime)));
    await storage.put("lastRun", {
      at: scheduledTime,
      reconciled: maintenance.reconcilePrivate.processed,
      expired: maintenance.expiry.processed,
      claimed: maintenance.deliveries.claimed,
      sent: maintenance.deliveries.sent,
      failed: maintenance.deliveries.failed,
      possiblyMore: maintenance.possiblyMore,
    });
  } catch (error) {
    const failure = error instanceof Error ? error.name : "UnknownError";
    await storage.put("bugActivityDue", scheduledTime + ACTIVE_TICK_MS);
    await storage.put("lastRun", { at: scheduledTime, failure });
    console.error(
      JSON.stringify({
        event: "community.bug.clock.failed",
        scheduledTime,
        code: "boundary_failure",
        failure,
      }),
    );
  }
}
