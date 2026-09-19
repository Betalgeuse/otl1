import type {
  LifecycleActionBinding,
  LifecycleBatchResult,
  LifecycleMode,
  LifecycleNotice,
  LifecycleNoticeKind,
} from "./community-lifecycle-runtime-types";
import { date, InputError, type Json, list, object, string } from "./input";
import type { NeonStore } from "./store";

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InputError("Non-negative integer required");
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InputError("Boolean required");
  return value;
}

function nullableInstant(value: unknown): string | null {
  if (value === null) return null;
  const result = string(value);
  if (!Number.isFinite(Date.parse(result))) throw new InputError("Invalid time");
  return result;
}

function jsonValue(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  const row = object(value);
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, jsonValue(item)]));
}

function noticeKind(value: unknown): LifecycleNoticeKind {
  switch (value) {
    case "grace_start":
    case "three_days":
    case "one_day":
    case "extension":
    case "closure":
    case "return":
      return value;
    default:
      throw new InputError("Invalid lifecycle notice kind");
  }
}

function batchResult(value: Json): LifecycleBatchResult {
  const row = object(value);
  return {
    processed: integer(row.processed),
    candidates: row.candidates === undefined ? 0 : integer(row.candidates),
    transitions: row.transitions === undefined ? 0 : integer(row.transitions),
    possiblyMore: bool(row.possiblyMore),
    nextDue: nullableInstant(row.nextDue),
  };
}

function notice(value: Json): LifecycleNotice {
  const row = object(value);
  return {
    teamId: string(row.teamId),
    channelId: string(row.channelId),
    userId: string(row.userId),
    effectKey: string(row.effectKey),
    kind: noticeKind(row.kind),
    revision: integer(row.revision),
    scheduledAt: string(row.scheduledAt),
    attempts: integer(row.attempts),
    leaseToken: string(row.leaseToken),
    dmChannelId: row.dmChannelId === null ? null : string(row.dmChannelId),
    payload: jsonValue(row.payload),
  };
}

export type NoticeFinish = {
  readonly teamId: string;
  readonly userId: string;
  readonly effectKey: string;
  readonly leaseToken: string;
  readonly now: string;
  readonly status: "sent" | "failed" | "dead";
  readonly messageTs?: string;
  readonly errorCode?: string;
  readonly retryAt?: string;
};

export class CommunityLifecycleRuntimeStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}

  private call(operation: string, payload: Json): Promise<Json> {
    return this.db.queryJson("SELECT otl.lifecycle_runtime_execute($1,$2::jsonb)", [
      operation,
      JSON.stringify(payload),
    ]);
  }

  async evaluateBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly date: string;
    readonly mode: LifecycleMode;
    readonly limit: number;
  }): Promise<LifecycleBatchResult> {
    date(input.date);
    return batchResult(await this.call("evaluate_batch", input));
  }

  async reconcile(input: {
    readonly teamId: string;
    readonly now: string;
    readonly limit: number;
  }): Promise<LifecycleBatchResult> {
    return batchResult(await this.call("reconcile", input));
  }

  async nextDue(teamId: string): Promise<string | null> {
    return nullableInstant(await this.call("next_due", { teamId }));
  }

  async claimNotices(input: {
    readonly teamId: string;
    readonly now: string;
    readonly limit: number;
    readonly leaseToken: string;
  }): Promise<readonly LifecycleNotice[]> {
    return list(await this.call("claim_notices", input)).map((value) => notice(jsonValue(value)));
  }

  prepareNotice(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly effectKey: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly dmChannelId: string;
    readonly payloadDigest: string;
  }): Promise<Json> {
    return this.call("prepare_notice", input);
  }

  finishNotice(input: NoticeFinish): Promise<Json> {
    return this.call("finish_notice", input);
  }

  action(binding: LifecycleActionBinding, now: string): Promise<Json> {
    return this.call("action", {
      teamId: binding.teamId,
      channelId: binding.channelId,
      userId: binding.ownerId,
      actionId: binding.actionId,
      expectedRevision: binding.revision,
      key: binding.key,
      now,
    });
  }
}

export class CommunityLifecycleAdminStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}

  restoreError(binding: LifecycleActionBinding, now: string, evidenceKey: string): Promise<Json> {
    if (binding.actionId !== "lifecycle_restore_error")
      throw new InputError("Admin restore action required");
    if (!evidenceKey.trim()) throw new InputError("Correction evidence required");
    return this.db.queryJson("SELECT otl.lifecycle_admin_execute($1,$2::jsonb)", [
      "restore_error",
      JSON.stringify({
        teamId: binding.teamId,
        channelId: binding.channelId,
        userId: binding.ownerId,
        expectedRevision: binding.revision,
        key: binding.key,
        now,
        evidenceKey,
      }),
    ]);
  }
}
