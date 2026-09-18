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
};

type Scope = { readonly teamId: string; readonly channelId: string };

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function delivery(value: Json): GardenDelivery | null {
  if (value === null) return null;
  const item = object(value);
  const status = string(item.status);
  if (!["pending", "claimed", "sent", "failed", "cancelled"].includes(status))
    throw new InputError("Invalid garden delivery status");
  if (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision))
    throw new InputError("Invalid garden revision");
  if (typeof item.attempts !== "number" || !Number.isSafeInteger(item.attempts))
    throw new InputError("Invalid garden attempts");
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
    },
  ): Promise<boolean> {
    return (await this.call("prepare_garden_delivery", input)) === true;
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
}
