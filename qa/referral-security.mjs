import assert from "node:assert/strict";
import { handleReferralIntakeRequest, signReferralServiceRequest } from "../src/community-referral-intake.ts";
import { deliverInviteAdminReview, handleInviteAdminAction } from "../src/community-invite-admin.ts";
import { referralManifestRequirements } from "../src/community-referral-manifest.ts";
import { handleReferralSlackRequest } from "../src/community-referral-slack.ts";
import { sign } from "../src/signing.ts";

const secret = "service-secret-with-enough-entropy-0123456789";
const now = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ referralToken: "A".repeat(32), submissionKey: "security-1", consentVersion: "invite-consent-v1", consentedAt: new Date().toISOString(), email: "target@example.com", displayName: "대상", intent: "참여 의사" });
const nonces = new Set();
let submitCalls = 0;
const store = {
  async claimServiceNonce(digest) { if (nonces.has(digest)) return false; nonces.add(digest); return true; },
  async submit() { submitCalls += 1; return { kind: "receipt", receiptId: "RCP-OPAQUE", state: "pending", revision: 0, requestId: "REQ-OPAQUE" }; },
  async decide() { throw new Error("must not reach"); },
  async markInvited() { throw new Error("must not reach"); },
  async findSubmission() { return null; },
  async issueLink() { return { kind: "issued", linkId: "LNK-SECURITY", created: true }; },
};
const bucket = { async put() {}, async get() { return null; }, async delete() {} };
const env = { SITE_CORE_HMAC_SECRET: secret, SLACK_TEAM_ID: "TQA", COMMUNITY_ADMIN_ID: "UADMIN", INVITE_EMAIL_PEPPER: Buffer.alloc(32, 3).toString("base64url"), INVITE_PRIVATE_OBJECTS: bucket, INVITE_PRIVATE_KEK: Buffer.alloc(32, 4).toString("base64url"), INVITE_PRIVATE_KEK_VERSION: "invite-kek-2026-01", REFERRAL_TOKEN_SECRET: "referral-secret", PUBLIC_APPLICATION_ORIGIN: "https://otl1.hyuk.me", SLACK_SIGNING_SECRET: "slack-secret", SLACK_BOT_TOKEN: "xoxb-test" };
const request = async ({ signature, nonce = "nonce-security-123456", timestamp = now, requestBody = body }) => handleReferralIntakeRequest(new Request("https://core.invalid/internal/referrals/apply", { method: "POST", headers: { "content-type": "application/json", "x-otl-timestamp": String(timestamp), "x-otl-nonce": nonce, "x-otl-signature": signature }, body: requestBody }), env, store);
const signature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body, timestamp: now, nonce: "nonce-security-123456" }, secret);
assert.equal((await request({ signature: "0".repeat(64) })).status, 401);
assert.equal((await request({ signature, timestamp: now - 301 })).status, 401);
assert.equal((await request({ signature })).status, 202);
const replay = await request({ signature });
assert.equal(replay.status, 401);
assert.equal(await replay.text(), "Unauthorized");
assert.equal(submitCalls, 1);
await assert.rejects(handleInviteAdminAction({ teamId: "TQA", userId: "UOTHER", actionId: "community_invite_approve", value: JSON.stringify({ requestId: "REQ-OPAQUE", revision: 0 }), actionTs: "1.1" }, env, store), /운영자/);
const staleStore = {
  ...store,
  async decide(input) {
    if (input.expectedRevision !== 2) throw new Error("stale referral revision");
    throw new Error("must not accept stale test input");
  },
};
await assert.rejects(handleInviteAdminAction({ teamId: "TQA", userId: "UADMIN", actionId: "community_invite_approve", value: JSON.stringify({ requestId: "REQ-OPAQUE", revision: 1 }), actionTs: "1.2" }, env, staleStore), /stale referral revision/);

const oversized = JSON.stringify({ ...JSON.parse(body), submissionKey: "security-oversized", intent: "한".repeat(1001) });
const oversizedNonce = "nonce-oversized-123456";
const oversizedSignature = await signReferralServiceRequest({ method: "POST", path: "/internal/referrals/apply", body: oversized, timestamp: now, nonce: oversizedNonce }, secret);
assert.equal((await request({ signature: oversizedSignature, nonce: oversizedNonce, requestBody: oversized })).status, 400);

