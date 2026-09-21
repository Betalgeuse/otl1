import assert from "node:assert/strict";
import siteWorker, {
  SHARE_COPY,
  createSiteCoreSignature,
  sealCapability,
  openCapability,
} from "../site/src/index.ts";
import {
  handleReferralIntakeRequest,
  signReferralServiceRequest,
} from "../src/community-referral-intake.ts";

const referralToken = "A".repeat(32);
const receiptId = `RCP-${"B".repeat(32)}`;
const hmacSecret = "site-core-secret-with-enough-entropy-123456";
const turnstileSecret = "turnstile-test-secret";
const expectedShare = `매일 제일 중요한 일 하나 정해서 같이 끝내는 모임이야. 같이 할래?\nhttps://otl1.hyuk.me/r/${referralToken}`;

assert.equal(SHARE_COPY(referralToken), expectedShare);
const realNow = Date.now;
try {
  Date.now = () => realNow() - 31 * 24 * 60 * 60 * 1000;
  const expired = await sealCapability(hmacSecret, receiptId, "X".repeat(43));
  Date.now = realNow;
  assert.equal(await openCapability(hmacSecret, receiptId, expired), null);
  assert.equal(await openCapability(hmacSecret, `RCP-${"C".repeat(32)}`, expired), null);
} finally { Date.now = realNow; }

const assets = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/referral.html") {
      return new Response("<html><body>__REFERRAL_TOKEN__ __TURNSTILE_SITE_KEY__ __SHARE_TEXT__ __SUBMISSION_KEY__ __INVITER_BYLINE__</body></html>", {
        headers: { "content-type": "text/html;charset=UTF-8" },
      });
    }
    if (path === "/receipt.html") {
      return new Response("<html><body>__RECEIPT_ID__</body></html>", {
        headers: { "content-type": "text/html;charset=UTF-8" },
      });
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  },
};

const coreBodies = [];
let resolveName = "홍길동";
const core = {
  async fetch(request) {
    const body = await request.text();
    coreBodies.push({ path: new URL(request.url).pathname, body, headers: Object.fromEntries(request.headers) });
    if (new URL(request.url).pathname.endsWith("resolve")) return Response.json(JSON.parse(body).referralToken === referralToken ? { available: true, inviterName: resolveName } : { available: false });
    if (body.includes("outage@example.com")) throw new Error("core outage");
    if (body.includes("paused@example.com")) return Response.json({ error: "unavailable" }, { status: 503 });
    if (new URL(request.url).pathname.endsWith("withdraw")) return Response.json({ receiptId, state: "withdrawn" }, { status: 202 });
    return Response.json({ accepted: true }, { status: 202 });
  },
};

let rateLimitSuccess = true;
const env = {
  ASSETS: assets,
  CORE: core,
  RATE_LIMITER: { async limit() { return { success: rateLimitSuccess }; } },
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET: turnstileSecret,
  SITE_CORE_HMAC_SECRET: hmacSecret,
  SLACK_SHARED_INVITE_URL: "https://join.slack.com/t/otl1/shared_invite/zt-synthetic-site-intake",
};

const originalFetch = globalThis.fetch;
let verifyMode = "ok";
const siteverifyTrace = [];
const issuedAt = new Map([
  ["synthetic-expired-token", Date.now() - 301_000],
  ["synthetic-one-time-token", Date.now()],
]);
const consumedTokens = new Set();
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(init.method, "POST");
  const siteverifyForm = new URLSearchParams(init.body);
  assert.equal(siteverifyForm.get("secret"), turnstileSecret);
  const token = siteverifyForm.get("response");
  const tokenTime = issuedAt.get(token);
  if (tokenTime !== undefined) {
    const expired = Date.now() - tokenTime > 300_000;
    const reused = consumedTokens.has(token);
    const scenario = expired ? "expired" : reused ? "reused" : "first-use";
    const response = expired || reused
      ? { success: false, "error-codes": ["timeout-or-duplicate"] }
      : { success: true, hostname: "example.com" };
    if (!expired && !reused) consumedTokens.add(token);
    siteverifyTrace.push({ scenario, response });
    return Response.json(response);
  }
  if (verifyMode === "timeout") throw new DOMException("timed out", "TimeoutError");
  if (verifyMode === "invalid") return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
  return Response.json({ success: true, hostname: "example.com" });
};

