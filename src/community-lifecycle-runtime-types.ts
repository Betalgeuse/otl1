import type { Json } from "./input";

export type LifecycleMode = "disabled" | "shadow" | "enforce";
export type LifecycleNoticeKind =
  | "grace_start"
  | "three_days"
  | "one_day"
  | "extension"
  | "closure"
  | "return";

export type LifecycleNotice = {
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly effectKey: string;
  readonly kind: LifecycleNoticeKind;
  readonly revision: number;
  readonly scheduledAt: string;
  readonly attempts: number;
  readonly leaseToken: string;
  readonly dmChannelId: string | null;
  readonly payload: Json;
};

export type LifecycleBatchResult = {
  readonly processed: number;
  readonly candidates: number;
  readonly transitions: number;
  readonly possiblyMore: boolean;
  readonly nextDue: string | null;
};

export type LifecycleActionId =
  | "lifecycle_extend"
  | "lifecycle_review"
  | "lifecycle_stop"
  | "lifecycle_restore_error";

export type LifecycleActionBinding = {
  readonly actionId: LifecycleActionId;
  readonly teamId: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly key: string;
};
