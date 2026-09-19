import assert from "node:assert/strict";
import {
  createInvitePrivateReconciliationMarker,
  reconcileInvitePrivateIntake,
  nextInvitePrivateReconciliationDue,
} from "../src/community-referral-reconcile.ts";

class Bucket {
  objects = new Map();
  version = 0;
  cursors = new Map();
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
    if (cursor && !this.cursors.has(cursor)) throw new Error("Invalid opaque R2 cursor");
    const after = cursor ? this.cursors.get(cursor) : null;
    const index = after ? keys.findIndex((key) => key > after) : 0;
    const start = index < 0 ? keys.length : index;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    const nextCursor = truncated ? `opaque-r2-cursor-${this.cursors.size + 1}` : null;
    if (nextCursor) this.cursors.set(nextCursor, page.at(-1));
    return {
      objects: page.map((key) => ({ key })), truncated,
      ...(nextCursor ? { cursor: nextCursor } : {}),
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

// Twelve due markers straddle the first and second opaque R2 list pages.
const dueBucket = new Bucket();
const dueEnv = { ...env, INVITE_PRIVATE_OBJECTS: dueBucket };
for (let i = 0; i < 57; i += 1) {
  const id = `REQ-${String(i).padStart(8, "0")}`;
  await createInvitePrivateReconciliationMarker(dueEnv, {
    requestId: id, submissionKey: `submission-${id}`,
    objectDigest: "c".repeat(64), opaqueRef: `invite-private/${id}/revision-0-12345678-1234-1234-1234-123456789012.enc`,
    now: i >= 45 ? new Date(now - 60_000).toISOString() : new Date(now + 60_000).toISOString(),
  });
}
const dueFirst = await reconcileInvitePrivateIntake(dueEnv, store, now);
assert.equal(dueFirst.adopted, 10);
assert.equal(dueFirst.possiblyMore, true);
const dueSecond = await reconcileInvitePrivateIntake(dueEnv, store, now, dueFirst.nextCursor ?? undefined);
assert.equal(dueSecond.adopted, 2);
assert.equal(dueBucket.objects.size, 45);
console.log("PASS opaque R2 continuation: 12 due across pages drain 10+2");

// Independent claims on the same opaque listing cannot adopt one marker twice.
const concurrentBucket = new Bucket();
const concurrentEnv = { ...env, INVITE_PRIVATE_OBJECTS: concurrentBucket };
for (let i = 0; i < 12; i += 1) {
  const id = `REQ-C${String(i).padStart(7, "0")}`;
  await createInvitePrivateReconciliationMarker(concurrentEnv, {
    requestId: id, submissionKey: `submission-${id}`,
    objectDigest: "d".repeat(64), opaqueRef: `invite-private/${id}/revision-0-12345678-1234-1234-1234-123456789012.enc`,
    now: new Date(now - 60_000).toISOString(),
  });
}
const concurrent = await Promise.all([
  reconcileInvitePrivateIntake(concurrentEnv, store, now),
  reconcileInvitePrivateIntake(concurrentEnv, store, now),
]);
assert.equal(concurrent.reduce((total, item) => total + item.adopted, 0), 12);
assert.equal(concurrentBucket.objects.size, 0);

// A database outage retains ciphertext and retries its signed marker.
const outageBucket = new Bucket();
const outageEnv = { ...env, INVITE_PRIVATE_OBJECTS: outageBucket };
await createInvitePrivateReconciliationMarker(outageEnv, {
  requestId: "REQ-OUTAGE001", submissionKey: "submission-outage-001",
  objectDigest: "e".repeat(64),
  opaqueRef: "invite-private/REQ-OUTAGE001/revision-0-12345678-1234-1234-1234-123456789012.enc",
  now: new Date(now - 60_000).toISOString(),
});
const failed = await reconcileInvitePrivateIntake(outageEnv, {
  async findPrivateIntake() { throw new Error("synthetic DB outage"); },
}, now);
assert.equal(failed.retried, 1);
assert.equal(outageBucket.objects.size, 1);
const recovered = await reconcileInvitePrivateIntake(outageEnv, store, now + 60_001);
assert.equal(recovered.adopted, 1);
assert.equal(outageBucket.objects.size, 0);
console.log("PASS opaque R2 safety: concurrent claims adopt twelve once; DB outage preserves then retries marker");
