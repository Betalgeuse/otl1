import { alertDeadMarker, type Marker, updateMarker } from "./community-interest-dead-alert";
import { CommunityInterestStore } from "./community-interest-store";
import type { CommunityEnv } from "./community-runtime";
import { verify } from "./signing";
import { NeonStore } from "./store";

const shaBytes = async (bytes: BufferSource): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const sha = async (text: string): Promise<string> => shaBytes(new TextEncoder().encode(text));

function marker(value: unknown): Marker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = Object.fromEntries(Object.entries(value));
  if (
    typeof row.interestId !== "string" ||
    !/^IREQ-[A-Z0-9-]{4,64}$/.test(row.interestId) ||
    typeof row.submissionKeyDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.submissionKeyDigest) ||
    typeof row.objectDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.objectDigest) ||
    typeof row.opaqueRef !== "string" ||
    !row.opaqueRef.startsWith(`interest-private/${row.interestId}/revision-0-`) ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    (row.status !== "pending" && row.status !== "dead") ||
    (row.alertStatus !== undefined &&
      row.alertStatus !== "alert_pending" &&
      row.alertStatus !== "alerted") ||
    (row.alertStartedAt !== undefined &&
      (typeof row.alertStartedAt !== "string" ||
        !Number.isFinite(Date.parse(row.alertStartedAt)))) ||
    (row.alertLeaseUntil !== undefined &&
      (typeof row.alertLeaseUntil !== "string" ||
        !Number.isFinite(Date.parse(row.alertLeaseUntil)))) ||
    (row.alertedAt !== undefined &&
      (typeof row.alertedAt !== "string" || !Number.isFinite(Date.parse(row.alertedAt))))
  )
    return null;
  return {
    interestId: row.interestId,
    submissionKeyDigest: row.submissionKeyDigest,
    objectDigest: row.objectDigest,
    opaqueRef: row.opaqueRef,
    createdAt: row.createdAt,
    status: row.status,
    ...(row.alertStatus === undefined ? {} : { alertStatus: row.alertStatus }),
    ...(row.alertStartedAt === undefined ? {} : { alertStartedAt: row.alertStartedAt }),
    ...(row.alertLeaseUntil === undefined ? {} : { alertLeaseUntil: row.alertLeaseUntil }),
    ...(row.alertedAt === undefined ? {} : { alertedAt: row.alertedAt }),
  };
}

export async function reconcileInterestIntake(
  env: CommunityEnv,
  now = Date.now(),
  startCursor?: string,
): Promise<{
  readonly processed: number;
  readonly possiblyMore: boolean;
  readonly nextCursor: string | null;
  readonly retryNeeded: boolean;
}> {
  if (env.DATABASE_MAINTENANCE === "true")
    return { processed: 0, possiblyMore: false, nextCursor: null, retryNeeded: false };
  if (
    !env.INVITE_PRIVATE_OBJECTS ||
    !env.INTEREST_RUNTIME_DATABASE_URL ||
    !env.SITE_CORE_HMAC_SECRET
  )
    throw new Error("Interest reconciliation unavailable");
  const store = new CommunityInterestStore(new NeonStore(env.INTEREST_RUNTIME_DATABASE_URL));
  const bucket = env.INVITE_PRIVATE_OBJECTS;
  const prefix = `interest-private-reconcile/v1/${await sha(env.SLACK_TEAM_ID)}/`;
  let processed = 0;
  let retryNeeded = false;
  let cursor: string | undefined = startCursor;
  for (let page = 0; page < 5; page += 1) {
    const list = await bucket.list({ prefix, limit: 2, ...(cursor ? { cursor } : {}) });
    for (const entry of list.objects) {
      if (processed >= 2)
        return { processed, possiblyMore: true, nextCursor: cursor ?? null, retryNeeded };
      const stored = await bucket.get(entry.key);
      if (!stored) continue;
      let wrapper: unknown;
      try {
        wrapper = JSON.parse(new TextDecoder().decode(await stored.arrayBuffer()));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (typeof wrapper !== "object" || wrapper === null || Array.isArray(wrapper)) continue;
      const signed = Object.fromEntries(Object.entries(wrapper));
      if (
        typeof signed.marker !== "string" ||
        typeof signed.signature !== "string" ||
        !(await verify(signed.marker, signed.signature, env.SITE_CORE_HMAC_SECRET))
      )
        continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(signed.marker);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      const value = marker(decoded);
      if (!value || entry.key !== `${prefix}${value.interestId}.json`) continue;
      if (value.status === "dead") {
        if (value.alertStatus === "alerted") continue;
        try {
          const alertRetry = await alertDeadMarker(env, bucket, entry.key, stored, value, now);
          retryNeeded ||= alertRetry;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          retryNeeded = true;
          console.error(
            JSON.stringify({
              event: "interest.reconcile.alert.failed",
              interestId: value.interestId,
              errorType: error.name,
            }),
          );
        }
        processed += 1;
        continue;
      }
      const deadLetter = async (): Promise<void> => {
        const dead: Marker = {
          ...value,
          status: "dead",
          alertStatus: "alert_pending",
          alertStartedAt: new Date(now).toISOString(),
        };
        const changed = await updateMarker(
          bucket,
          entry.key,
          stored.etag,
          dead,
          env.SITE_CORE_HMAC_SECRET ?? "",
        );
        if (!changed) return;
        console.error(
          JSON.stringify({ event: "interest.reconcile.dead", interestId: value.interestId }),
        );
        processed += 1;
        try {
          const alertRetry = await alertDeadMarker(env, bucket, entry.key, changed, dead, now);
          retryNeeded ||= alertRetry;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          retryNeeded = true;
          console.error(
            JSON.stringify({
              event: "interest.reconcile.alert.failed",
              interestId: value.interestId,
              errorType: error.name,
            }),
          );
        }
      };
      const state = await store.findPrivateIntake(
        env.SLACK_TEAM_ID,
        value.interestId,
        value.objectDigest,
      );
      if (state === "conflict") {
        await deadLetter();
      } else if (state === "adopted") {
        await bucket.delete(entry.key);
        processed += 1;
      } else if (state === "absent" && now >= Date.parse(value.createdAt) + 15 * 60_000) {
        const object = await bucket.get(value.opaqueRef);
        if (object && (await shaBytes(await object.arrayBuffer())) !== value.objectDigest) {
          await deadLetter();
          continue;
        }
        if (object) await bucket.delete(value.opaqueRef);
        await bucket.delete(entry.key);
        processed += 1;
      }
    }
    if (!list.truncated) return { processed, possiblyMore: false, nextCursor: null, retryNeeded };
    if (!list.cursor) throw new Error("Interest reconciliation cursor unavailable");
    cursor = list.cursor;
    if (processed >= 2) return { processed, possiblyMore: true, nextCursor: cursor, retryNeeded };
  }
  return { processed, possiblyMore: true, nextCursor: cursor ?? null, retryNeeded };
}
