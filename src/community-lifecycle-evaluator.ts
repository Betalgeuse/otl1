import type { LifecycleMode, LifecycleNoticeKind } from "./community-lifecycle-runtime-types";
import type { LifecycleState } from "./community-lifecycle-types";
import { InputError } from "./input";

export function parseLifecycleMode(value: string | undefined): LifecycleMode {
  switch (value) {
    case undefined:
    case "disabled":
      return "disabled";
    case "shadow":
    case "enforce":
      return value;
    default:
      throw new InputError("Invalid lifecycle mode");
  }
}

export type ReminderEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: "lifecycle_grace" | "lifecycle_dormant" };

export function ordinaryReminderEligibility(state: LifecycleState): ReminderEligibility {
  if (state === "active") return { eligible: true };
  return { eligible: false, reason: state === "grace" ? "lifecycle_grace" : "lifecycle_dormant" };
}

export function lifecycleNoticeKinds(): readonly LifecycleNoticeKind[] {
  return ["grace_start", "three_days", "one_day", "extension", "closure", "return"];
}
