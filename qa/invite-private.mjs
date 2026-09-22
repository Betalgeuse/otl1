import assert from "node:assert/strict";
import {
  InvitePrivateError,
  deleteInvitePrivateObject,
  readInvitePrivateObject,
  writeInvitePrivateObject,
} from "../src/community-invite-private.ts";
import {
  readBugPrivateObject,
  writeBugPrivateObject,
} from "../src/community-bug-private.ts";
import {
  ReferralTokenError,
  digestNormalizedInviteEmail,
  digestReferralToken,
  issueReferralToken,
} from "../src/community-referral-token.ts";

class MemoryBucket {
  objects = new Map();
  deleteCalls = 0;

  async put(key, value) {
    this.objects.set(key, value.slice(0));
  }

  async get(key) {
    const value = this.objects.get(key);
    return value ? { arrayBuffer: async () => value.slice(0) } : null;
  }

  async delete(key) {
    this.deleteCalls += 1;
    this.objects.delete(key);
  }
}

const key = Buffer.alloc(32, 7).toString("base64url");
const otherKey = Buffer.alloc(32, 9).toString("base64url");
const bucket = new MemoryBucket();
const config = { bucket, kek: key, keyVersion: "invite-kek-2026-01" };
const payload = {
  email: "person@example.com",
  displayName: "지원자",
  intent: "함께 매일 한 가지를 기록하고 싶습니다.",
};

const referralTokenA = await issueReferralToken();
const referralTokenB = await issueReferralToken();
assert.match(referralTokenA.token, /^[A-Za-z0-9_-]{32}$/);
assert.match(referralTokenA.digest, /^[0-9a-f]{64}$/);
assert.notEqual(referralTokenA.token, referralTokenB.token);
assert.equal(await digestReferralToken(referralTokenA.token), referralTokenA.digest);
assert.equal(
  await digestNormalizedInviteEmail(" Person@Example.COM ", key),
  await digestNormalizedInviteEmail("person@example.com", key),
);
assert.notEqual(
  await digestNormalizedInviteEmail("person@example.com", key),
  await digestNormalizedInviteEmail("person@example.com", otherKey),
);
await assert.rejects(
  digestNormalizedInviteEmail("ｐｅｒｓｏｎ＠example.com", key),
  ReferralTokenError,
);

const stored = await writeInvitePrivateObject(config, "REQ-PRIVATE000001", 0, payload);
assert.match(stored.opaqueRef, /^invite-private\/REQ-PRIVATE000001\/revision-0-[0-9a-f-]+\.enc$/);
assert.match(stored.objectDigest, /^[0-9a-f]{64}$/);
assert.equal(stored.keyVersion, "invite-kek-2026-01");
assert.deepEqual(await readInvitePrivateObject(config, { ...stored, requestId: "REQ-PRIVATE000001", revision: 0 }), payload);

await assert.rejects(
  readInvitePrivateObject({ ...config, kek: otherKey }, { ...stored, requestId: "REQ-PRIVATE000001", revision: 0 }),
  InvitePrivateError,
);
await assert.rejects(
  readInvitePrivateObject({ ...config, keyVersion: "invite-kek-2026-02" }, { ...stored, requestId: "REQ-PRIVATE000001", revision: 0 }),
  InvitePrivateError,
);
await assert.rejects(
  readInvitePrivateObject(config, { ...stored, requestId: "REQ-PRIVATE000002", revision: 0 }),
  InvitePrivateError,
);
await assert.rejects(
  readInvitePrivateObject(config, {
    ...stored,
    opaqueRef: stored.opaqueRef.replace("invite-private/", "bugs/"),
    requestId: "REQ-PRIVATE000001",
    revision: 0,
  }),
  InvitePrivateError,
);

const ciphertext = bucket.objects.get(stored.opaqueRef);
assert.ok(ciphertext);
assert.doesNotMatch(
  new TextDecoder().decode(ciphertext),
  /person@example\.com|지원자|함께 매일 한 가지/,
);
new Uint8Array(ciphertext)[0] ^= 1;
await assert.rejects(
  readInvitePrivateObject(config, { ...stored, requestId: "REQ-PRIVATE000001", revision: 0 }),
  InvitePrivateError,
);
bucket.objects.set(stored.opaqueRef, ciphertext);

await deleteInvitePrivateObject(config, stored.opaqueRef);
await deleteInvitePrivateObject({ ...config, kek: undefined }, stored.opaqueRef);
assert.equal(bucket.deleteCalls, 2);
await assert.rejects(
  readInvitePrivateObject(config, { ...stored, requestId: "REQ-PRIVATE000001", revision: 0 }),
  InvitePrivateError,
);

const missingBucketConfig = { bucket: undefined, kek: key, keyVersion: "invite-kek-2026-01" };
await assert.rejects(
  writeInvitePrivateObject(missingBucketConfig, "REQ-PRIVATE000003", 0, payload),
  InvitePrivateError,
);

const bugBucket = new MemoryBucket();
const bugContext = {
  env: {
    BUG_PRIVATE_OBJECTS: bugBucket,
    BUG_PRIVATE_KEK: key,
    BUG_PRIVATE_KEK_VERSION: "bug-kek-baseline",
  },
};
const bugStored = await writeBugPrivateObject(
  bugContext,
  "BUG-BASELINE00000001",
  1,
  { value: "bug-private-baseline" },
);
assert.deepEqual(
  await readBugPrivateObject(bugContext, {
    ...bugStored,
    bugId: "BUG-BASELINE00000001",
    revision: 1,
    schemaVersion: "bug_intake.v1",
  }),
  { value: "bug-private-baseline" },
);
const bugCiphertext = bugBucket.objects.get(bugStored.opaqueRef);
assert.ok(bugCiphertext);
new Uint8Array(bugCiphertext)[0] ^= 1;
await assert.rejects(
  readBugPrivateObject(bugContext, {
    ...bugStored,
    bugId: "BUG-BASELINE00000001",
    revision: 1,
    schemaVersion: "bug_intake.v1",
  }),
);

console.log(
  `PASS invite private: random-token-bits=192 token-digest=sha256 email-digest=hmac-sha256-normalized bucket=invite-private objects=1 digest=${stored.objectDigest.slice(0, 12)} roundtrip=1 ciphertext-pii=absent wrong-key=denied wrong-version=denied aad-swap=denied namespace-swap=denied tamper=denied missing=denied purge-retry=2 bug-private-baseline=roundtrip+tamper-denied`,
);
