import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  handleReferralIntakeRequest,
  signReferralServiceRequest,
} from "../src/community-referral-intake.ts";
import {
  deliverInviteAdminReview,
  handleInviteAdminAction,
} from "../src/community-invite-admin.ts";
import { handleReferralLinkMessage } from "../src/community-referral-link.ts";
import { handleReferralTeamJoin } from "../src/community-referral-join.ts";
import {
  nextInvitePrivateReconciliationDue,
  reconcileInvitePrivateIntake,
} from "../src/community-referral-reconcile.ts";
import { handleReferralSlackRequest } from "../src/community-referral-slack.ts";
import { sign } from "../src/signing.ts";

const run = promisify(execFile);
const secret = "service-secret-with-enough-entropy-0123456789";
const key = Buffer.alloc(32, 7).toString("base64url");

class MemoryBucket {
  objects = new Map();
  puts = 0;
  deletes = 0;
  privatePuts = 0;
  privateDeletes = 0;
  version = 0;
  writes = [];
  async put(name, value, options = {}) {
    const existing = this.objects.get(name);
    if (options.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    this.puts += 1;
    if (name.startsWith("invite-private/")) this.privatePuts += 1;
    this.writes.push(name);
    const etag = `etag-${++this.version}`;
    this.objects.set(name, { bytes: value.slice(0), etag });
    return { etag };
  }
  async get(name) {
    const value = this.objects.get(name);
    return value ? { key: name, etag: value.etag, arrayBuffer: async () => value.bytes.slice(0) } : null;
  }
  async delete(name) {
    this.deletes += 1;
    if (name.startsWith("invite-private/")) this.privateDeletes += 1;
    this.objects.delete(name);
  }
  async list({ prefix, limit }) {
    return {
      objects: [...this.objects.keys()].filter((name) => name.startsWith(prefix)).slice(0, limit).map((key) => ({ key })),
      truncated: false,
    };
  }
}

class MemoryStore {
  nonces = new Set();
  links = new Map();
  requestsByEmail = new Map();
  reviews = [];
  decisions = [];
  joins = [];
  submissions = 0;
  failSubmit = false;
  throwSubmit = false;
  responseLostOnce = false;
  findCalls = 0;
  failFindOnCall = null;
  privateIntakes = new Map();
  privateLookupFails = false;
  active = true;
  async claimServiceNonce(digest) {
    if (this.nonces.has(digest)) return false;
    this.nonces.add(digest);
    return true;
  }
  async findSubmission(_teamId, submissionKey) {
    this.findCalls += 1;
    if (this.findCalls === this.failFindOnCall) throw new Error("database reconciliation unavailable");
    return [...this.requestsByEmail.values()].find((entry) => entry.input.key === submissionKey)?.receipt ?? null;
  }
  async findPrivateIntake(_teamId, requestId, objectDigest) {
    if (this.privateLookupFails) throw new Error("database outage during reconciliation");
    const stored = this.privateIntakes.get(requestId);
    if (!stored) return "absent";
    return stored === objectDigest ? "adopted" : "conflict";
  }
  async issueLink(input) {
    if (!this.active) return { kind: "unavailable" };
    const existing = this.links.get(input.userId);
    if (existing) return { kind: "issued", linkId: existing.linkId, created: false };
    const value = { linkId: input.linkId, tokenDigest: input.tokenDigest };
    this.links.set(input.userId, value);
    return { kind: "issued", linkId: value.linkId, created: true };
  }
  async submit(input) {
    this.submissions += 1;
    if (this.throwSubmit) throw new Error("database unavailable before commit");
    if (this.failSubmit) return { kind: "rejected" };
    const existing = this.requestsByEmail.get(input.emailDigest);
    if (existing) return existing.receipt;
    const receipt = { kind: "receipt", receiptId: input.receiptId, state: "pending", revision: 0, requestId: input.requestId };
    this.requestsByEmail.set(input.emailDigest, { input, receipt });
    this.privateIntakes.set(input.requestId, input.privateRef.objectDigest);
    this.reviews.push({
      outboxId: this.reviews.length + 1,
      effectKey: `review:${input.requestId}`,
      requestId: input.requestId,
      revision: 0,
      privateRef: { ...input.privateRef, requestId: input.requestId, revision: 0 },
    });
    if (this.responseLostOnce) {
      this.responseLostOnce = false;
      throw new Error("response lost after commit");
    }
    return receipt;
  }
  async claimAdminReview() {
    return this.reviews.shift() ?? null;
  }
  async finishOutbox() { return true; }
  async decide(input) {
    this.decisions.push(input);
    return { receiptId: "opaque", state: input.decision, revision: input.expectedRevision + 1 };
  }
  async markInvited(input) {
    this.decisions.push({ ...input, decision: "manual_invite_asserted" });
    return { receiptId: "opaque", state: "approved", revision: input.expectedRevision + 1, manualInviteAsserted: true, deliveryProven: false };
  }
  async observeJoinedMember(input) { this.observed = input; }
  async attributeJoin(input) {
    this.joins.push(input);
    return { kind: "attributed", receiptId: "opaque" };
  }
}

const bucket = new MemoryBucket();
const store = new MemoryStore();
const env = {
  SITE_CORE_HMAC_SECRET: secret,
  SLACK_TEAM_ID: "TQA",
  COMMUNITY_ADMIN_ID: "UADMIN",
  PUBLIC_APPLICATION_ORIGIN: "https://otl1.hyuk.me",
  REFERRAL_TOKEN_SECRET: key,
  INVITE_EMAIL_PEPPER: key,
  INVITE_PRIVATE_OBJECTS: bucket,
  INVITE_PRIVATE_KEK: key,
  INVITE_PRIVATE_KEK_VERSION: "invite-kek-2026-01",
};

const body = JSON.stringify({
  referralToken: "A".repeat(32),
  submissionKey: "submission-1",
  consentVersion: "invite-consent-v1",
  consentedAt: new Date().toISOString(),
  email: " Person@Example.com ",
  displayName: "지원자",
  intent: "매일 한 가지를 기록하고 싶습니다.",
});
const now = Math.floor(Date.now() / 1000);
const nonce = "nonce-1234567890abcdef";
const signature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body, timestamp: now, nonce }, secret);
const headers = {
  "content-type": "application/json",
  "x-otl-timestamp": String(now),
  "x-otl-nonce": nonce,
  "x-otl-signature": signature,
};
const server = Bun.serve({
  port: 0,
  fetch: (request) => handleReferralIntakeRequest(request, env, store),
});
try {
  const curl = await run("curl", ["-sS", "-D", "-", "-X", "POST", ...Object.entries(headers).flatMap(([name, value]) => ["-H", `${name}: ${value}`]), "--data-binary", body, `${server.url}internal/referrals/apply`]);
  assert.match(curl.stdout, /HTTP\/1\.1 202/);
  const responseBody = JSON.parse(curl.stdout.split("\r\n\r\n").at(-1));
  assert.deepEqual(Object.keys(responseBody), ["receiptId"]);
} finally {
  server.stop(true);
}
assert.equal(store.submissions, 1);
assert.equal(bucket.privatePuts, 1);
assert.ok(bucket.writes[0].startsWith("invite-private-reconcile/"));
assert.ok(bucket.writes[1].startsWith("invite-private/"));
const originalReceipt = [...store.requestsByEmail.values()][0].receipt.receiptId;
const exactNonce = "nonce-exact-1234567890";
const exactSignature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body, timestamp: now, nonce: exactNonce }, secret);
const exactResponse = await handleReferralIntakeRequest(new Request("https://core.invalid/internal/referrals/apply", { method: "POST", headers: { ...headers, "x-otl-nonce": exactNonce, "x-otl-signature": exactSignature }, body }), env, store);
assert.equal((await exactResponse.json()).receiptId, originalReceipt);
assert.equal(bucket.privatePuts, 1);
const duplicateBody = JSON.stringify({ ...JSON.parse(body), referralToken: "B".repeat(32), submissionKey: "submission-duplicate" });
const duplicateNonce = "nonce-duplicate-123456";
const duplicateSignature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body: duplicateBody, timestamp: now, nonce: duplicateNonce }, secret);
const duplicateResponse = await handleReferralIntakeRequest(new Request("https://core.invalid/internal/referrals/apply", { method: "POST", headers: { ...headers, "x-otl-nonce": duplicateNonce, "x-otl-signature": duplicateSignature }, body: duplicateBody }), env, store);
assert.equal(duplicateResponse.status, 202);
assert.equal((await duplicateResponse.json()).receiptId, originalReceipt);
assert.equal(store.requestsByEmail.size, 1);
assert.equal(bucket.privateDeletes, 1);

