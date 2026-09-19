import { date, InputError, type Json, object, string } from "./input";
import type { NeonStore } from "./store";

export type GardenDelivery = {
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly deliveryKey: string;
  readonly date: string;
  readonly revision: number;
  readonly source: string;
  readonly thread: string;
  readonly undoKey: string | null;
  readonly status: "pending" | "claimed" | "sent" | "failed" | "cancelled";
  readonly attempts: number;
  readonly leaseToken: string | null;
  readonly payloadDigest: string | null;
  readonly messageTs: string | null;
  readonly projectionKey: string;
  readonly routeKind: "interaction" | "goal_prompt" | "review_prompt";
  readonly routeProvenance: "recorded" | "daily_prompt_fallback" | "canonical_review";
};
export type GardenRetirement = {
  readonly retirementId: number;
  readonly messageTs: string;
  readonly replacementMessageTs?: string;
  readonly action: "update";
  readonly preserveReplies: true;
  readonly restorePayload: Json;
};

type Scope = { readonly teamId: string; readonly channelId: string };

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function json(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return value.map(json);
  const item = object(value);
  return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, json(nested)]));
}

function delivery(value: Json): GardenDelivery | null {
  if (value === null) return null;
  const item = object(value);
  const status = string(item.status);
  const routeKind = string(item.routeKind);
  const routeProvenance = string(item.routeProvenance);
  if (!["pending", "claimed", "sent", "failed", "cancelled"].includes(status))
    throw new InputError("Invalid garden delivery status");
  if (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision))
    throw new InputError("Invalid garden revision");
  if (typeof item.attempts !== "number" || !Number.isSafeInteger(item.attempts))
    throw new InputError("Invalid garden attempts");
  if (!["interaction", "goal_prompt", "review_prompt"].includes(routeKind))
    throw new InputError("Invalid garden route kind");
  switch (routeProvenance) {
    case "recorded":
    case "daily_prompt_fallback":
    case "canonical_review":
      break;
    default:
      throw new InputError("Invalid garden route provenance");
  }
  return {
    teamId: string(item.teamId),
    channelId: string(item.channelId),
    userId: string(item.userId),
    deliveryKey: string(item.deliveryKey),
    date: date(item.date),
    revision: item.revision,
    source: string(item.source),
    thread: string(item.thread),
    undoKey: nullableString(item.undoKey),
    status: status as GardenDelivery["status"],
    attempts: item.attempts,
    leaseToken: nullableString(item.leaseToken),
    payloadDigest: nullableString(item.payloadDigest),
    messageTs: nullableString(item.messageTs),
    projectionKey: string(item.projectionKey),
    routeKind: routeKind as GardenDelivery["routeKind"],
    routeProvenance,
  };
}

function retirement(value: Json): GardenRetirement | null {
  if (value === null) return null;
  const item = object(value);
  if (typeof item.retirementId !== "number" || !Number.isSafeInteger(item.retirementId))
    throw new InputError("Invalid garden retirement");
  if (item.action !== "update" || item.preserveReplies !== true)
    throw new InputError("Invalid garden retirement action");
  return {
    retirementId: item.retirementId,
    messageTs: string(item.messageTs),
    ...(item.replacementMessageTs === undefined
      ? {}
      : { replacementMessageTs: string(item.replacementMessageTs) }),
    action: item.action,
    preserveReplies: item.preserveReplies,
    restorePayload: json(item.restorePayload),
  };
}

export class GardenDeliveryStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}

  private call(operation: string, payload: Readonly<Record<string, unknown>>): Promise<Json> {
    return this.db.queryJson("SELECT otl.community_execute($1,$2::jsonb)", [
      operation,
      JSON.stringify(payload),
    ]);
  }

  async claim(
    input: Scope & {
      readonly deliveryKey?: string;
      readonly leaseToken: string;
      readonly now: string;
    },
  ): Promise<GardenDelivery | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid garden claim time");
    return delivery(await this.call("claim_garden_delivery", input));
  }

  async prepare(
    input: Scope & {
      readonly userId: string;
      readonly deliveryKey: string;
      readonly leaseToken: string;
      readonly payloadDigest: string;
      readonly payload: Json;
    },
  ): Promise<{ readonly payloadDigest: string; readonly payload: Json } | null> {
    const value = await this.call("prepare_garden_delivery", input);
    if (value === false) return null;
    const prepared = object(value);
    return { payloadDigest: string(prepared.payloadDigest), payload: json(prepared.payload) };
  }

  async finish(
    input: Scope & {
      readonly userId: string;
      readonly deliveryKey: string;
      readonly leaseToken: string;
      readonly status: "sent" | "failed" | "cancelled";
      readonly messageTs?: string;
      readonly errorCode?: string;
      readonly retryAfter?: string;
    },
  ): Promise<boolean> {
    return (await this.call("finish_garden_delivery", input)) === true;
  }
  async claimRetirement(
    input: Scope & {
      readonly workerId: string;
      readonly leaseToken: string;
      readonly now: string;
    },
  ): Promise<GardenRetirement | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid retirement time");
    return retirement(await this.call("claim_review_garden_retirement", input));
  }
  async finishRetirement(
    input: Scope & {
      readonly retirementId: number;
      readonly leaseToken: string;
      readonly status: "retired" | "failed";
      readonly errorCode?: string;
      readonly retryAfter?: string;
    },
  ): Promise<boolean> {
    return (await this.call("finish_review_garden_retirement", input)) === true;
  }
  async claimRestore(
    input: Scope & {
      readonly retirementId: number;
      readonly workerId: string;
      readonly leaseToken: string;
      readonly now: string;
    },
  ): Promise<GardenRetirement | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid restore time");
    return retirement(await this.call("claim_review_garden_restore", input));
  }
  async finishRestore(
    input: Scope & {
      readonly retirementId: number;
      readonly leaseToken: string;
      readonly status: "restored" | "restore_failed";
      readonly errorCode?: string;
    },
  ): Promise<boolean> {
    return (await this.call("finish_review_garden_restore", input)) === true;
  }
}
