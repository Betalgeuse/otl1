import {
  encoded,
  type InvitePrivateReconciliationMarker,
  type InviteReconcileBucket,
  type InviteReconcileEnv,
  InviteReconciliationError,
  MAX_RECONCILE_ATTEMPTS,
  markerKey,
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

export const INVITE_PRIVATE_RECONCILIATION_CAPABILITIES = {
  callable: "reconcileInvitePrivateIntake",
  nextDue: "nextInvitePrivateReconciliationDue",
  schedulerOwner: "Todo11",
} as const;

export async function createInvitePrivateReconciliationMarker(
  env: InviteReconcileEnv,
  input: {
    readonly requestId: string;
    readonly submissionKey: string;
    readonly objectDigest: string;
    readonly opaqueRef: string;
    readonly now: string;
  },
): Promise<{ readonly key: string }> {
  const ready = reconcileConfig(env);
  const key = await markerKey(env.SLACK_TEAM_ID, input.requestId);
  const marker = await signedMarker(
    {
      version: "invite-private-reconcile.v1",
      teamId: env.SLACK_TEAM_ID,
      requestId: input.requestId,
      requestDigest: await reconciliationDigest(input.submissionKey),
      objectDigest: input.objectDigest,
      opaqueRef: input.opaqueRef,
      createdAt: input.now,
      orphanExpiresAt: new Date(Date.parse(input.now) + 15 * 60_000).toISOString(),
      nextAttemptAt: input.now,
      attempts: 0,
      status: "pending",
      claimToken: null,
      claimUntil: null,
    },
    ready.secret,
  );
  const created = await ready.bucket.put(key, encoded(JSON.stringify(marker)), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!created) throw new InviteReconciliationError("collision");
  return { key };
}

export async function clearInvitePrivateReconciliationMarker(
  env: InviteReconcileEnv,
  key: string,
): Promise<void> {
  const ready = reconcileConfig(env);
  if (!key.startsWith("invite-private-reconcile/v1/"))
    throw new InviteReconciliationError("invalid_key");
  await ready.bucket.delete(key);
}

type ReconcileCounts = {
  claimed: number;
  adopted: number;
  deleted: number;
  retried: number;
  deadLettered: number;
  tampered: number;
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
): Promise<Readonly<ReconcileCounts>> {
  const ready = reconcileConfig(env);
  const listed = await ready.bucket.list({
    prefix: await markerPrefix(env.SLACK_TEAM_ID),
    limit: 50,
  });
  const counts: ReconcileCounts = {
    claimed: 0,
    adopted: 0,
    deleted: 0,
    retried: 0,
    deadLettered: 0,
    tampered: 0,
  };
  for (const entry of listed.objects) {
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
      const updated = await updateMarker(ready.bucket, entry.key, object.etag, dead, ready.secret);
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
  return counts;
}

export async function nextInvitePrivateReconciliationDue(
  env: InviteReconcileEnv,
): Promise<string | null> {
  const ready = reconcileConfig(env);
  const listed = await ready.bucket.list({
    prefix: await markerPrefix(env.SLACK_TEAM_ID),
    limit: 50,
  });
  let due: number | null = null;
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
  return due === null ? null : new Date(due).toISOString();
}
