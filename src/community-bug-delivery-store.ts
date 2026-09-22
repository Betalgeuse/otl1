import type { BugSqlClient } from "./community-bug-store";
import { BugStoreError } from "./community-bug-types";
import type { Json } from "./input";

export type BugDeliveryKind = "question" | "summary" | "receipt" | "admin_handoff";
export type BugDeliveryDestination = "reporter_thread" | "reporter_ephemeral" | "admin_channel";
export type BugDeliveryStatus = "pending" | "claimed" | "sent" | "failed" | "cancelled";
export type BugDeliveryErrorCode =
  | "slack_api_error"
  | "rate_limited"
  | "auth_error"
  | "invalid_destination"
  | "timeout"
  | "network_error"
  | "invalid_payload"
  | "provider_error";

const KINDS = ["question", "summary", "receipt", "admin_handoff"] as const;
const DESTINATIONS = ["reporter_thread", "reporter_ephemeral", "admin_channel"] as const;
const FIELD_NAMES = [
  "actual",
  "expected",
  "steps",
  "location",
  "occurredAt",
  "frequency",
  "impact",
] as const;
const STATUSES = ["pending", "claimed", "sent", "failed", "cancelled"] as const;
const ERROR_CODES = [
  "slack_api_error",
  "rate_limited",
  "auth_error",
  "invalid_destination",
  "timeout",
  "network_error",
  "invalid_payload",
  "provider_error",
] as const;

export type BugDeliveryKey = {
  readonly teamId: string;
  readonly bugId: string;
  readonly reporterId: string;
  readonly deliveryKey: string;
};

type EnqueueBase = BugDeliveryKey & {
  readonly packetRevision: number;
  readonly destination: BugDeliveryDestination;
  readonly templateId: string;
  readonly rendererVersion: string;
  readonly notBefore?: string;
};

export type EnqueueBugDelivery = EnqueueBase &
  (
    | {
        readonly deliveryKind: "question";
        readonly questionId: string;
        readonly fieldName: (typeof FIELD_NAMES)[number];
      }
    | {
        readonly deliveryKind: "summary" | "receipt" | "admin_handoff";
        readonly questionId?: never;
        readonly fieldName?: never;
      }
  );

export type ClaimBugDelivery = BugDeliveryKey & {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseSeconds?: number;
  readonly now?: string;
};

type FinishBugDeliveryBase = Pick<BugDeliveryKey, "teamId" | "bugId" | "reporterId"> & {
  readonly deliveryId: number;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly now?: string;
};

export type FinishBugDelivery = FinishBugDeliveryBase &
  (
    | { readonly status: "sent"; readonly messageTs: string }
    | {
        readonly status: "failed";
        readonly errorCode: BugDeliveryErrorCode;
        readonly retryAfter?: string;
      }
  );

export type BugDelivery = {
  readonly deliveryId: number;
  readonly deliveryKey: string;
  readonly deliveryKind: BugDeliveryKind;
  readonly teamId: string;
  readonly bugId: string;
  readonly packetRevision: number;
  readonly questionId: string | null;
  readonly destination: BugDeliveryDestination;
  readonly templateId: string;
  readonly fieldName: (typeof FIELD_NAMES)[number] | null;
  readonly rendererVersion: string;
  readonly status: BugDeliveryStatus;
  readonly attempts: number;
  readonly notBefore: string;
  readonly retryAfter: string | null;
  readonly lastErrorCode: BugDeliveryErrorCode | null;
  readonly messageTs: string | null;
  readonly workerId: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
};

type JsonObject = { readonly [key: string]: Json };

function object(value: Json): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BugStoreError("response");
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: JsonObject, snake: string, camel = snake): string {
  const field = value[snake] ?? value[camel];
  if (typeof field !== "string") throw new BugStoreError("response");
  return field;
}

function number(value: JsonObject, snake: string, camel = snake): number {
  const field = value[snake] ?? value[camel];
  const parsed = typeof field === "string" ? Number(field) : field;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new BugStoreError("response");
  }
  return parsed;
}

function nullableText(value: JsonObject, snake: string, camel = snake): string | null {
  const field = Object.hasOwn(value, snake) ? value[snake] : value[camel];
  if (field === null) return null;
  if (typeof field !== "string") throw new BugStoreError("response");
  return field;
}

function literal<T extends string>(value: string, allowed: readonly T[]): T {
  for (const item of allowed) if (value === item) return item;
  throw new BugStoreError("response");
}

export function parseBugDelivery(value: Json): BugDelivery {
  const row = object(value);
  const error = nullableText(row, "last_error_code", "lastErrorCode");
  const field = nullableText(row, "field_name", "fieldName");
  return {
    deliveryId: number(row, "delivery_id", "deliveryId"),
    deliveryKey: text(row, "delivery_key", "deliveryKey"),
    deliveryKind: literal(text(row, "delivery_kind", "deliveryKind"), KINDS),
    teamId: text(row, "team_id", "teamId"),
    bugId: text(row, "bug_id", "bugId"),
    packetRevision: number(row, "packet_revision", "packetRevision"),
    questionId: nullableText(row, "question_id", "questionId"),
    destination: literal(text(row, "destination"), DESTINATIONS),
    templateId: text(row, "template_id", "templateId"),
    fieldName: field === null ? null : literal(field, FIELD_NAMES),
    rendererVersion: text(row, "renderer_version", "rendererVersion"),
    status: literal(text(row, "status"), STATUSES),
    attempts: number(row, "attempts"),
    notBefore: text(row, "not_before", "notBefore"),
    retryAfter: nullableText(row, "retry_after", "retryAfter"),
    lastErrorCode: error === null ? null : literal(error, ERROR_CODES),
    messageTs: nullableText(row, "message_ts", "messageTs"),
    workerId: nullableText(row, "worker_id", "workerId"),
    leaseToken: nullableText(row, "lease_token", "leaseToken"),
    leaseExpiresAt: nullableText(row, "lease_expires_at", "leaseExpiresAt"),
  };
}

export class CommunityBugDeliveryStore {
  constructor(private readonly db: BugSqlClient) {}

  private async call(functionName: string, input: object): Promise<Json> {
    return this.db.queryJson(`SELECT otl.${functionName}($1::jsonb)`, [JSON.stringify(input)]);
  }

  async enqueue(input: EnqueueBugDelivery): Promise<BugDelivery> {
    return parseBugDelivery(await this.call("bug_enqueue_delivery", input));
  }

  async claim(input: ClaimBugDelivery): Promise<BugDelivery | null> {
    const value = await this.call("bug_claim_delivery", input);
    return value === null ? null : parseBugDelivery(value);
  }

  async finish(input: FinishBugDelivery): Promise<BugDelivery> {
    return parseBugDelivery(await this.call("bug_finish_delivery", input));
  }

  async get(input: BugDeliveryKey): Promise<BugDelivery | null> {
    const value = await this.call("bug_get_delivery", input);
    return value === null ? null : parseBugDelivery(value);
  }
}
