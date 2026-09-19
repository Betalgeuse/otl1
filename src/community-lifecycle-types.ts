export type LifecycleState = "active" | "grace" | "dormant";
export type LifecycleSignal = "goal" | "outcome" | "reflection" | "rest";
export type ServiceDayExclusion = "weekend" | "goal_prompt_missing" | "snapshot_missing";

export type LifecycleScope = {
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: string;
};

export type MemberLifecycle = LifecycleScope & {
  readonly state: LifecycleState;
  readonly revision: number;
  readonly rolloutAt: string;
  readonly lastTransitionAt: string;
  readonly graceStartedAt: string | null;
  readonly graceDeadline: string | null;
  readonly extensionUsed: boolean;
  readonly seasonId: number | null;
};

export type LifecycleMutation = LifecycleScope & {
  readonly now: string;
  readonly expectedRevision: number;
  readonly key: string;
};

export type LifecycleSignalMutation = LifecycleMutation & {
  readonly date: string;
  readonly signal: LifecycleSignal;
};

export type ServiceDayResult = {
  readonly date: string;
  readonly eligible: boolean;
  readonly reason: ServiceDayExclusion | null;
  readonly changed: boolean;
};
