import {
  deleteInvitePrivateObject,
  prepareInvitePrivateObject,
  putPreparedInvitePrivateObject,
} from "./community-invite-private";
import {
  clearInvitePrivateReconciliationMarker,
  createInvitePrivateReconciliationMarker,
  type InviteReconcileBucket,
} from "./community-referral-reconcile";
import { authenticateReferralServiceRequest, sha256Hex } from "./community-referral-service-auth";

export { signReferralServiceRequest } from "./community-referral-service-auth";

import { digestNormalizedInviteEmail, digestReferralToken } from "./community-referral-token";
import {
  directReferralJoinSchema,
  INVITE_CONSENT_VERSION,
  type ReferralRuntimeStore,
  referralApplicationSchema,
} from "./community-referral-types";
import { handleReferralWithdrawal } from "./community-referral-withdraw";

const INTAKE_PATH = "/internal/referrals/apply" as const;
const WITHDRAW_PATH = "/internal/referrals/withdraw" as const;
const RESOLVE_PATH = "/internal/referrals/resolve" as const;
const DIRECT_JOIN_PATH = "/internal/referrals/direct-join" as const;

export type ReferralIntakeEnv = {
  readonly SITE_CORE_HMAC_SECRET?: string;
  readonly SLACK_TEAM_ID: string;
  readonly INVITE_EMAIL_PEPPER?: string;
  readonly INVITE_PRIVATE_OBJECTS?: InviteReconcileBucket;
  readonly INVITE_PRIVATE_KEK?: string;
  readonly INVITE_PRIVATE_KEK_VERSION?: string;
};

function identity(prefix: "REQ" | "RCP"): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function withdrawalCapability(): Promise<{
  readonly token: string;
  readonly digest: string;
}> {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, digest: await sha256Hex(token) };
}

