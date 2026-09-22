import { z } from "zod";
import {
  deleteInterestPrivateObject,
  prepareInterestPrivateObject,
  putPreparedInterestPrivateObject,
} from "./community-interest-private";
import type { CommunityInterestStore } from "./community-interest-store";
import { INTEREST_CONSENT_VERSION } from "./community-interest-types";
import type { InviteReconcileBucket } from "./community-referral-reconcile";
import { digestNormalizedInviteEmail } from "./community-referral-token";
import { inviteEmailSchema } from "./community-referral-types";
import { sign, verify } from "./signing";

const submitSchema = z
  .object({
    submissionKey: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/),
    consentVersion: z.literal(INTEREST_CONSENT_VERSION),
    consentedAt: z.string().datetime({ offset: true }),
    inviteConsentAccepted: z.literal(true),
    inviteConsentedAt: z.string().datetime({ offset: true }),
    email: inviteEmailSchema,
    displayName: z.string().trim().min(1).max(80),
    intent: z.string().trim().min(1).max(1000),
    knownMemberClue: z.string().trim().max(200).optional(),
    shareNameEmailWithIntroducer: z.boolean(),
  })
  .strict();
const withdrawSchema = z
  .object({
    receiptId: z.string().regex(/^INT-[A-Z0-9-]{4,64}$/),
    withdrawalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    withdrawalKey: z.string().regex(/^[A-Za-z0-9_-]{8,120}$/),
  })
  .strict();

type InterestIntakeStore = Pick<CommunityInterestStore, "submit" | "withdraw"> & {
  claimServiceNonce(digest: string, expiresAt: string): Promise<boolean>;
};
export type InterestIntakeEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly SITE_CORE_HMAC_SECRET?: string;
  readonly INVITE_EMAIL_PEPPER?: string;
  readonly INVITE_PRIVATE_KEK?: string;
  readonly INVITE_PRIVATE_KEK_VERSION?: string;
  readonly INVITE_PRIVATE_OBJECTS?: InviteReconcileBucket;
};

const encoded = (text: string): ArrayBuffer =>
  Uint8Array.from(new TextEncoder().encode(text)).buffer;
const hex = (value: ArrayBuffer): string =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
const base64url = (value: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const sha = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoded(text)));