const call = (path, init = {}) => siteWorker.fetch(new Request(`https://otl1.hyuk.me${path}`, init), env);
const form = (overrides = {}) => {
  const value = new FormData();
  value.set("email", "  PERSON@Example.COM ");
  value.set("consent", "invite-consent-v1");
  value.set("submissionKey", "submission-browser-123456");
  value.set("cf-turnstile-response", "XXXX.DUMMY.TOKEN.XXXX");
  for (const [key, item] of Object.entries(overrides)) value.set(key, item);
  return value;
};

try {
  const page = await call(`/r/${referralToken}`);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, new RegExp(referralToken));
  assert.match(pageText, /1x00000000000000000000AA/);
  assert.match(pageText, /매일 제일 중요한 일 하나 정해서 같이 끝내는 모임이야/);
  assert.match(pageText, /홍길동 님이 같이 성장하자고 소개했어요\./);
  assert.doesNotMatch(pageText, /__INVITER_BYLINE__/);

  resolveName = null;
  assert.match(await (await call(`/r/${referralToken}`)).text(), /지인의 소개로 이곳에 도착했어요\./);
  resolveName = '<script>alert("x")</script>';
  const escapedPage = await (await call(`/r/${referralToken}`)).text();
  assert.doesNotMatch(escapedPage, /<script>alert/);
  assert.match(escapedPage, /&lt;script&gt;/);
  resolveName = "홍길동";

  const invalidSlug = await call("/r/not-enumerable");
  assert.equal(invalidSlug.status, 404);
  const unknownSlug = await call(`/r/${"Z".repeat(32)}`);
  assert.equal(unknownSlug.status, 404);
  assert.doesNotMatch(await unknownSlug.text(), /Z{32}|referrer|inviter/);
  const pausedSlug = await call(`/r/${"Z".repeat(32)}/apply`, { method: "POST", body: form() });
  assert.equal(pausedSlug.status, 404);

  const valid = await call(`/r/${referralToken}/apply`, { method: "POST", body: form() });
  assert.equal(valid.status, 303);
  assert.equal(valid.headers.get("location"), "https://join.slack.com/t/otl1/shared_invite/zt-synthetic-site-intake");
  assert.equal(valid.headers.get("set-cookie"), null);
  const directStarts = coreBodies.filter((entry) => entry.path === "/internal/referrals/direct-join");
  assert.equal(directStarts.length, 1);
  const submitted = JSON.parse(directStarts[0].body);
  assert.deepEqual(
    { email: submitted.email, consentVersion: submitted.consentVersion },
    { email: "person@example.com", consentVersion: "invite-consent-v1" },
  );
  assert.equal("displayName" in submitted, false);
  assert.equal("intent" in submitted, false);
  assert.match(directStarts[0].headers["x-otl-signature"], /^[0-9a-f]{64}$/);

  const genericBodies = [];
  for (const email of ["paused@example.com", "outage@example.com"]) {
    const response = await call(`/r/${referralToken}/apply`, { method: "POST", body: form({ email }) });
    assert.equal(response.status, 503);
    genericBodies.push(await response.text());
  }
  assert.equal(new Set(genericBodies).size, 1);
  assert.doesNotMatch(genericBodies[0], /paused|outage|example\.com|referral/i);

  const countDirectStarts = () => coreBodies.filter((entry) => entry.path === "/internal/referrals/direct-join").length;
  const startCountBeforeTurnstile = countDirectStarts();
  const expiredTurnstile = await call(`/r/${referralToken}/apply`, {
    method: "POST",
    body: form({ "cf-turnstile-response": "synthetic-expired-token", submissionKey: "expired-turnstile-key-1234" }),
  });
  assert.equal(expiredTurnstile.status, 422);
  const expiredFeedback = await expiredTurnstile.text();
  assert.match(expiredFeedback, /요청을 지금 처리할 수 없어요/);
  assert.doesNotMatch(expiredFeedback, /synthetic-expired-token|person@example.com/);
  assert.equal(countDirectStarts(), startCountBeforeTurnstile);

  const oneTimeToken = "synthetic-one-time-token";
  const firstTokenUse = await call(`/r/${referralToken}/apply`, {
    method: "POST",
    body: form({ "cf-turnstile-response": oneTimeToken, submissionKey: "turnstile-first-use-1234" }),
  });
  assert.equal(firstTokenUse.status, 303);
  const startCountAfterFirstUse = countDirectStarts();
  assert.equal(startCountAfterFirstUse, startCountBeforeTurnstile + 1);
  const reusedTurnstile = await call(`/r/${referralToken}/apply`, {
    method: "POST",
    body: form({ "cf-turnstile-response": oneTimeToken, submissionKey: "turnstile-reused-1234" }),
  });
  assert.equal(reusedTurnstile.status, 422);
  const reusedFeedback = await reusedTurnstile.text();
  assert.equal(reusedFeedback, expiredFeedback);
  assert.equal(countDirectStarts(), startCountAfterFirstUse);
  assert.deepEqual(siteverifyTrace, [
    { scenario: "expired", response: { success: false, "error-codes": ["timeout-or-duplicate"] } },
    { scenario: "first-use", response: { success: true, hostname: "example.com" } },
    { scenario: "reused", response: { success: false, "error-codes": ["timeout-or-duplicate"] } },
  ]);
  console.log(`SITEVERIFY_NEGATIVE_OBSERVABLES=${JSON.stringify({ expiredStatus: expiredTurnstile.status, firstUseStatus: firstTokenUse.status, reusedStatus: reusedTurnstile.status, safeFeedback: expiredFeedback === reusedFeedback && expiredFeedback.includes("요청을 지금 처리할 수 없어요"), coreStartDelta: startCountAfterFirstUse - startCountBeforeTurnstile, rejectedCoreStartDelta: countDirectStarts() - startCountAfterFirstUse, trace: siteverifyTrace })}`);

  verifyMode = "invalid";
  assert.equal((await call(`/r/${referralToken}/apply`, { method: "POST", body: form() })).status, 422);
  verifyMode = "timeout";
  assert.equal((await call(`/r/${referralToken}/apply`, { method: "POST", body: form() })).status, 503);
  verifyMode = "ok";

  for (const invalid of [{ consent: "" }, { email: "not-an-email" }]) {
    const response = await call(`/r/${referralToken}/apply`, { method: "POST", body: form(invalid) });
    assert.equal(response.status, 422);
    assert.doesNotMatch(await response.text(), /not-an-email/);
  }

  rateLimitSuccess = false;
  assert.equal((await call(`/r/${referralToken}/apply`, { method: "POST", body: form() })).status, 429);
  assert.equal((await call(`/r/${referralToken}`)).status, 429);
  rateLimitSuccess = true;

  const canonicalBody = JSON.stringify({ ok: true });
  const signed = await createSiteCoreSignature("POST", "/internal/referrals/direct-join", canonicalBody, 1_700_000_000, "nonce-browser-123456");
  const expected = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/direct-join", body: canonicalBody, timestamp: 1_700_000_000, nonce: "nonce-browser-123456" }, hmacSecret);
  assert.equal(await signed(hmacSecret), expected);
} finally {
  globalThis.fetch = originalFetch;
}

