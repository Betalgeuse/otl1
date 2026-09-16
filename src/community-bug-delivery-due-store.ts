import { type BugDelivery, parseBugDelivery } from "./community-bug-delivery-store";
import type { BugSqlClient } from "./community-bug-store";
import { BugStoreError } from "./community-bug-types";
import type { Json } from "./input";

export type DueBugDelivery = {
  readonly delivery: BugDelivery;
  readonly reporterId: string;
  readonly sourceChannelId: string;
  readonly sourceThread: string;
  readonly reportRevision: number;
  readonly sanitizedFields: JsonObject;
};

type JsonObject = { readonly [key: string]: Json };

function object(value: Json): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BugStoreError("response");
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new BugStoreError("response");
  return field;
}

function number(value: JsonObject, key: string): number {
  const field = value[key];
  const parsed = typeof field === "string" ? Number(field) : field;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new BugStoreError("response");
  }
  return parsed;
}

function parseDueDelivery(value: Json): DueBugDelivery {
  const row = object(value);
  return {
    delivery: parseBugDelivery(value),
    reporterId: text(row, "reporter_id"),
    sourceChannelId: text(row, "source_channel_id"),
    sourceThread: text(row, "source_thread"),
    reportRevision: number(row, "report_revision"),
    sanitizedFields: object(row.sanitized_fields ?? null),
  };
}

export class CommunityBugDueDeliveryStore {
  constructor(private readonly db: BugSqlClient) {}

  async claim(input: {
    readonly workerId: string;
    readonly leaseToken: string;
    readonly limit: number;
    readonly now: string;
  }): Promise<readonly DueBugDelivery[]> {
    const value = await this.db.queryJson("SELECT otl.bug_claim_due_deliveries($1::jsonb)", [
      JSON.stringify(input),
    ]);
    if (!Array.isArray(value)) throw new BugStoreError("response");
    return value.map(parseDueDelivery);
  }
}
