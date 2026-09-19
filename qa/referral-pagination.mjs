import assert from "node:assert/strict";
import {
  createInvitePrivateReconciliationMarker,
  reconcileInvitePrivateIntake,
  nextInvitePrivateReconciliationDue,
} from "../src/community-referral-reconcile.ts";

class Bucket {
  objects = new Map();
  version = 0;
  async put(key, value, options = {}) {
    const previous = this.objects.get(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && previous) return null;
    if (options.onlyIf?.etagMatches && previous?.etag !== options.onlyIf.etagMatches) return null;
    const etag = `etag-${++this.version}`;
    this.objects.set(key, { value, etag });
    return { etag };
  }
  async get(key) {
    const item = this.objects.get(key);
    return item && { key, etag: item.etag, arrayBuffer: async () => item.value };
  }
  async delete(key) { this.objects.delete(key); }
  async list({ prefix, limit, cursor }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? keys.findIndex((key) => key > cursor) : 0;
    const page = keys.slice(start, start + limit);
    return {
      objects: page.map((key) => ({ key })),
      truncated: start + limit < keys.length,
      ...(start + limit < keys.length ? { cursor: page.at(-1) } : {}),
    };
  }
}

const bucket = new Bucket();
const env = { SLACK_TEAM_ID: "TTEST", SITE_CORE_HMAC_SECRET: "test-secret", INVITE_PRIVATE_OBJECTS: bucket };
const now = Date.parse("2026-09-19T12:00:00Z");
for (let i = 0; i < 51; i += 1) {
  const id = `REQ-${String(i).padStart(8, "0")}`;
  await createInvitePrivateReconciliationMarker(env, {
    requestId: id, submissionKey: `submission-${id}`,
    objectDigest: "a".repeat(64), opaqueRef: `invite-private/${id}/revision-0-12345678-1234-1234-1234-123456789012.enc`,
    now: i === 50 ? new Date(now - 60_000).toISOString() : new Date(now + 60_000).toISOString(),
  });
}
const store = { async findPrivateIntake() { return "adopted"; } };
const result = await reconcileInvitePrivateIntake(env, store, now);
assert.equal(result.adopted, 1);
assert.equal(bucket.objects.size, 50);
assert.equal(await nextInvitePrivateReconciliationDue(env), new Date(now + 60_000).toISOString());
console.log("PASS referral R2 pagination: due item beyond first 50 was adopted once");

// Given more than ten full R2 pages of future markers, when the scan resumes
// from its durable cursor, then a due marker beyond the page budget is reached.
const largeBucket = new Bucket();
const largeEnv = { ...env, INVITE_PRIVATE_OBJECTS: largeBucket };
for (let i = 0; i < 551; i += 1) {
  const id = `REQ-${String(i).padStart(8, "0")}`;
  await createInvitePrivateReconciliationMarker(largeEnv, {
    requestId: id, submissionKey: `submission-${id}`,
    objectDigest: "b".repeat(64), opaqueRef: `invite-private/${id}/revision-0-12345678-1234-1234-1234-123456789012.enc`,
    now: i === 550 ? new Date(now - 60_000).toISOString() : new Date(now + 60_000).toISOString(),
  });
}
const first = await reconcileInvitePrivateIntake(largeEnv, store, now);
assert.equal(first.adopted, 0);
assert.equal(first.possiblyMore, true);
assert.ok(first.nextCursor);
const resumed = await reconcileInvitePrivateIntake(largeEnv, store, now, first.nextCursor);
assert.equal(resumed.adopted, 1);
assert.equal(largeBucket.objects.size, 550);
console.log("PASS referral R2 continuation: 550 future markers cannot starve due marker 551");