// Core one-time withdrawal capability and replay/cross-request denial.
class CoreStore {
  nonces = new Set();
  submissions = new Map();
  withdrawals = 0;
  withdrawalEvents = new Map();
  async claimServiceNonce(digest) { if (this.nonces.has(digest)) return false; this.nonces.add(digest); return true; }
  async resolveLink(_teamId, tokenDigest) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(referralToken));
    return tokenDigest === Buffer.from(bytes).toString("hex") ? { available: true, inviterName: "홍길동" } : { available: false, inviterName: null };
  }
  async findSubmission(_teamId, key) { return this.submissions.get(key)?.receipt ?? null; }
  async findPrivateIntake() { return "absent"; }
  async submit(input) {
    const receipt = { kind: "receipt", receiptId: input.receiptId, requestId: input.requestId, state: "pending", revision: 0 };
    this.submissions.set(input.key, { receipt, withdrawalDigest: input.withdrawalDigest });
    return receipt;
  }
  async withdraw(input) {
    const prior = this.withdrawalEvents.get(input.key);
    if (prior) return prior.input.receiptId === input.receiptId && prior.input.withdrawalDigest === input.withdrawalDigest ? prior.receipt : { kind: "rejected" };
    const found = [...this.submissions.values()].find((entry) => entry.receipt.receiptId === input.receiptId && entry.withdrawalDigest === input.withdrawalDigest);
    if (!found || found.receipt.state !== "pending") return { kind: "rejected" };
    this.withdrawals += 1;
    found.receipt = { ...found.receipt, state: "withdrawn", revision: 1 };
    this.withdrawalEvents.set(input.key, { input, receipt: found.receipt });
    return found.receipt;
  }
}

