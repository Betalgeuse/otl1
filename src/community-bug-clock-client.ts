export const BUG_DELIVERY_CLOCK_ROLE = "bug_delivery" as const;
export const COMMUNITY_SCHEDULE_CLOCK_ROLE = "community_schedule" as const;
export const BUG_CLOCK_CAPABILITIES = {
  bugDeliveryClock: {
    role: BUG_DELIVERY_CLOCK_ROLE,
    activityArming: true,
    dueDeadlineArming: true,
    cronBackup: true,
  },
} as const;

export type BugDeliveryArm =
  | { readonly reason: "cron"; readonly observedAt: number }
  | { readonly reason: "activity"; readonly observedAt: number }
  | { readonly reason: "due"; readonly observedAt: number; readonly nextDue: number };

export type BugDeliveryArmResult = {
  readonly role: typeof BUG_DELIVERY_CLOCK_ROLE;
  readonly armed: boolean;
  readonly next: number | null;
};

export type GardenRequest = {
  readonly userId: string;
  readonly channelId: string;
  readonly date: string;
  readonly source: string;
  readonly thread: string;
  readonly key: string;
  readonly undoKey: string | null;
  readonly deliveryKey?: string;
};

export type ClockInspection = {
  readonly next: number | null;
  readonly role: string | null;
  readonly lastRun: Readonly<Record<string, unknown>> | null;
};

export interface ClockBinding {
  getByName(name: string): {
    refresh(channelId: string): Promise<{ readonly next: number | null }>;
    armMembershipScan(channelId: string, cursor: string | null): Promise<void>;
    armBugDelivery(input: BugDeliveryArm): Promise<BugDeliveryArmResult>;
    inspect(): Promise<ClockInspection>;
    publishGarden(input: GardenRequest): Promise<string>;
  };
}

export function bugDeliveryClockName(teamId: string): string {
  return `bug-delivery:${teamId}`;
}

export async function armBugDeliveryClock(
  env: { readonly SLACK_TEAM_ID: string; readonly COMMUNITY_CLOCK?: ClockBinding },
  input: BugDeliveryArm,
): Promise<BugDeliveryArmResult> {
  if (!env.COMMUNITY_CLOCK) return { role: BUG_DELIVERY_CLOCK_ROLE, armed: false, next: null };
  return env.COMMUNITY_CLOCK.getByName(bugDeliveryClockName(env.SLACK_TEAM_ID)).armBugDelivery(
    input,
  );
}
