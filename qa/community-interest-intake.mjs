import assert from 'node:assert/strict';
import { handleInterestIntakeRequest } from '../src/community-interest-intake.ts';
import { signReferralServiceRequest } from '../src/community-referral-intake.ts';

const secret = Buffer.alloc(32, 7).toString('base64url');
const objects = new Map();
const bucket = {
  async put(key, value, options) {
    if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
    objects.set(key, value);
    return { etag: 'etag' };
  },
  async get(key) {
    const value = objects.get(key);
    return value ? { key, etag: 'etag', arrayBuffer: async () => value } : null;
  },
  async delete(key) { objects.delete(key); },
  async list() { return { objects: [], truncated: false }; },
};
const env = {
  SLACK_TEAM_ID: 'TTEST', SITE_CORE_HMAC_SECRET: secret,
  INVITE_EMAIL_PEPPER: secret, INVITE_PRIVATE_KEK: secret,
  INVITE_PRIVATE_KEK_VERSION: 'v1', INVITE_PRIVATE_OBJECTS: bucket,
};
const rows = new Map();
const nonces = new Set();
const store = {
  async claimServiceNonce(digest) {
    if (nonces.has(digest)) return false;
    nonces.add(digest);
    return true;
  },
  async submit(input) {
    const old = rows.get(input.key);
    if (old) {
      if (old.contentDigest !== input.contentDigest) throw new Error('interest idempotency collision');
      return { accepted: true, receiptId: old.receiptId, sameSubmissionKey: true };
    }
    rows.set(input.key, input);
    return { accepted: true, receiptId: input.receiptId, created: true, sameSubmissionKey: true };
  },
  async withdraw(input) {
    const row = [...rows.values()].find((value) => value.receiptId === input.receiptId);
    assert.equal(row?.withdrawalDigest, input.withdrawalDigest);
    return { accepted: true, receiptId: input.receiptId };
  },
  async findSubmission(teamId, key) {
    const old = rows.get(key);
    return old ? { accepted: true, receiptId: old.receiptId, sameSubmissionKey: true } : null;
  },
  async findPrivateIntake() { return 'absent'; },
};
const body = {
  submissionKey: 'interest-key-0001', consentVersion: 'interest-consent-v1',
  consentedAt: new Date().toISOString(), inviteConsentAccepted: true,
  inviteConsentedAt: new Date().toISOString(), email: 'Person@Example.com',
  displayName: 'Person', intent: 'To learn', knownMemberClue: '',
  shareNameEmailWithIntroducer: false,
};
async function request(path, payload, nonce = crypto.randomUUID()) {
  const text = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signReferralServiceRequest({ method: 'POST', path, body: text, timestamp, nonce }, secret);
  return new Request(`https://core.invalid${path}`, { method: 'POST', body: text, headers: {
    'x-otl-timestamp': String(timestamp), 'x-otl-nonce': nonce, 'x-otl-signature': signature,
  } });
}
const path = '/internal/interest/submit';
const first = await handleInterestIntakeRequest(await request(path, body), env, store);
assert.equal(first.status, 202);
const accepted = await first.json();
assert.match(accepted.receiptId, /^INT-/);
assert.match(accepted.withdrawalToken, /^[A-Za-z0-9_-]{43}$/);
assert.equal(rows.size, 1);
const replay = await handleInterestIntakeRequest(await request(path, { ...body, consentedAt: new Date().toISOString() }), env, store);
assert.equal(replay.status, 202);
assert.deepEqual(await replay.json(), accepted);
const changed = await handleInterestIntakeRequest(await request(path, { ...body, intent: 'Different' }), env, store);
assert.notEqual(changed.status, 202);
const denied = await handleInterestIntakeRequest(new Request(`https://core.invalid${path}`, { method: 'POST', body: JSON.stringify(body) }), env, store);
assert.equal(denied.status, 401);
const withdrawal = await handleInterestIntakeRequest(await request('/internal/interest/withdraw', {
  receiptId: accepted.receiptId, withdrawalToken: accepted.withdrawalToken, withdrawalKey: 'withdraw-key-001',
}), env, store);
assert.equal(withdrawal.status, 202);
console.log('INTEREST_INTAKE=PASS created=1 replay=1 changed=reject unsigned=reject withdraw=1');
