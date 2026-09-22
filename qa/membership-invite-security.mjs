import assert from "node:assert/strict";
import siteWorker from "../site/src/index.ts";
import { mock } from "bun:test";
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { handleRequest } = await import("../src/index.ts");
const { handleReferralIntakeRequest, signReferralServiceRequest } = await import("../src/community-referral-intake.ts");
const { handleLifecycleAdminMessage } = await import("../src/community-lifecycle-admin.ts");
const { sign } = await import("../src/signing.ts");

const token = "A".repeat(32);
const receipt = `RCP-${"B".repeat(32)}`;
const limited = new Map();
const coreCalls = [];
const env = {
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/receipt.html")
        return new Response("<main>__RECEIPT_ID__ __STATUS__ __WITHDRAW_FORM__</main>", { headers: { "content-type": "text/html" } });
      return new Response("missing", { status: 404 });
    },
  },
  CORE: {
    async fetch(request) {
      coreCalls.push(new URL(request.url).pathname);
      return Response.json({ available: true });
    },
  },
  RATE_LIMITER: {
    async limit({ key }) {
      const count = (limited.get(key) ?? 0) + 1;
      limited.set(key, count);
      return { success: count <= 2 };
    },
  },
  SITE_CORE_HMAC_SECRET: "synthetic-secret-only",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
};
const submit = (ip) => siteWorker.fetch(new Request(`https://otl1.hyuk.me/r/${token}/apply`, {
  method: "POST",
  headers: { "cf-connecting-ip": ip },
  body: new URLSearchParams(),
}), env);

assert.equal((await submit("192.0.2.1")).status, 422);
assert.equal((await submit("192.0.2.1")).status, 422);
assert.equal((await submit("192.0.2.1")).status, 429);
assert.equal((await submit("198.51.100.2")).status, 422, "one IP must not exhaust another applicant's link budget");
console.log("RATE_LIMIT_TWO_IP=PASS");

let bodyPulls = 0;
const oversized = new ReadableStream({
  pull(controller) {
    bodyPulls += 1;
    controller.enqueue(new Uint8Array(8192).fill(65));
    if (bodyPulls === 12) controller.close();
  },
});
const oversizedResponse = await siteWorker.fetch(new Request(`https://otl1.hyuk.me/r/${token}/apply`, {
  method: "POST",
  headers: { "cf-connecting-ip": "203.0.113.3", "content-type": "application/x-www-form-urlencoded" },
  body: oversized,
  duplex: "half",
}), env);
assert.equal(oversizedResponse.status, 422);
assert.ok(bodyPulls <= 4, `oversized stream consumed ${bodyPulls} chunks`);
console.log("BOUNDED_REQUEST_BODY=PASS");

const receiptPage = await siteWorker.fetch(new Request(`https://otl1.hyuk.me/receipt/${receipt}`), env);
assert.equal(receiptPage.status, 200);
assert.match(receiptPage.headers.get("content-security-policy") ?? "", /default-src 'self'/);
assert.equal(receiptPage.headers.get("x-content-type-options"), "nosniff");
assert.equal(receiptPage.headers.get("cache-control"), "no-store");
assert.doesNotMatch(await receiptPage.text(), /applicant|referrer|email|warning|lifecycle/i);
assert.equal(coreCalls.filter((path) => path === "/internal/referrals/resolve").length, 4);
console.log("PUBLIC_RECEIPT_HEADERS=PASS");

const coreEnv = {
  REFERRALS_ENABLED: "true",
  PUBLIC_APPLICATIONS_ENABLED: "true",
  DATABASE_URL: "postgresql://qa:qa@fake.neon.tech/unused",
  SLACK_TEAM_ID: "TQA",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CQA",
  COMMUNITY_ADMIN_ID: "UQA",
  SITE_CORE_HMAC_SECRET: "synthetic-secret-only",
};
const runtime = { env: coreEnv, store: {} };
const context = { waitUntil() { throw new Error("unauthorized request scheduled work"); } };
for (const [label, init, path, status] of [
  ["missing", { method: "POST", body: "{}" }, "/internal/referrals/apply", 401],
  ["forged", { method: "POST", body: "{}", headers: { "x-otl-timestamp": String(Math.floor(Date.now() / 1000)), "x-otl-nonce": "nonce-synthetic-123456", "x-otl-signature": "0".repeat(64) } }, "/internal/referrals/apply", 401],
  ["wrong_method", { method: "GET" }, "/internal/referrals/apply", 404],
]) {
  const response = await handleRequest(new Request(`https://core.invalid${path}`, init), runtime, context);
  assert.equal(response.status, status, label);
}
console.log("INTEGRATED_CORE_UNSIGNED=PASS");

