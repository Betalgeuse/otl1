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
      return new Response("<html><body>__REFERRAL_TOKEN__ __TURNSTILE_SITE_KEY__ __SHARE_TEXT__ __SUBMISSION_KEY__</body></html>", {
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
const core = {
  async fetch(request) {
    const body = await request.text();
    coreBodies.push({ path: new URL(request.url).pathname, body, headers: Object.fromEntries(request.headers) });
    if (new URL(request.url).pathname.endsWith("resolve")) return Response.json({ available: JSON.parse(body).referralToken === referralToken });
    if (body.includes("outage@example.com")) throw new Error("core outage");
    if (body.includes("paused@example.com")) return Response.json({ error: "unavailable" }, { status: 503 });
    if (new URL(request.url).pathname.endsWith("withdraw")) return Response.json({ receiptId, state: "withdrawn" }, { status: 202 });
    return Response.json({ receiptId, withdrawalToken: "A".repeat(43) }, { status: 202 });
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
};

const originalFetch = globalThis.fetch;
let verifyMode = "ok";
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(init.method, "POST");
  if (verifyMode === "timeout") throw new DOMException("timed out", "TimeoutError");
  if (verifyMode === "invalid") return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
  return Response.json({ success: true, hostname: "example.com" });
};

const call = (path, init = {}) => siteWorker.fetch(new Request(`https://otl1.hyuk.me${path}`, init), env);
const form = (overrides = {}) => {
  const value = new FormData();
  value.set("email", "  PERSON@Example.COM ");
  value.set("displayName", "  소개받은 사람  ");
  value.set("intent", "  오늘 한 가지를 꾸준히 끝내고 싶어요.  ");
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
  assert.doesNotMatch(pageText, /inviter|referrer|소개자.*이름/i);

  const invalidSlug = await call("/r/not-enumerable");
  assert.equal(invalidSlug.status, 404);
  const unknownSlug = await call(`/r/${"Z".repeat(32)}`);
  assert.equal(unknownSlug.status, 404);
  assert.doesNotMatch(await unknownSlug.text(), /Z{32}|referrer|inviter/);
  const pausedSlug = await call(`/r/${"Z".repeat(32)}/apply`, { method: "POST", body: form() });
  assert.equal(pausedSlug.status, 404);

  const valid = await call(`/r/${referralToken}/apply`, { method: "POST", body: form() });
  assert.equal(valid.status, 303);
  assert.equal(valid.headers.get("location"), `/receipt/${receiptId}`);
  assert.match(valid.headers.get("set-cookie") ?? "", /otl1_withdraw=/);
  assert.match(valid.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(valid.headers.get("set-cookie") ?? "", /SameSite=Strict/);
  const applies = coreBodies.filter((entry) => entry.path === "/internal/referrals/apply");
  assert.equal(applies.length, 1);
  const submitted = JSON.parse(applies[0].body);
  assert.deepEqual(
    { email: submitted.email, displayName: submitted.displayName, intent: submitted.intent, consentVersion: submitted.consentVersion },
    { email: "person@example.com", displayName: "소개받은 사람", intent: "오늘 한 가지를 꾸준히 끝내고 싶어요.", consentVersion: "invite-consent-v1" },
  );
  assert.match(applies[0].headers["x-otl-signature"], /^[0-9a-f]{64}$/);

  const receipt = await call(`/receipt/${receiptId}`);
  assert.equal(receipt.status, 200);
  assert.match(await receipt.text(), new RegExp(receiptId));

  const withdraw = await call(`/receipt/${receiptId}/withdraw`, {
    method: "POST",
    headers: { cookie: valid.headers.get("set-cookie").split(";")[0] },
    body: new URLSearchParams({ withdrawalKey: "withdraw-browser-123456" }),
  });
  assert.equal(withdraw.status, 303);
  assert.equal(coreBodies.at(-1).path, "/internal/referrals/withdraw");
  assert.equal(JSON.parse(coreBodies.at(-1).body).receiptId, receiptId);

  const [first, second] = await Promise.all([
    call(`/r/${referralToken}/apply`, { method: "POST", body: form() }),
    call(`/r/${referralToken}/apply`, { method: "POST", body: form() }),
  ]);
  assert.equal(first.headers.get("location"), second.headers.get("location"));
  assert.equal(coreBodies.filter((entry) => entry.path.endsWith("apply")).length, 3);
  assert.equal(new Set(coreBodies.filter((entry) => entry.path.endsWith("apply")).slice(-2).map((entry) => JSON.parse(entry.body).submissionKey)).size, 1);

  const genericBodies = [];
  for (const email of ["paused@example.com", "outage@example.com"]) {
    const response = await call(`/r/${referralToken}/apply`, { method: "POST", body: form({ email }) });
    assert.equal(response.status, 503);
    genericBodies.push(await response.text());
  }
  assert.equal(new Set(genericBodies).size, 1);
  assert.doesNotMatch(genericBodies[0], /paused|outage|example\.com|referral/i);

  verifyMode = "invalid";
  const invalidTurnstile = await call(`/r/${referralToken}/apply`, { method: "POST", body: form() });
  assert.equal(invalidTurnstile.status, 422);
  verifyMode = "timeout";
  const timeoutTurnstile = await call(`/r/${referralToken}/apply`, { method: "POST", body: form() });
  assert.equal(timeoutTurnstile.status, 503);
  verifyMode = "ok";

  for (const invalid of [
    { consent: "" },
    { email: "not-an-email" },
    { displayName: "가".repeat(81) },
    { displayName: "bad\ud800name" },
    { intent: "나".repeat(1001) },
  ]) {
    const response = await call(`/r/${referralToken}/apply`, { method: "POST", body: form(invalid) });
    assert.equal(response.status, 422);
    assert.doesNotMatch(await response.text(), /not-an-email|bad|가가가/);
  }

  rateLimitSuccess = false;
  assert.equal((await call(`/r/${referralToken}/apply`, { method: "POST", body: form() })).status, 429);
  assert.equal((await call(`/r/${referralToken}`)).status, 429);
  rateLimitSuccess = true;

  const canonicalBody = JSON.stringify({ ok: true });
  const signed = await createSiteCoreSignature("POST", "/internal/referrals/apply", canonicalBody, 1_700_000_000, "nonce-browser-123456");
  const expected = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body: canonicalBody, timestamp: 1_700_000_000, nonce: "nonce-browser-123456" }, hmacSecret);
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
    return tokenDigest === Buffer.from(bytes).toString("hex");
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
assert.deepEqual(await resolved.json(), { available: true });
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

console.log("PASS site intake: opaque referral, normalized private fields, Turnstile gate, signed CORE binding, generic failures, rate limit, idempotent receipt, and one-time withdrawal");
