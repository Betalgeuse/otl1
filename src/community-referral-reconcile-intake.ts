import {
  encoded,
  type InviteReconcileEnv,
  InviteReconciliationError,
  markerKey,
  reconcileConfig,
  reconciliationDigest,
  signedMarker,
} from "./community-referral-reconcile-marker";

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