const slackEffects = [];
let joinObservations = 0;
let joinAttributions = 0;
const slack = {
  personMode: "human",
  async postEphemeral(input) { slackEffects.push({ kind: "ephemeral", ...input }); return "1.1"; },
  async postAdmin(input) { slackEffects.push({ kind: "admin", ...input }); return "2.2"; },
  async person(userId) { return { id: userId, teamId: "TQA", email: "target@example.com", isBot: this.personMode === "bot", isApp: false, deleted: this.personMode === "deleted" }; },
};
const slackStore = {
  ...store,
  async observeJoinedMember() { joinObservations += 1; },
  async attributeJoin() { joinAttributions += 1; return { kind: "unmatched" }; },
};
async function signedSlack(path, payload) {
  const rawBody = path.endsWith("interactions") ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload);
  const signedAt = Math.floor(Date.now() / 1000);
  const signed = await sign(`v0:${signedAt}:${rawBody}`, env.SLACK_SIGNING_SECRET);
  return handleReferralSlackRequest(new Request(`https://core.invalid${path}`, { method: "POST", headers: { "x-slack-request-timestamp": String(signedAt), "x-slack-signature": `v0=${signed}` }, body: rawBody }), env, slackStore, slack);
}
const natural = await signedSlack("/slack/events", { type: "event_callback", team_id: "TQA", event_id: "Ev-link", event: { type: "message", channel: "CPUBLIC", user: "UMEMBER", text: "내 초대 링크", ts: "1.1" } });
assert.equal(natural.status, 200);
assert.equal(slackEffects.filter((effect) => effect.kind === "ephemeral").length, 1);
assert.equal(slackEffects.filter((effect) => effect.kind === "public").length, 0);
const legacy = await signedSlack("/slack/events", { type: "event_callback", team_id: "TQA", event_id: "Ev-legacy", event: { type: "message", channel: "CPUBLIC", user: "UMEMBER", text: "내 초대 코드", ts: "1.2" } });
assert.equal(legacy.status, 204);

slack.personMode = "bot";
assert.equal((await signedSlack("/slack/events", { type: "event_callback", team_id: "TQA", event_id: "Ev-bot", event: { type: "team_join", user: { id: "UBOT" } } })).status, 200);
slack.personMode = "deleted";
assert.equal((await signedSlack("/slack/events", { type: "event_callback", team_id: "TQA", event_id: "Ev-deleted", event: { type: "team_join", user: { id: "UDELETED" } } })).status, 200);
assert.equal(joinObservations, 0);
assert.equal(joinAttributions, 0);
slack.personMode = "human";
assert.equal((await signedSlack("/slack/events", { type: "event_callback", team_id: "TQA", event_id: "Ev-unmatched", event: { type: "team_join", user: { id: "UHUMAN" } } })).status, 200);
assert.equal(joinObservations, 1);
assert.equal(joinAttributions, 1);
assert.equal(slackEffects.length, 1);

const forgedSlack = await handleReferralSlackRequest(new Request("https://core.invalid/slack/events", { method: "POST", headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": "v0=bad" }, body: "{}" }), env, slackStore, slack);
assert.equal(forgedSlack.status, 401);

const missingPrivateStore = {
  ...slackStore,
  async claimAdminReview() { return { outboxId: 1, effectKey: "review:missing", requestId: "REQ-MISSING0001", revision: 0, privateRef: { requestId: "REQ-MISSING0001", revision: 0, opaqueRef: "invite-private/REQ-MISSING0001/revision-0-00000000-0000-4000-8000-000000000000.enc", objectDigest: "d".repeat(64), envelopeDek: "bad.bad", keyVersion: "invite-kek-2026-01", nonce: "bad", schemaVersion: "invite-application.v1" } }; },
  async finishOutbox(input) { this.finished = input.status; return true; },
};
assert.equal(await deliverInviteAdminReview(env, missingPrivateStore, slack), false);
assert.equal(missingPrivateStore.finished, "failed");
assert.equal(slackEffects.filter((effect) => effect.kind === "admin").length, 0);

assert.deepEqual(referralManifestRequirements(), { botEvents: ["team_join"], botScopes: ["users:read.email"] });
console.log("PASS referral security: forged-hmac=401 skew=401 replay=401 forged-slack=401 admin-forgery=denied stale-click=denied public-leakage=0 oversized-unicode=400 bot-join=ignored deleted-join=ignored unmatched-join=safe missing-r2=failed legacy-vocabulary=ignored manifest=team_join+users:read.email pii-response=absent");
