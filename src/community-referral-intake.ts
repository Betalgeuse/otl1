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
import { digestNormalizedInviteEmail, digestReferralToken } from "./community-referral-token";
import {
  INVITE_CONSENT_VERSION,
  type ReferralRuntimeStore,
  referralApplicationSchema,
} from "./community-referral-types";
import { sign, verify } from "./signing";

const INTAKE_PATH = "/internal/referrals/apply" as const;
const AUTH_WINDOW_SECONDS = 300;

export type ReferralIntakeEnv = {
  readonly SITE_CORE_HMAC_SECRET?: string;
  readonly SLACK_TEAM_ID: string;
  readonly INVITE_EMAIL_PEPPER?: string;
  readonly INVITE_PRIVATE_OBJECTS?: InviteReconcileBucket;
  readonly INVITE_PRIVATE_KEK?: string;
  readonly INVITE_PRIVATE_KEK_VERSION?: string;
};

type SignedInput = {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: number;
  readonly nonce: string;
};

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function canonical(input: SignedInput): Promise<string> {
  return [
    input.method.toUpperCase(),
    input.path,
    await sha256(input.body),
    String(input.timestamp),
    input.nonce,
  ].join("\n");
}

export async function signReferralServiceRequest(
  input: SignedInput,
  secret: string,
): Promise<string> {
  return sign(await canonical(input), secret);
}

async function authenticate(
  request: Request,
  body: string,
  secret: string | undefined,
  store: ReferralRuntimeStore,
): Promise<boolean> {
  const timestampValue = request.headers.get("x-otl-timestamp") ?? "";
  const nonce = request.headers.get("x-otl-nonce") ?? "";
  const signature = request.headers.get("x-otl-signature") ?? "";
  const timestamp = Number(timestampValue);
  if (
    !secret ||
    !/^\d{10}$/.test(timestampValue) ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature) ||
    Math.abs(Date.now() / 1000 - timestamp) > AUTH_WINDOW_SECONDS
  )
    return false;
  const input = {
    method: request.method,
    path: new URL(request.url).pathname,
    body,
    timestamp,
    nonce,
  };
  if (!(await verify(await canonical(input), signature, secret))) return false;
  const nonceDigest = await sha256(`${timestampValue}:${nonce}`);
  return store.claimServiceNonce(
    nonceDigest,
    new Date((timestamp + AUTH_WINDOW_SECONDS) * 1000).toISOString(),
  );
}

function identity(prefix: "REQ" | "RCP"): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
}

async function withdrawalDigest(): Promise<string> {
  return sha256(crypto.randomUUID());
}

export async function handleReferralIntakeRequest(
  request: Request,
  env: ReferralIntakeEnv,
  store: ReferralRuntimeStore,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== INTAKE_PATH)
    return new Response("Not found", { status: 404 });
  if (Number(request.headers.get("content-length") ?? "0") > 8192)
    return new Response("Request too large", { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 8192)
    return new Response("Request too large", { status: 413 });
  if (!(await authenticate(request, body, env.SITE_CORE_HMAC_SECRET, store)))
    return new Response("Unauthorized", { status: 401 });
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError)
      return Response.json({ error: "invalid_request" }, { status: 400 });
    throw error;
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
  const submission = {
    teamId: env.SLACK_TEAM_ID,
    tokenDigest: await digestReferralToken(application.data.referralToken),
    emailDigest: await digestNormalizedInviteEmail(
      application.data.email,
      env.INVITE_EMAIL_PEPPER ?? "",
    ),
    requestId,
    receiptId,
    withdrawalDigest: await withdrawalDigest(),
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
  return Response.json({ receiptId: result.receiptId }, { status: 202 });
}
