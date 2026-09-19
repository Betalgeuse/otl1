import type {
  LifecycleMutation,
  LifecycleScope,
  LifecycleSignalMutation,
  LifecycleState,
  MemberLifecycle,
  ServiceDayExclusion,
  ServiceDayResult,
} from "./community-lifecycle-types";
import { date, InputError, type Json, object, string } from "./input";
import type { NeonStore } from "./store";

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InputError("Boolean required");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InputError("Non-negative integer required");
  return value;
}

function instant(value: unknown): string {
  const result = string(value);
  if (!Number.isFinite(Date.parse(result))) throw new InputError("Invalid time");
  return result;
}

function nullableDate(value: unknown): string | null {
  return value === null ? null : date(value);
}

function nullableInstant(value: unknown): string | null {
  return value === null ? null : instant(value);
}

function lifecycleState(value: unknown): LifecycleState {
  switch (value) {
    case "active":
    case "grace":
    case "dormant":
      return value;
    default:
      throw new InputError("Invalid lifecycle state");
  }
}

function exclusion(value: unknown): ServiceDayExclusion | null {
  switch (value) {
    case null:
    case "weekend":
    case "goal_prompt_missing":
    case "snapshot_missing":
      return value;
    default:
      throw new InputError("Invalid service-day exclusion");
  }
}

function memberLifecycle(value: Json): MemberLifecycle {
  const input = object(value);
  const seasonId = input.seasonId === null ? null : integer(input.seasonId);
  return {
    teamId: string(input.teamId),
    channelId: string(input.channelId),
    userId: string(input.userId),
    state: lifecycleState(input.state),
    revision: integer(input.revision),
    rolloutAt: instant(input.rolloutAt),
    lastTransitionAt: instant(input.lastTransitionAt),
    graceStartedAt: nullableInstant(input.graceStartedAt),
    graceDeadline: nullableDate(input.graceDeadline),
    extensionUsed: bool(input.extensionUsed),
    seasonId,
  };
}

function serviceDay(value: Json): ServiceDayResult {
  const input = object(value);
  return {
    date: date(input.date),
    eligible: bool(input.eligible),
    reason: exclusion(input.reason),
    changed: bool(input.changed),
  };
}

function mutation(input: LifecycleMutation): LifecycleMutation {
  if (!input.key.trim()) throw new InputError("Lifecycle key required");
  instant(input.now);
  integer(input.expectedRevision);
  return input;
}

export class CommunityLifecycleStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}

  private call(operation: string, payload: Json): Promise<Json> {
    return this.db.queryJson("SELECT otl.lifecycle_execute($1,$2::jsonb)", [
      operation,
      JSON.stringify(payload),
    ]);
  }

  async member(input: LifecycleScope): Promise<MemberLifecycle> {
    return memberLifecycle(await this.call("get", input));
  }

  async closeServiceDay(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly date: string;
    readonly now: string;
  }): Promise<ServiceDayResult> {
    date(input.date);
    instant(input.now);
    return serviceDay(await this.call("close_day", input));
  }

  async signal(input: LifecycleSignalMutation): Promise<MemberLifecycle> {
    mutation(input);
    date(input.date);
    return memberLifecycle(await this.call("signal", input));
  }

  async extend(input: LifecycleMutation): Promise<MemberLifecycle> {
    mutation(input);
    return memberLifecycle(await this.call("extend", input));
  }

  async expire(input: LifecycleMutation): Promise<MemberLifecycle> {
    mutation(input);
    return memberLifecycle(await this.call("expire", input));
  }
}