store.failSubmit = true;
const failedBody = JSON.stringify({ ...JSON.parse(body), email: "failed@example.com", submissionKey: "submission-failed" });
const failedNonce = "nonce-failure-12345678";
const failedSignature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body: failedBody, timestamp: now, nonce: failedNonce }, secret);
const failedResponse = await handleReferralIntakeRequest(new Request("https://core.invalid/internal/referrals/apply", { method: "POST", headers: { ...headers, "x-otl-nonce": failedNonce, "x-otl-signature": failedSignature }, body: failedBody }), env, store);
assert.equal(failedResponse.status, 503);
assert.equal(bucket.privateDeletes, 2);
store.failSubmit = false;

store.throwSubmit = true;
const unavailableBody = JSON.stringify({ ...JSON.parse(body), email: "unavailable@example.com", submissionKey: "submission-unavailable" });
const unavailableNonce = "nonce-unavailable-12345";
const unavailableSignature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body: unavailableBody, timestamp: now, nonce: unavailableNonce }, secret);
const unavailableResponse = await handleReferralIntakeRequest(new Request("https://core.invalid/internal/referrals/apply", { method: "POST", headers: { ...headers, "x-otl-nonce": unavailableNonce, "x-otl-signature": unavailableSignature }, body: unavailableBody }), env, store);
assert.equal(unavailableResponse.status, 503);
assert.equal(bucket.privateDeletes, 3);
store.throwSubmit = false;