const secret = "synthetic-secret-only";
const body = JSON.stringify({ referralToken: token });
const timestamp = Math.floor(Date.now() / 1000);
const nonce = "nonce-security-123456789";
const signature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/resolve", body, timestamp, nonce }, secret);
const nonceClaims = new Set();
let resolutions = 0;
const store = {
  async claimServiceNonce(digest) {
    if (nonceClaims.has(digest)) return false;
    nonceClaims.add(digest);
    return true;
  },
  async resolveLink() { resolutions += 1; return { available: true, inviterName: null }; },
};
const signedHeaders = { "x-otl-timestamp": String(timestamp), "x-otl-nonce": nonce, "x-otl-signature": signature };
const invoke = (path, method, value, headers, serviceSecret = secret) => handleReferralIntakeRequest(
  new Request(`https://core.invalid${path}`, { method, headers, ...(method === "POST" ? { body: value } : {}) }),
  { SITE_CORE_HMAC_SECRET: serviceSecret, SLACK_TEAM_ID: "TQA" }, store,
);
for (const [label, path, method, value, headers, serviceSecret, expected] of [
  ["missing", "/internal/referrals/resolve", "POST", body, {}, secret, 401],
  ["forged", "/internal/referrals/resolve", "POST", body, { ...signedHeaders, "x-otl-signature": "0".repeat(64) }, secret, 401],
  ["wrong_secret", "/internal/referrals/resolve", "POST", body, signedHeaders, "other-secret", 401],
  ["path", "/internal/referrals/apply", "POST", body, signedHeaders, secret, 401],
  ["body", "/internal/referrals/resolve", "POST", `${body} `, signedHeaders, secret, 401],
  ["method", "/internal/referrals/resolve", "GET", "", signedHeaders, secret, 404],
  ["timestamp", "/internal/referrals/resolve", "POST", body, { ...signedHeaders, "x-otl-timestamp": String(timestamp + 1) }, secret, 401],
  ["nonce", "/internal/referrals/resolve", "POST", body, { ...signedHeaders, "x-otl-nonce": `${nonce}X` }, secret, 401],
  ["expired", "/internal/referrals/resolve", "POST", body, { ...signedHeaders, "x-otl-timestamp": String(timestamp - 301) }, secret, 401],
  ["future", "/internal/referrals/resolve", "POST", body, { ...signedHeaders, "x-otl-timestamp": String(timestamp + 301) }, secret, 401],
]) {
  assert.equal((await invoke(path, method, value, headers, serviceSecret)).status, expected, label);
  assert.equal(nonceClaims.size, 0, label);
  assert.equal(resolutions, 0, label);
}
const races = await Promise.all([
  invoke("/internal/referrals/resolve", "POST", body, signedHeaders),
  invoke("/internal/referrals/resolve", "POST", body, signedHeaders),
]);
assert.deepEqual(races.map((response) => response.status).sort(), [200, 200]);
assert.equal(resolutions, 2);
assert.equal(nonceClaims.size, 0);
console.log("HMAC_HOSTILE_CORPUS=PASS");

