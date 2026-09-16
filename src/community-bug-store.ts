import type { ConfirmedBugPacket } from "./community-bug-schema";
import { parseBugDraftRead, parseConfirmedPacket } from "./community-bug-store-read";
import {
  type AnswerBugRevision,
  BUG_STATES,
  type BugDraft,
  type BugDraftRead,
  type BugJob,
  BugStoreError,
  type CancelBugJob,
  type ConfirmPacketInput,
  type CreateBugDraft,
  type EnqueueBugJob,
  type FindActiveBugDraft,
  type FinishBugJob,
  type GetBugDraft,
  type HeartbeatBugJob,
  type LeaseBugJob,
  type TransitionBug,
  type TransitionResult,
} from "./community-bug-types";
import type { Json } from "./input";

export interface BugSqlClient {
  queryJson(query: string, params: readonly string[]): Promise<Json>;
}

type JsonObject = { readonly [key: string]: Json };

function object(value: Json): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BugStoreError("response");
  }
  return Object.fromEntries(Object.entries(value));
}

function textField(value: JsonObject, snake: string, camel = snake): string {
  const field = value[snake] ?? value[camel];
  if (typeof field !== "string") throw new BugStoreError("response");
  return field;
}

function numberField(value: JsonObject, snake: string, camel = snake): number {
  const field = value[snake] ?? value[camel];
  const parsed = typeof field === "string" ? Number(field) : field;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new BugStoreError("response");
  }
  return parsed;
}

function nullableText(value: JsonObject, snake: string, camel = snake): string | null {
  const field = value[snake] ?? value[camel];
  if (field === null) return null;
  if (typeof field !== "string") throw new BugStoreError("response");
  return field;
}

function bugState(value: string): BugDraft["state"] {
  for (const state of BUG_STATES) if (value === state) return state;
  throw new BugStoreError("response");
}

function jobKind(value: string): BugJob["kind"] {
  for (const kind of ["reproduce", "fix", "review", "deploy"] as const) {
    if (value === kind) return kind;
  }
  throw new BugStoreError("response");
}

function jobStatus(value: string): BugJob["status"] {
  for (const status of ["queued", "leased", "succeeded", "failed", "cancelled"] as const) {
    if (value === status) return status;
  }
  throw new BugStoreError("response");
}

function bugDraft(value: Json): BugDraft {
  const row = object(value);
  return {
    bugId: textField(row, "bug_id", "bugId"),
    state: bugState(textField(row, "state")),
    revision: numberField(row, "revision"),
    packetRevision: numberField(row, "packet_revision", "packetRevision"),
    publicAlias: textField(row, "public_alias", "publicAlias"),
  };
}

function transitionResult(value: Json): TransitionResult {
  const row = object(value);
  const changed = row.changed;
  const idempotent = row.idempotent;
  if (typeof changed !== "boolean" || typeof idempotent !== "boolean") {
    throw new BugStoreError("response");
  }
  return {
    changed,
    idempotent,
    eventId: numberField(row, "eventId"),
    state: bugState(textField(row, "state")),
    revision: numberField(row, "revision"),
  };
}

function bugJob(value: Json): BugJob {
  const row = object(value);
  return {
    jobId: numberField(row, "job_id", "jobId"),
    bugId: textField(row, "bug_id", "bugId"),
    kind: jobKind(textField(row, "kind")),
    status: jobStatus(textField(row, "status")),
    assignedAlias: nullableText(row, "assigned_alias", "assignedAlias"),
    leaseToken: nullableText(row, "lease_token", "leaseToken"),
    attempt: numberField(row, "attempt"),
  };
}

function nullableBugJob(value: Json): BugJob | null {
  return value === null ? null : bugJob(value);
}

export class CommunityBugStore {
  constructor(private readonly db: BugSqlClient) {}

  private async call(functionName: string, input: object): Promise<Json> {
    return this.db.queryJson(`SELECT otl.${functionName}($1::jsonb)`, [JSON.stringify(input)]);
  }

  async createDraft(input: CreateBugDraft): Promise<BugDraft> {
    return bugDraft(await this.call("bug_create_draft", input));
  }

  async answerRevision(input: AnswerBugRevision): Promise<number> {
    const row = object(await this.call("bug_answer_revision", input));
    return numberField(row, "packet_revision", "packetRevision");
  }

  async confirmPacket(input: ConfirmPacketInput): Promise<ConfirmedBugPacket> {
    return parseConfirmedPacket(await this.call("bug_confirm_packet", input));
  }

  async getDraft(input: GetBugDraft): Promise<BugDraftRead> {
    return parseBugDraftRead(await this.call("bug_get_draft", input));
  }

  async findActiveDraft(input: FindActiveBugDraft): Promise<BugDraftRead | null> {
    const result = await this.call("bug_find_active_draft", input);
    return result === null ? null : parseBugDraftRead(result);
  }

  async getBug(input: GetBugDraft): Promise<BugDraftRead> {
    return this.getDraft(input);
  }

  async findActiveBug(input: FindActiveBugDraft): Promise<BugDraftRead | null> {
    return this.findActiveDraft(input);
  }

  async transition(input: TransitionBug): Promise<TransitionResult> {
    return transitionResult(await this.call("bug_transition", input));
  }

  async enqueueJob(input: EnqueueBugJob): Promise<BugJob> {
    return bugJob(await this.call("bug_enqueue_job", input));
  }

  async leaseJob(input: LeaseBugJob): Promise<BugJob | null> {
    return nullableBugJob(await this.call("bug_lease_job", input));
  }

  async heartbeatJob(input: HeartbeatBugJob): Promise<BugJob> {
    return bugJob(await this.call("bug_heartbeat_job", input));
  }

  async finishJob(input: FinishBugJob): Promise<BugJob> {
    return bugJob(await this.call("bug_finish_job", input));
  }

  async cancelJob(input: CancelBugJob): Promise<BugJob> {
    return bugJob(await this.call("bug_cancel_job", input));
  }
}