store.responseLostOnce = true;
const lostBody = JSON.stringify({ ...JSON.parse(body), email: "lost@example.com", submissionKey: "submission-lost" });
const lostNonce = "nonce-lost-12345678901";
const lostSignature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body: lostBody, timestamp: now, nonce: lostNonce }, secret);
const lostResponse = await handleReferralIntakeRequest(new Request("https://core.invalid/internal/referrals/apply", { method: "POST", headers: { ...headers, "x-otl-nonce": lostNonce, "x-otl-signature": lostSignature }, body: lostBody }), env, store);
assert.equal(lostResponse.status, 202);
assert.equal(bucket.privateDeletes, 3);

async function uncertainIntake(email, submissionKey, requestNonce) {
  store.throwSubmit = true;
  store.failFindOnCall = store.findCalls + 2;
  const requestBody = JSON.stringify({ ...JSON.parse(body), email, submissionKey });
  const requestSignature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body: requestBody, timestamp: now, nonce: requestNonce }, secret);
  const response = await handleReferralIntakeRequest(new Request("https://core.invalid/internal/referrals/apply", { method: "POST", headers: { ...headers, "x-otl-nonce": requestNonce, "x-otl-signature": requestSignature }, body: requestBody }), env, store);
  store.throwSubmit = false;
  store.failFindOnCall = null;
  return response;
}

function reconciliationKeys() {
  return [...bucket.objects.keys()].filter((name) => name.startsWith("invite-private-reconcile/"));
}

async function markerAt(keyName) {
  const stored = await bucket.get(keyName);
  assert.ok(stored);
  return JSON.parse(new TextDecoder().decode(await stored.arrayBuffer()));
}

