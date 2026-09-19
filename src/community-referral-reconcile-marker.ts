import { z } from "zod";
import type { InvitePrivateBucket } from "./community-invite-private";
import { sign, verify } from "./signing";

export const MARKER_PREFIX = "invite-private-reconcile/v1" as const;
export const MAX_RECONCILE_ATTEMPTS = 5;

export type MarkerObject = {
  readonly key: string;
  readonly etag: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export interface InviteReconcileBucket extends InvitePrivateBucket {
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      readonly onlyIf?: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<{ readonly etag: string } | null>;
  get(key: string): Promise<MarkerObject | null>;
  list(options: {
    readonly prefix: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly objects: readonly { readonly key: string }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

const markerSchema = z
  .object({
    version: z.literal("invite-private-reconcile.v1"),
    teamId: z.string().min(1).max(80),
    requestId: z.string().regex(/^REQ-[A-Z0-9]{8,64}$/),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    objectDigest: z.string().regex(/^[0-9a-f]{64}$/),
    opaqueRef: z.string().regex(/^invite-private\/REQ-[A-Z0-9]{8,64}\/revision-0-[0-9a-f-]+\.enc$/),
    createdAt: z.string().datetime({ offset: true }),
    orphanExpiresAt: z.string().datetime({ offset: true }),
    nextAttemptAt: z.string().datetime({ offset: true }),
    attempts: z.number().int().min(0).max(MAX_RECONCILE_ATTEMPTS),
    status: z.enum(["pending", "claimed", "dead_letter"]),
    claimToken: z.string().uuid().nullable(),
    claimUntil: z.string().datetime({ offset: true }).nullable(),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .readonly();

export type InvitePrivateReconciliationMarker = z.infer<typeof markerSchema>;
export type UnsignedMarker = Omit<InvitePrivateReconciliationMarker, "signature">;

export type InviteReconcileEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly SITE_CORE_HMAC_SECRET?: string;
  readonly INVITE_PRIVATE_OBJECTS?: InviteReconcileBucket;
};

export class InviteReconciliationError extends Error {
  constructor(readonly code: "configuration" | "collision" | "invalid_key") {
    super(`invite reconciliation ${code}`);
    this.name = "InviteReconciliationError";
  }
}

export function encoded(value: string): ArrayBuffer {
  const valueBytes = new TextEncoder().encode(value);
  const result = new ArrayBuffer(valueBytes.byteLength);
  new Uint8Array(result).set(valueBytes);
  return result;
}

export async function reconciliationDigest(value: string | ArrayBuffer): Promise<string> {
  const input = typeof value === "string" ? encoded(value) : value;
  const result = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function unsigned(marker: InvitePrivateReconciliationMarker): UnsignedMarker {
  const { signature: _signature, ...payload } = marker;
  return payload;
}

export async function signedMarker(
  payload: UnsignedMarker,
  secret: string,
): Promise<InvitePrivateReconciliationMarker> {
  return { ...payload, signature: await sign(JSON.stringify(payload), secret) };
}

export async function markerKey(teamId: string, requestId: string): Promise<string> {
  return `${MARKER_PREFIX}/${(await reconciliationDigest(teamId)).slice(0, 24)}/${requestId}.json`;
}

export async function markerPrefix(teamId: string): Promise<string> {
  return `${MARKER_PREFIX}/${(await reconciliationDigest(teamId)).slice(0, 24)}/`;
}

export function reconcileConfig(env: InviteReconcileEnv): {
  readonly bucket: InviteReconcileBucket;
  readonly secret: string;
} {
  if (!env.INVITE_PRIVATE_OBJECTS || !env.SITE_CORE_HMAC_SECRET)
    throw new InviteReconciliationError("configuration");
  return { bucket: env.INVITE_PRIVATE_OBJECTS, secret: env.SITE_CORE_HMAC_SECRET };
}

export async function readMarker(
  object: MarkerObject,
  env: InviteReconcileEnv,
): Promise<InvitePrivateReconciliationMarker | null> {
  const secret = env.SITE_CORE_HMAC_SECRET;
  if (!secret) return null;
  try {
    const parsedJson: unknown = JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));
    const parsed = markerSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.teamId !== env.SLACK_TEAM_ID) return null;
    if (!(await verify(JSON.stringify(unsigned(parsed.data)), parsed.data.signature, secret)))
      return null;
    return object.key === (await markerKey(parsed.data.teamId, parsed.data.requestId))
      ? parsed.data
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function updateMarker(
  bucket: InviteReconcileBucket,
  key: string,
  etag: string,
  payload: UnsignedMarker,
  secret: string,
): Promise<{ readonly etag: string } | null> {
  return bucket.put(key, encoded(JSON.stringify(await signedMarker(payload, secret))), {
    onlyIf: { etagMatches: etag },
  });
}

export function retryPayload(
  marker: InvitePrivateReconciliationMarker,
  now: number,
): UnsignedMarker {
  const dead = marker.attempts >= MAX_RECONCILE_ATTEMPTS;
  return {
    ...unsigned(marker),
    status: dead ? "dead_letter" : "pending",
    nextAttemptAt: new Date(now + Math.min(marker.attempts * 60_000, 15 * 60_000)).toISOString(),
    claimToken: null,
    claimUntil: null,
  };
}