async function hmac(secret: string, text: string): Promise<ArrayBuffer> {
  const raw = Uint8Array.from(
    atob(
      secret.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (secret.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
  if (raw.byteLength !== 32) throw new Error("Interest secret unavailable");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", key, encoded(text));
}

async function authenticate(
  request: Request,
  body: string,
  env: InterestIntakeEnv,
  store: InterestIntakeStore,
): Promise<boolean> {
  const timestampText = request.headers.get("x-otl-timestamp") ?? "";
  const nonce = request.headers.get("x-otl-nonce") ?? "";
  const signature = request.headers.get("x-otl-signature") ?? "";
  const timestamp = Number(timestampText);
  const secret = env.SITE_CORE_HMAC_SECRET;
  if (
    !secret ||
    !/^\d{10}$/.test(timestampText) ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature) ||
    Math.abs(Date.now() / 1000 - timestamp) > 300
  )
    return false;
  const canonical = [
    request.method,
    new URL(request.url).pathname,
    await sha(body),
    timestampText,
    nonce,
  ].join("\n");
  if (!(await verify(canonical, signature, secret))) return false;
  return store.claimServiceNonce(
    await sha(`interest:${timestampText}:${nonce}`),
    new Date((timestamp + 300) * 1000).toISOString(),
  );
}

export async function handleInterestIntakeRequest(
  request: Request,
  env: InterestIntakeEnv,
  store: InterestIntakeStore,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (
    request.method !== "POST" ||
    !["/internal/interest/submit", "/internal/interest/withdraw"].includes(path)
  )
    return new Response("Not found", { status: 404 });
  if (Number(request.headers.get("content-length")) > 8192)
    return new Response("Request too large", { status: 413 });
  const body = await request.text();
  if (encoded(body).byteLength > 8192) return new Response("Request too large", { status: 413 });
  if (!(await authenticate(request, body, env, store)))
    return new Response("Unauthorized", { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError)
      return Response.json({ error: "invalid_request" }, { status: 400 });
    throw error;
  }
  if (path.endsWith("/withdraw")) {
    const input = withdrawSchema.safeParse(parsed);
    if (!input.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      const result = await store.withdraw({
        teamId: env.SLACK_TEAM_ID,
        receiptId: input.data.receiptId,
        withdrawalDigest: await sha(input.data.withdrawalToken),
        key: input.data.withdrawalKey,
        now: new Date().toISOString(),
      });
      return Response.json({ receiptId: result.receiptId }, { status: 202 });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
  }
  const input = submitSchema.safeParse(parsed);
  if (
    !input.success ||
    Date.parse(input.data.consentedAt) > Date.now() + 30_000 ||
    Date.parse(input.data.inviteConsentedAt) > Date.now() + 30_000
  )
    return Response.json({ error: "invalid_request" }, { status: 400 });
  const secret = env.INVITE_EMAIL_PEPPER;
  if (
    !secret ||
    !env.INVITE_PRIVATE_OBJECTS ||
    !env.INVITE_PRIVATE_KEK ||
    !env.INVITE_PRIVATE_KEK_VERSION ||
    !env.SITE_CORE_HMAC_SECRET
  )
    return Response.json({ error: "unavailable" }, { status: 503 });
  const normalized = input.data;
  const emailDigest = await digestNormalizedInviteEmail(normalized.email, secret);
  const contentDigest = hex(
    await hmac(
      secret,
      JSON.stringify([
        "interest-content-v1",
        normalized.email,
        normalized.displayName,
        normalized.intent,
        normalized.knownMemberClue ?? "",
        normalized.consentVersion,
        normalized.inviteConsentAccepted,
        normalized.shareNameEmailWithIntroducer,
      ]),
    ),
  );
  const withdrawalToken = base64url(
    await hmac(
      secret,
      JSON.stringify([
        "interest-withdraw-v1",
        env.SLACK_TEAM_ID,
        normalized.submissionKey,
        contentDigest,
      ]),
    ),
  );
  const interestId = `IREQ-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const receiptId = `INT-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const config = {
    bucket: env.INVITE_PRIVATE_OBJECTS,
    kek: env.INVITE_PRIVATE_KEK,
    keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
  };
  const prepared = await prepareInterestPrivateObject(config, interestId, 0, {
    email: normalized.email,
    displayName: normalized.displayName,
    intent: normalized.intent,
    ...(normalized.knownMemberClue === undefined
      ? {}
      : { knownMemberClue: normalized.knownMemberClue }),
  });
  const markerKey = `interest-private-reconcile/v1/${await sha(env.SLACK_TEAM_ID)}/${interestId}.json`;
  const marker = JSON.stringify({
    interestId,
    submissionKeyDigest: hex(
      await hmac(secret, `interest-submission-key-v1\n${normalized.submissionKey}`),
    ),
    objectDigest: prepared.ref.objectDigest,
    opaqueRef: prepared.ref.opaqueRef,
    createdAt: new Date().toISOString(),
    status: "pending",
  });
  const signedMarker = JSON.stringify({
    marker,
    signature: await sign(marker, env.SITE_CORE_HMAC_SECRET),
  });
  const created = await env.INVITE_PRIVATE_OBJECTS.put(markerKey, encoded(signedMarker), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!created) return Response.json({ error: "unavailable" }, { status: 503 });
  await putPreparedInterestPrivateObject(config, prepared);
  const submission = {
    teamId: env.SLACK_TEAM_ID,
    interestId,
    receiptId,
    emailDigest,
    contentDigest,
    withdrawalDigest: await sha(withdrawalToken),
    consentVersion: INTEREST_CONSENT_VERSION,
    consentedAt: normalized.consentedAt,
    inviteConsentAccepted: true as const,
    inviteConsentedAt: normalized.inviteConsentedAt,
    shareNameEmailWithIntroducer: normalized.shareNameEmailWithIntroducer,
    key: normalized.submissionKey,
    now: new Date().toISOString(),
    privateRef: prepared.ref,
  };
  try {
    const result = await store.submit(submission);
    if (!result.created) await deleteInterestPrivateObject(config, prepared.ref.opaqueRef);
    await env.INVITE_PRIVATE_OBJECTS.delete(markerKey);
    return Response.json(
      result.created || result.sameSubmissionKey
        ? { receiptId: result.receiptId, withdrawalToken }
        : { receiptId: result.receiptId },
      { status: 202 },
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