const uncertainAdoptResponse = await uncertainIntake("uncertain-adopt@example.com", "submission-uncertain-adopt", "nonce-uncertain-adopt1");
assert.equal(uncertainAdoptResponse.status, 503);
assert.equal(reconciliationKeys().length, 1);
const adoptMarkerKey = reconciliationKeys()[0];
const adoptMarker = await markerAt(adoptMarkerKey);
const adoptMarkerText = JSON.stringify(adoptMarker);
assert.doesNotMatch(adoptMarkerText, /uncertain-adopt@example\.com|submission-uncertain-adopt|A{32}/);
assert.ok(bucket.objects.has(adoptMarker.opaqueRef));
assert.equal(await nextInvitePrivateReconciliationDue(env), adoptMarker.nextAttemptAt);
store.privateIntakes.set(adoptMarker.requestId, adoptMarker.objectDigest);
const adopted = await reconcileInvitePrivateIntake(env, store, Date.now() + 1);
assert.equal(adopted.adopted, 1);
assert.equal(reconciliationKeys().length, 0);
assert.ok(bucket.objects.has(adoptMarker.opaqueRef));

const uncertainOrphanResponse = await uncertainIntake("uncertain-orphan@example.com", "submission-uncertain-orphan", "nonce-uncertain-orphan1");
assert.equal(uncertainOrphanResponse.status, 503);
const orphanMarkerKey = reconciliationKeys()[0];
const orphanMarker = await markerAt(orphanMarkerKey);
const orphaned = await reconcileInvitePrivateIntake(env, store, Date.now() + 16 * 60_000);
assert.equal(orphaned.deleted, 1);
assert.equal(reconciliationKeys().length, 0);
assert.equal(bucket.objects.has(orphanMarker.opaqueRef), false);

const concurrentResponse = await uncertainIntake("uncertain-concurrent@example.com", "submission-uncertain-concurrent", "nonce-uncertain-concurr1");
assert.equal(concurrentResponse.status, 503);
const concurrentResults = await Promise.all([
  reconcileInvitePrivateIntake(env, store, Date.now() + 1),
  reconcileInvitePrivateIntake(env, store, Date.now() + 1),
]);
assert.equal(concurrentResults.reduce((total, result) => total + result.claimed, 0), 1);
assert.equal(reconciliationKeys().length, 1);
const concurrentMarker = await markerAt(reconciliationKeys()[0]);
const concurrentCleanup = await reconcileInvitePrivateIntake(env, store, Date.now() + 16 * 60_000);
assert.equal(concurrentCleanup.deleted, 1);
assert.equal(bucket.objects.has(concurrentMarker.opaqueRef), false);
assert.equal(reconciliationKeys().length, 0);

const outageResponse = await uncertainIntake("uncertain-outage@example.com", "submission-uncertain-outage", "nonce-uncertain-outage1");
assert.equal(outageResponse.status, 503);
const outageMarkerKey = reconciliationKeys()[0];
const outageMarker = await markerAt(outageMarkerKey);
store.privateLookupFails = true;
let outageResult;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  outageResult = await reconcileInvitePrivateIntake(
    env,
    store,
    Date.now() + (16 + attempt * 16) * 60_000,
  );
}
store.privateLookupFails = false;
assert.equal(outageResult.deadLettered, 1);
assert.ok(bucket.objects.has(outageMarkerKey));
assert.ok(bucket.objects.has(outageMarker.opaqueRef));
assert.equal(await nextInvitePrivateReconciliationDue(env), null);
await bucket.delete(outageMarkerKey);
await bucket.delete(outageMarker.opaqueRef);
assert.equal(reconciliationKeys().length, 0);