const coreStore = new CoreStore();
const bucket = {
  objects: new Map(),
  async put(key, value) { this.objects.set(key, { value, etag: key }); return { etag: key }; },
  async get(key) { const item = this.objects.get(key); return item ? { key, etag: item.etag, arrayBuffer: async () => item.value } : null; },
  async delete(key) { this.objects.delete(key); },
  async list() { return { objects: [], truncated: false }; },
};
const coreEnv = {
  SITE_CORE_HMAC_SECRET: hmacSecret,
  SLACK_TEAM_ID: "TQA",
  INVITE_EMAIL_PEPPER: Buffer.alloc(32, 1).toString("base64url"),
  INVITE_PRIVATE_OBJECTS: bucket,
  INVITE_PRIVATE_KEK: Buffer.alloc(32, 2).toString("base64url"),
  INVITE_PRIVATE_KEK_VERSION: "invite-kek-v1",
};
const signedCore = async (path, body, nonce) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signReferralServiceRequest({ method: "POST", path, body, timestamp, nonce }, hmacSecret);
  return handleReferralIntakeRequest(new Request(`https://core.invalid${path}`, {
    method: "POST",
    headers: { "x-otl-timestamp": String(timestamp), "x-otl-nonce": nonce, "x-otl-signature": signature },
    body,
  }), coreEnv, coreStore);
};
const resolved = await signedCore("/internal/referrals/resolve", JSON.stringify({ referralToken }), "nonce-core-resolve-1234");
assert.deepEqual(await resolved.json(), { available: true, inviterName: "홍길동" });
assert.equal((await signedCore("/internal/referrals/resolve", JSON.stringify({ referralToken }), "nonce-core-resolve-1234")).status, 401);
const unavailable = await signedCore("/internal/referrals/resolve", JSON.stringify({ referralToken: "Z".repeat(32) }), "nonce-core-resolve-5678");
assert.deepEqual(await unavailable.json(), { available: false });
const applyBody = JSON.stringify({ referralToken, submissionKey: "core-withdraw-apply", consentVersion: "invite-consent-v1", consentedAt: new Date().toISOString(), email: "withdraw@example.com", displayName: "철회", intent: "철회 시험" });
const applied = await signedCore("/internal/referrals/apply", applyBody, "nonce-core-apply-1234");
assert.equal(applied.status, 202);
const capability = await applied.json();
assert.match(capability.withdrawalToken, /^[A-Za-z0-9_-]{43}$/);
const withdrawalBody = JSON.stringify({ receiptId: capability.receiptId, withdrawalToken: capability.withdrawalToken, withdrawalKey: "core-withdraw-key-1234" });
assert.equal((await signedCore("/internal/referrals/withdraw", withdrawalBody, "nonce-core-withdraw-1")).status, 202);
assert.equal(coreStore.withdrawals, 1);
assert.equal((await signedCore("/internal/referrals/withdraw", withdrawalBody, "nonce-core-withdraw-1")).status, 401);
const forged = JSON.stringify({ ...JSON.parse(withdrawalBody), receiptId: `RCP-${"C".repeat(32)}` });
assert.equal((await signedCore("/internal/referrals/withdraw", forged, "nonce-core-forged-123")).status, 404);
assert.equal(coreStore.withdrawals, 1);
const replayWithNewNonce = await signedCore("/internal/referrals/withdraw", withdrawalBody, "nonce-core-withdraw-2");
assert.equal(replayWithNewNonce.status, 202);
assert.equal(coreStore.withdrawals, 1);
const changedKey = JSON.stringify({ ...JSON.parse(withdrawalBody), withdrawalKey: "core-withdraw-key-other" });
assert.equal((await signedCore("/internal/referrals/withdraw", changedKey, "nonce-core-withdraw-3")).status, 404);

console.log("PASS site intake: direct Slack join, normalized email, Turnstile gate, signed CORE binding, generic failures, rate limit, and historical one-time withdrawal");
