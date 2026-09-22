import assert from 'node:assert/strict';
import {
  prepareInterestPrivateObject,
  putPreparedInterestPrivateObject,
  readInterestPrivateObject,
  deleteInterestPrivateObject,
  InterestPrivateError,
} from '../src/community-interest-private.ts';
import { readInvitePrivateObject } from '../src/community-invite-private.ts';

const stored = new Map();
const bucket = {
  async put(key, bytes) { stored.set(key, bytes.slice(0)); },
  async get(key) {
    const bytes = stored.get(key);
    return bytes ? { async arrayBuffer() { return bytes.slice(0); } } : null;
  },
  async delete(key) { stored.delete(key); },
};
const kek = Buffer.alloc(32, 7).toString('base64url');
const config = { bucket, kek, keyVersion: 'interest-kek-2026-01' };
const interestId = 'IREQ-CRYPTO1';
const payload = { email: 'Person@example.com', displayName: 'Person', intent: 'Interested in joining', knownMemberClue: 'Met a member' };
const prepared = await prepareInterestPrivateObject(config, interestId, 0, payload);
assert.equal(stored.size, 0, 'prepare must not accept intake');
await putPreparedInterestPrivateObject(config, prepared);
const ref = { ...prepared.ref, requestId: interestId, revision: 0 };
assert.deepEqual(await readInterestPrivateObject(config, ref), { ...payload, email: 'person@example.com' });
assert.ok(ref.opaqueRef.startsWith('interest-private/IREQ-CRYPTO1/'));
assert.equal(ref.schemaVersion, 'interest-application.v1');
await assert.rejects(readInterestPrivateObject(config, { ...ref, objectDigest: '0'.repeat(64) }), (error) => error instanceof InterestPrivateError && error.code === 'integrity');
await assert.rejects(readInterestPrivateObject(config, { ...ref, requestId: 'IREQ-CRYPTO2' }), (error) => error instanceof InterestPrivateError && error.code === 'integrity');
await assert.rejects(readInterestPrivateObject(config, { ...ref, revision: 1 }), (error) => error instanceof InterestPrivateError && error.code === 'integrity');
const flipped = new Uint8Array(prepared.ciphertext.slice(0));
flipped[0] ^= 1;
stored.set(ref.opaqueRef, flipped.buffer);
const alteredDigest = Buffer.from(await crypto.subtle.digest('SHA-256', flipped)).toString('hex');
await assert.rejects(readInterestPrivateObject(config, { ...ref, objectDigest: alteredDigest }), (error) => error instanceof InterestPrivateError && error.code === 'integrity');
stored.set(ref.opaqueRef, prepared.ciphertext);
await assert.rejects(readInvitePrivateObject(config, { ...ref, schemaVersion: 'invite-application.v1' }), /invite private integrity/);
await deleteInterestPrivateObject(config, ref.opaqueRef);
assert.equal(await bucket.get(ref.opaqueRef), null);
console.log(JSON.stringify({ scenario: 'interest-private', encryptedObject: 1, roundTrip: true, digestTamperDenied: true, aadSwapDenied: true, ciphertextTamperDenied: true, referralSwapDenied: true, deleteObserved: true }));
console.log('INTEREST_PRIVATE=PASS');