const slackEffects = [];
const slack = {
  async postEphemeral(message) { slackEffects.push({ kind: "ephemeral", ...message }); return "1.1"; },
  async postAdmin(message) { slackEffects.push({ kind: "admin", ...message }); return "2.2"; },
  async person(userId) {
    return { id: userId, teamId: "TQA", email: "person@example.com", isBot: false, isApp: false, deleted: false };
  },
};
assert.equal(await handleReferralLinkMessage({ teamId: "TQA", channelId: "CQA", userId: "UMEMBER", text: "내 초대 링크" }, env, store, slack), true);
assert.match(slackEffects.at(-1).text, /^https:\/\/otl1\.hyuk\.me\/r\/[A-Za-z0-9_-]{32}$/);
const stable = slackEffects.at(-1).text;
await handleReferralLinkMessage({ teamId: "TQA", channelId: "CQA", userId: "UMEMBER", text: "내 초대 링크" }, env, store, slack);
assert.equal(slackEffects.at(-1).text, stable);
store.active = false;
await handleReferralLinkMessage({ teamId: "TQA", channelId: "CQA", userId: "UDORMANT", text: "내 초대 링크" }, env, store, slack);
assert.doesNotMatch(slackEffects.at(-1).text, /https?:\/\//);

assert.equal(await deliverInviteAdminReview(env, store, slack), true);
const adminCard = slackEffects.find((effect) => effect.kind === "admin");
assert.ok(adminCard);
assert.match(JSON.stringify(adminCard), /Free Slack 초대는 운영자가 직접/);
await handleInviteAdminAction({ teamId: "TQA", userId: "UADMIN", actionId: "community_invite_approve", value: JSON.stringify({ requestId: adminCard.requestId, revision: 0 }), actionTs: "100.1" }, env, store, slack);
await handleInviteAdminAction({ teamId: "TQA", userId: "UADMIN", actionId: "community_invite_mark_invited", value: JSON.stringify({ requestId: adminCard.requestId, revision: 1 }), actionTs: "100.2" }, env, store);
assert.deepEqual(store.decisions.map((entry) => entry.decision), ["approved", "manual_invite_asserted"]);

const acceptedLostReview = store.reviews.shift();
assert.ok(acceptedLostReview);
const deliveryResults = [];
const retryQueue = [acceptedLostReview, acceptedLostReview];
const retryStore = {
  async claimAdminReview() { return retryQueue.shift() ?? null; },
  async finishOutbox(input) { deliveryResults.push(input.status); return true; },
};
const deliveredEffects = new Set();
let adminAttempts = 0;
const acceptedLostSlack = {
  ...slack,
  async postAdmin(message) {
    adminAttempts += 1;
    deliveredEffects.add(message.effectKey);
    if (adminAttempts === 1) throw new Error("Slack response lost after acceptance");
    return "3.3";
  },
};
assert.equal(await deliverInviteAdminReview(env, retryStore, acceptedLostSlack), false);
assert.equal(await deliverInviteAdminReview(env, retryStore, acceptedLostSlack), true);
assert.deepEqual(deliveryResults, ["failed", "sent"]);
assert.equal(deliveredEffects.size, 1);

const effectsBeforeJoin = slackEffects.length;
assert.equal(await handleReferralTeamJoin({ teamId: "TQA", eventId: "Ev1", userId: "UNEW" }, env, store, slack), true);
assert.equal(store.joins.length, 1);
assert.equal(slackEffects.length, effectsBeforeJoin);

const signedAt = Math.floor(Date.now() / 1000);
const signedEvent = JSON.stringify({ type: "event_callback", team_id: "TQA", event_id: "Ev-signed", event: { type: "team_join", user: { id: "USIGNED" } } });
const slackSignature = await sign(`v0:${signedAt}:${signedEvent}`, "slack-signing-secret");
const signedResponse = await handleReferralSlackRequest(new Request("https://core.invalid/slack/events", { method: "POST", headers: { "x-slack-request-timestamp": String(signedAt), "x-slack-signature": `v0=${slackSignature}` }, body: signedEvent }), { ...env, SLACK_SIGNING_SECRET: "slack-signing-secret", SLACK_BOT_TOKEN: "xoxb-test" }, store, slack);
assert.equal(signedResponse.status, 200);
assert.equal(store.joins.length, 2);

console.log(`PASS referral flow: http=202 db-submissions=${store.submissions} r2-put=${bucket.privatePuts} r2-compensated=${bucket.privateDeletes} exact-duplicate=original-receipt duplicate-email=original-receipt db-response-lost=reconciled uncertain-marker=discoverable reconciler=adopt+delete concurrent-claim=one db-outage=preserve dead-letter=bounded cleanup=clean slack-response-lost=one-effect slack-effects=${slackEffects.length} stable-private-link=1 dormant-url=0 decisions=2 signed-team-join=200 join-attributions=${store.joins.length}`);
