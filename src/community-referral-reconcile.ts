import {
  type InvitePrivateReconciliationMarker,
  type InviteReconcileBucket,
  type InviteReconcileEnv,
  MAX_RECONCILE_ATTEMPTS,
  markerPrefix,
  readMarker,
  reconcileConfig,
  reconciliationDigest,
  retryPayload,
  signedMarker,
  type UnsignedMarker,
  unsigned,
  updateMarker,
} from "./community-referral-reconcile-marker";
import type { ReferralRuntimeStore } from "./community-referral-types";

export type {
  InviteReconcileBucket,
  InviteReconcileEnv,
} from "./community-referral-reconcile-marker";

const PAGE_SIZE = 50;
const MAX_PAGES_PER_RUN = 10;
const MAX_CLAIMS_PER_RUN = 10;

export const INVITE_PRIVATE_RECONCILIATION_CAPABILITIES = {
  callable: "reconcileInvitePrivateIntake",
  nextDue: "nextInvitePrivateReconciliationDue",
  schedulerOwner: "Todo11",
} as const;

export {
  clearInvitePrivateReconciliationMarker,
  createInvitePrivateReconciliationMarker,
} from "./community-referral-reconcile-intake";

type ReconcileCounts = {
  claimed: number;
  adopted: number;
  deleted: number;
  retried: number;
  deadLettered: number;
  tampered: number;
  possiblyMore: boolean;
  nextCursor: string | null;
};

async function finishRetry(
  bucket: InviteReconcileBucket,
  key: string,
  etag: string,
  marker: InvitePrivateReconciliationMarker,
  secret: string,
  now: number,
  counts: ReconcileCounts,
): Promise<void> {
  const retry = retryPayload(marker, now);
  await updateMarker(bucket, key, etag, retry, secret);
  if (retry.status === "dead_letter") counts.deadLettered += 1;
  else counts.retried += 1;
}

export async function reconcileInvitePrivateIntake(
  env: InviteReconcileEnv,
  store: Pick<ReferralRuntimeStore, "findPrivateIntake">,
  now = Date.now(),
  startCursor?: string,
): Promise<Readonly<ReconcileCounts>> {
  const ready = reconcileConfig(env);
  const prefix = await markerPrefix(env.SLACK_TEAM_ID);
  const counts: ReconcileCounts = {
    claimed: 0,
    adopted: 0,
    deleted: 0,
    retried: 0,
    deadLettered: 0,
    tampered: 0,
    possiblyMore: false,
    nextCursor: null,
  };
  let cursor = startCursor;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const listed = await ready.bucket.list({
      prefix,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of listed.objects) {
      if (counts.claimed >= MAX_CLAIMS_PER_RUN) {
        counts.possiblyMore = true;
        counts.nextCursor = cursor ?? null;
        return counts;
      }
      cursor = entry.key;
      const object = await ready.bucket.get(entry.key);
      if (!object) continue;
      const marker = await readMarker(object, env);
      if (!marker) {
        counts.tampered += 1;
        continue;
      }
      const due =
        marker.status === "pending"
          ? Date.parse(marker.nextAttemptAt)
          : Date.parse(marker.claimUntil ?? "");
      if (marker.status === "dead_letter" || !Number.isFinite(due) || due > now) continue;
      if (marker.attempts >= MAX_RECONCILE_ATTEMPTS) {
        const dead = retryPayload(marker, now);
        const updated = await updateMarker(
          ready.bucket,
          entry.key,
          object.etag,
          dead,
          ready.secret,
        );
        if (updated) counts.deadLettered += 1;
        continue;
      }
      const claimedPayload: UnsignedMarker = {
        ...unsigned(marker),
        attempts: marker.attempts + 1,
        status: "claimed",
        claimToken: crypto.randomUUID(),
        claimUntil: new Date(now + 60_000).toISOString(),
      };
      const claimed = await updateMarker(
        ready.bucket,
        entry.key,
        object.etag,
        claimedPayload,
        ready.secret,
      );
      if (!claimed) continue;
      counts.claimed += 1;
      const claimedMarker = await signedMarker(claimedPayload, ready.secret);
      try {
        const state = await store.findPrivateIntake(
          marker.teamId,
          marker.requestId,
          marker.objectDigest,
        );
        if (state === "adopted") {
          await ready.bucket.delete(entry.key);
          counts.adopted += 1;
          continue;
        }
        if (state === "absent" && now >= Date.parse(marker.orphanExpiresAt)) {
          const privateObject = await ready.bucket.get(marker.opaqueRef);
          if (
            !privateObject ||
            (await reconciliationDigest(await privateObject.arrayBuffer())) === marker.objectDigest
          ) {
            if (privateObject) await ready.bucket.delete(marker.opaqueRef);
            await ready.bucket.delete(entry.key);
            counts.deleted += 1;
            continue;
          }
        }
        await finishRetry(
          ready.bucket,
          entry.key,
          claimed.etag,
          claimedMarker,
          ready.secret,
          now,
          counts,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        await finishRetry(
          ready.bucket,
          entry.key,
          claimed.etag,
          claimedMarker,
          ready.secret,
          now,
          counts,
        );
      }
    }
    if (!listed.truncated) return counts;
    cursor = listed.cursor ?? cursor;
  }
  counts.possiblyMore = true;
  counts.nextCursor = cursor ?? null;
  return counts;
}

export async function nextInvitePrivateReconciliationDue(
  env: InviteReconcileEnv,
): Promise<string | null> {
  const ready = reconcileConfig(env);
  const prefix = await markerPrefix(env.SLACK_TEAM_ID);
  let cursor: string | undefined;
  let due: number | null = null;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
    const listed = await ready.bucket.list({
      prefix,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of listed.objects) {
      const object = await ready.bucket.get(entry.key);
      if (!object) continue;
      const marker = await readMarker(object, env);
      if (!marker || marker.status === "dead_letter") continue;
      const candidate = Date.parse(
        marker.status === "claimed"
          ? (marker.claimUntil ?? marker.nextAttemptAt)
          : marker.nextAttemptAt,
      );
      if (Number.isFinite(candidate) && (due === null || candidate < due)) due = candidate;
    }
    if (!listed.truncated) return due === null ? null : new Date(due).toISOString();
    cursor = listed.cursor ?? listed.objects.at(-1)?.key;
    if (!cursor) break;
  }
  return new Date(due ?? Date.now() + 5 * 60_000).toISOString();
}