const adminEnv = { SLACK_TEAM_ID: "TQA", COMMUNITY_CHANNEL_ID: "CADMIN", COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC", COMMUNITY_ADMIN_ID: "UADMIN" };
const adminBase = { teamId: "TQA", channelId: "CADMIN", userId: "UADMIN", text: "생애주기 검토 UOWNER", key: "EvAdmin1", now: new Date().toISOString() };
const adminCalls = { reads: [], corrections: [], replies: [] };
const candidates = new Map([["UOWNER", { state: "dormant", revision: 2, evaluations: [{ serviceDate: "2026-09-18", eligible: true, exclusionReason: null, signalKind: null, candidate: true, explanation: { code: "seven_inactive_service_days" } }] }]]);
const adminStore = {
  async candidate(teamId, channelId, userId) { adminCalls.reads.push({ teamId, channelId, userId }); return candidates.get(userId) ?? null; },
  async restoreError(binding, now, evidenceKey) { adminCalls.corrections.push({ binding, now, evidenceKey }); candidates.set(binding.ownerId, { ...candidates.get(binding.ownerId), state: "active", revision: 3 }); return { state: "active", revision: 3 }; },
};
const adminReply = async (value) => { adminCalls.replies.push(value); };
for (const [label, changes] of [
  ["other_actor", { userId: "UOTHER" }],
  ["public_channel", { channelId: "CPUBLIC" }],
  ["other_team", { teamId: "TOTHER" }],
]) {
  await assert.rejects(() => handleLifecycleAdminMessage({ ...adminBase, ...changes }, adminEnv, adminStore, adminReply), undefined, label);
}
assert.equal(adminCalls.reads.length, 0);
await handleLifecycleAdminMessage(adminBase, adminEnv, adminStore, adminReply);
assert.match(adminCalls.replies[0], /seven_inactive_service_days/);
assert.deepEqual(adminCalls.reads[0], { teamId: "TQA", channelId: "CPUBLIC", userId: "UOWNER" });
for (const [label, text] of [
  ["other_member", "생애주기 정정 UOTHER 2 EVIDENCE-1234"],
  ["stale", "생애주기 정정 UOWNER 1 EVIDENCE-1234"],
  ["missing_evidence", "생애주기 정정 UOWNER 2 x"],
]) {
  await assert.rejects(() => handleLifecycleAdminMessage({ ...adminBase, text }, adminEnv, adminStore, adminReply), undefined, label);
}
assert.equal(adminCalls.corrections.length, 0);
const correction = { ...adminBase, text: "생애주기 정정 UOWNER 2 EVIDENCE-1234" };
await handleLifecycleAdminMessage(correction, adminEnv, adminStore, adminReply);
assert.equal(adminCalls.corrections.length, 1);
assert.deepEqual(adminCalls.corrections[0].binding, { actionId: "lifecycle_restore_error", teamId: "TQA", channelId: "CPUBLIC", ownerId: "UOWNER", revision: 2, key: "admin:EvAdmin1" });
assert.equal(adminCalls.corrections[0].evidenceKey, "EVIDENCE-1234");
await assert.rejects(() => handleLifecycleAdminMessage(correction, adminEnv, adminStore, adminReply));
assert.equal(adminCalls.corrections.length, 1);
console.log("LIFECYCLE_ADMIN_SCOPE=PASS");

const liveSecret = "synthetic-slack-secret";
const adminDbUrl = "postgresql://otl_lifecycle_admin_login:synthetic@fake.neon.tech/test";
const liveEnv = {
  ...adminEnv,
  COMMUNITY_ENABLED: "true",
  SLACK_SIGNING_SECRET: liveSecret,
  SLACK_BOT_TOKEN: "synthetic-token",
  LIFECYCLE_ADMIN_DATABASE_URL: adminDbUrl,
  DATABASE_URL: "postgresql://runtime:synthetic@fake.neon.tech/test",
};
const effects = { queries: [], posts: [] };
let liveState = { state: "dormant", revision: 2, evaluations: candidates.get("UOWNER").evaluations };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://fake.neon.tech/sql") {
    assert.equal(init.headers["Neon-Connection-String"], adminDbUrl);
    const query = JSON.parse(init.body);
    effects.queries.push(query);
    if (query.query.includes("lifecycle_admin_candidate")) return Response.json({ rows: [[JSON.stringify(liveState)]] });
    if (query.query.includes("lifecycle_admin_execute")) {
      liveState = { ...liveState, state: "active", revision: 3 };
      return Response.json({ rows: [[JSON.stringify({ state: "active", revision: 3 })]] });
    }
    throw new Error("unexpected SQL operation");
  }
  if (String(url) === "https://slack.com/api/chat.postMessage") {
    effects.posts.push(JSON.parse(init.body));
    return Response.json({ ok: true, ts: "123.456" });
  }
  throw new Error("unexpected outbound request");
};
const eventPayload = (text, userId = "UADMIN", channel = "CADMIN") => ({
  type: "event_callback", team_id: "TQA", event_id: `Ev${crypto.randomUUID().replaceAll("-", "")}`,
  event: { type: "message", channel, user: userId, text, ts: String(Date.now() / 1000) },
});
const signedSlack = async (payload, signatureOverride) => {
  const body = JSON.stringify(payload);
  const time = String(Math.floor(Date.now() / 1000));
  const signatureValue = signatureOverride ?? `v0=${await sign(`v0:${time}:${body}`, liveSecret)}`;
  const pending = [];
  const response = await handleRequest(new Request("https://core.invalid/slack/events", {
    method: "POST", body, headers: { "x-slack-request-timestamp": time, "x-slack-signature": signatureValue },
  }), { env: liveEnv, store: {} }, { waitUntil(promise) { pending.push(promise); } });
  return { response, completed: await Promise.allSettled(pending) };
};
try {
  assert.equal((await signedSlack(eventPayload("생애주기 검토 UOWNER"), "v0=bad")).response.status, 401);
  for (const [label, payload] of [
    ["non_admin", eventPayload("생애주기 검토 UOWNER", "UOTHER")],
    ["public", eventPayload("생애주기 검토 UOWNER", "UADMIN", "CPUBLIC")],
  ]) {
    const result = await signedSlack(payload);
    assert.equal(result.response.status, 200, label);
    assert.ok(result.completed.some((entry) => entry.status === "rejected"), label);
  }
  assert.equal(effects.queries.length, 0);
  assert.equal(effects.posts.length, 0);
  const inspected = await signedSlack(eventPayload("생애주기 검토 UOWNER"));
  assert.ok(inspected.completed.every((entry) => entry.status === "fulfilled"));
  assert.equal(effects.queries.length, 1);
  assert.equal(effects.posts.length, 1);
  assert.equal(effects.posts[0].channel, "UADMIN");
  const corrected = await signedSlack(eventPayload("생애주기 정정 UOWNER 2 EVIDENCE-1234"));
  assert.ok(corrected.completed.every((entry) => entry.status === "fulfilled"));
  assert.equal(effects.queries.length, 3);
  assert.equal(effects.posts.length, 2);
  assert.equal(JSON.parse(effects.queries[2].params[1]).userId, "UOWNER");
  console.log("SIGNED_ADMIN_ROUTE=PASS");
} finally {
  globalThis.fetch = originalFetch;
}