export async function handleReferralIntakeRequest(
  request: Request,
  env: ReferralIntakeEnv,
  store: ReferralRuntimeStore,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    (url.pathname !== INTAKE_PATH &&
      url.pathname !== WITHDRAW_PATH &&
      url.pathname !== RESOLVE_PATH &&
      url.pathname !== DIRECT_JOIN_PATH)
  )
    return new Response("Not found", { status: 404 });
  if (Number(request.headers.get("content-length") ?? "0") > 8192)
    return new Response("Request too large", { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 8192)
    return new Response("Request too large", { status: 413 });
  if (
    !(await authenticateReferralServiceRequest({
      request,
      body,
      secret: env.SITE_CORE_HMAC_SECRET,
      store,
      persistNonce: url.pathname !== RESOLVE_PATH,
    }))
  )
    return new Response("Unauthorized", { status: 401 });
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError)
      return Response.json({ error: "invalid_request" }, { status: 400 });
    throw error;
  }
  if (url.pathname === RESOLVE_PATH) {
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("referralToken" in decoded) ||
      typeof decoded.referralToken !== "string" ||
      !/^[A-Za-z0-9_-]{32}$/.test(decoded.referralToken) ||
      Object.keys(decoded).length !== 1
    )
      return Response.json({ available: false });
    const resolved = await store.resolveLink(
      env.SLACK_TEAM_ID,
      await digestReferralToken(decoded.referralToken),
    );
    return Response.json(resolved.available ? resolved : { available: false });
  }
  if (url.pathname === WITHDRAW_PATH) {
    return handleReferralWithdrawal(decoded, env.SLACK_TEAM_ID, store);
  }
  if (url.pathname === DIRECT_JOIN_PATH) {
    const direct = directReferralJoinSchema.safeParse(decoded);
    if (!direct.success || Date.parse(direct.data.consentedAt) > Date.now() + 30_000)
      return Response.json({ error: "invalid_request" }, { status: 400 });
    if (!env.INVITE_EMAIL_PEPPER) return Response.json({ error: "unavailable" }, { status: 503 });
    const now = new Date().toISOString();
    const result = await store.startDirectJoin({
      teamId: env.SLACK_TEAM_ID,
      tokenDigest: await digestReferralToken(direct.data.referralToken),
      emailDigest: await digestNormalizedInviteEmail(direct.data.email, env.INVITE_EMAIL_PEPPER),
      requestId: identity("REQ"),
      receiptId: identity("RCP"),
      withdrawalDigest: (await withdrawalCapability()).digest,
      consentVersion: INVITE_CONSENT_VERSION,
      consentedAt: direct.data.consentedAt,
      key: direct.data.submissionKey,
      now,
    });
    return result.kind === "accepted"
      ? Response.json({ accepted: true }, { status: 202 })
      : Response.json({ error: "unavailable" }, { status: 503 });
  }
  const application = referralApplicationSchema.safeParse(decoded);
  if (!application.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (Date.parse(application.data.consentedAt) > Date.now() + 30_000)
    return Response.json({ error: "invalid_request" }, { status: 400 });
  const existing = await store.findSubmission(env.SLACK_TEAM_ID, application.data.submissionKey);
  if (existing) return Response.json({ receiptId: existing.receiptId }, { status: 202 });

  const requestId = identity("REQ");
  const receiptId = identity("RCP");
  const config = {
    bucket: env.INVITE_PRIVATE_OBJECTS,
    kek: env.INVITE_PRIVATE_KEK,
    keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
  };
  const prepared = await prepareInvitePrivateObject(config, requestId, 0, {
    email: application.data.email,
    displayName: application.data.displayName,
    intent: application.data.intent,
  });
  const createdAt = new Date().toISOString();
  const marker = await createInvitePrivateReconciliationMarker(env, {
    requestId,
    submissionKey: application.data.submissionKey,
    objectDigest: prepared.ref.objectDigest,
    opaqueRef: prepared.ref.opaqueRef,
    now: createdAt,
  });
  try {
    await putPreparedInvitePrivateObject(config, prepared);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await clearInvitePrivateReconciliationMarker(env, marker.key);
    throw error;
  }
  const privateRef = prepared.ref;
  const withdrawal = await withdrawalCapability();
  const submission = {
    teamId: env.SLACK_TEAM_ID,
    tokenDigest: await digestReferralToken(application.data.referralToken),
    emailDigest: await digestNormalizedInviteEmail(
      application.data.email,
      env.INVITE_EMAIL_PEPPER ?? "",
    ),
    requestId,
    receiptId,
    withdrawalDigest: withdrawal.digest,
    consentVersion: INVITE_CONSENT_VERSION,
    consentedAt: application.data.consentedAt,
    key: application.data.submissionKey,
    now: createdAt,
    privateRef,
  } as const;
  let result: Awaited<ReturnType<ReferralRuntimeStore["submit"]>>;
  try {
    result = await store.submit(submission);
  } catch (firstError) {
    if (!(firstError instanceof Error)) throw firstError;
    try {
      result = await store.submit(submission);
    } catch (secondError) {
      if (!(secondError instanceof Error)) throw secondError;
      try {
        const reconciled = await store.findSubmission(
          env.SLACK_TEAM_ID,
          application.data.submissionKey,
        );
        if (reconciled) {
          if (reconciled.requestId !== requestId)
            await deleteInvitePrivateObject(config, privateRef.opaqueRef);
          await clearInvitePrivateReconciliationMarker(env, marker.key);
          return Response.json({ receiptId: reconciled.receiptId }, { status: 202 });
        }
        await deleteInvitePrivateObject(config, privateRef.opaqueRef);
        await clearInvitePrivateReconciliationMarker(env, marker.key);
        return Response.json({ error: "unavailable" }, { status: 503 });
      } catch (reconciliationError) {
        if (reconciliationError instanceof Error)
          return Response.json({ error: "unavailable" }, { status: 503 });
        throw reconciliationError;
      }
    }
  }
  if (result.kind === "rejected") {
    await deleteInvitePrivateObject(config, privateRef.opaqueRef);
    await clearInvitePrivateReconciliationMarker(env, marker.key);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  if (result.requestId !== requestId) await deleteInvitePrivateObject(config, privateRef.opaqueRef);
  await clearInvitePrivateReconciliationMarker(env, marker.key);
  return Response.json(
    result.requestId === requestId
      ? { receiptId: result.receiptId, withdrawalToken: withdrawal.token }
      : { receiptId: result.receiptId },
    { status: 202 },
  );
}
