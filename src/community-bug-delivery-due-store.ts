import { type BugDelivery, parseBugDelivery } from "./community-bug-delivery-store";
import type { PrivateBugRevision } from "./community-bug-private-report";
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
  readonly privateRevision: PrivateBugRevision | null;
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
  const revisionValue = row.private_revision;
  const revision =
    revisionValue === null || revisionValue === undefined ? null : object(revisionValue);
  const schemaVersion = revision ? text(revision, "schemaVersion") : null;
  if (schemaVersion !== null && schemaVersion !== "bug_intake.v1")
    throw new BugStoreError("response");
  return {
    delivery: parseBugDelivery(value),
    reporterId: text(row, "reporter_id"),
    sourceChannelId: text(row, "source_channel_id"),
    sourceThread: text(row, "source_thread"),
    reportRevision: number(row, "report_revision"),
    sanitizedFields: object(row.sanitized_fields ?? null),
    privateRevision: revision
      ? {
          bugId: text(row, "bug_id"),
          packetRevision: number(revision, "packetRevision"),
          schemaVersion: "bug_intake.v1",
          opaqueRef: text(revision, "opaqueRef"),
          objectDigest: text(revision, "objectDigest"),
          envelopeDek: text(revision, "envelopeDek"),
          kekVersion: text(revision, "kekVersion"),
          nonce: text(revision, "nonce"),
        }
      : null,
  };
}

export class CommunityBugDueDeliveryStore {
  constructor(private readonly db: BugSqlClient) {}

  async reconcilePrivate(input: {
    readonly teamId: string;
    readonly limit: number;
    readonly now: string;
  }): Promise<number> {
    const value = await this.db.queryJson("SELECT otl.bug_reconcile_private_incidents($1::jsonb)", [
      JSON.stringify(input),
    ]);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new BugStoreError("response");
    }
    return value;
  }

  async expire(input: {
    readonly teamId: string;
    readonly limit: number;
    readonly now: string;
  }): Promise<number> {
    const value = await this.db.queryJson("SELECT otl.bug_expire_due_intakes($1::jsonb)", [
      JSON.stringify(input),
    ]);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new BugStoreError("response");
    }
    return value;
  }

  async claim(input: {
    readonly teamId: string;
    readonly workerId: string;
    readonly leaseToken: string;
    readonly limit: number;
    readonly now: string;
  }): Promise<readonly DueBugDelivery[]> {
    const value = await this.db.queryJson("SELECT otl.bug_claim_due_deliveries($1::jsonb)", [
      JSON.stringify(input),
    ]);
    if (!Array.isArray(value)) throw new BugStoreError("response");
    const due: DueBugDelivery[] = [];
    for (const row of value) {
      try {
        due.push(parseDueDelivery(row));
      } catch (error) {
        if (!(error instanceof BugStoreError)) throw error;
        console.error(
          JSON.stringify({
            event: "community.bug.delivery.row.skipped",
            code: "malformed_row",
          }),
        );
      }
    }
    return due;
  }
}
