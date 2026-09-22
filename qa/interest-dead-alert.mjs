import assert from 'node:assert/strict';
import { reconcileInterestIntake } from '../src/community-interest-reconcile.ts';
import { sign, verify } from '../src/signing.ts';

const secret = 'local-interest-dead-alert-secret';
const teamId = 'TALERT';
const now = Date.parse('2026-09-20T12:00:00.000Z');
const digest = async (value) => Buffer.from(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value))).toString('hex');
const prefix = `interest-private-reconcile/v1/${await digest(teamId)}/`;
const entries = new Map();
let version = 0;
let failReceipt = false;
const bucket = {
  async put(key, bytes, options) {
    const previous = entries.get(key);
    if (options?.onlyIf?.etagMatches && previous?.etag !== options.onlyIf.etagMatches) return null;
    if (options?.onlyIf?.etagDoesNotMatch === '*' && previous) return null;
    if (failReceipt && JSON.parse(new TextDecoder().decode(bytes)).marker.includes('"alertStatus":"alerted"')) {
      failReceipt = false;
      return null;
    }
    const stored = { bytes: bytes.slice(0), etag: `v${++version}` };
    entries.set(key, stored);
    return { etag: stored.etag };
  },
  async get(key) {
    const item = entries.get(key);
    return item ? { etag: item.etag, arrayBuffer: async () => item.bytes.slice(0) } : null;
  },
  async delete(key) { entries.delete(key); },
  async list({ prefix: scope, limit, cursor }) {
    const keys = [...entries.keys()].filter((key) => key.startsWith(scope) && (!cursor || key > cursor)).sort();
    return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit,
      cursor: keys.length > limit ? keys[limit - 1] : undefined };
  },
};
const messages = [];
let privateChannel = true;
let postFailure = null;
let dbState = 'conflict';
let dbOutage = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url));
  if (target.hostname === 'local.neon.tech') {
    const body = JSON.parse(init.body);
    assert.match(body.query, /find_private_intake/);
    return dbOutage ? Response.json({ code: 'XX000' }, { status: 500 })
      : Response.json({ rows: [[JSON.stringify(dbState)]] });
  }
  if (target.pathname === '/api/conversations.info') return Response.json({ ok: true,
    channel: { id: target.searchParams.get('channel'), context_team_id: teamId, is_private: privateChannel,
      is_im: false, is_mpim: false, is_ext_shared: false, is_archived: false } });
  if (target.pathname === '/api/chat.postMessage') {
    if (postFailure === 429 || postFailure === 500)
      return Response.json({ ok: false, error: 'temporary' }, { status: postFailure });
    const posted = JSON.parse(init.body);
    messages.push(posted);
    if (postFailure === 'response-lost') { postFailure = null; throw new TypeError('accepted response lost'); }
    return Response.json({ ok: true, ts: `${messages.length}.000001` });
  }
  if (target.pathname === '/api/conversations.history') return Response.json({ ok: true,
    messages: messages.map((item) => ({ text: item.text, bot_id: 'BLOCAL' })), has_more: false });
  throw new Error(`Unexpected request ${target.pathname}`);
};
const env = { SLACK_TEAM_ID: teamId, SLACK_BOT_TOKEN: 'xoxb-local', SITE_CORE_HMAC_SECRET: secret,
  INVITE_PRIVATE_OBJECTS: bucket, INTEREST_RUNTIME_DATABASE_URL: 'postgresql://local:local@local.neon.tech/local',
  PUBLIC_INTEREST_ENABLED: 'false', COMMUNITY_PUBLIC_CHANNEL_ID: 'CPUBLIC',
  INTEREST_ADMIN_CHANNEL_ID: 'CADMIN', DATABASE_MAINTENANCE: 'false' };
const ref = (id) => `interest-private/${id}/revision-0-local.enc`;
const key = (id) => `${prefix}${id}.json`;
async function seed(id, status = 'dead', valid = true) {
  const raw = JSON.stringify({ interestId: id, submissionKeyDigest: 'a'.repeat(64),
    objectDigest: 'b'.repeat(64), opaqueRef: ref(id), createdAt: new Date(now - 60_000).toISOString(), status });
  await bucket.put(key(id), new TextEncoder().encode(JSON.stringify({ marker: raw,
    signature: valid ? await sign(raw, secret) : '0'.repeat(64) })).buffer);
}
async function state(id) {
  const stored = JSON.parse(new TextDecoder().decode(await (await bucket.get(key(id))).arrayBuffer()));
  assert.equal(await verify(stored.marker, stored.signature, secret), true);
  return JSON.parse(stored.marker);
}
function reset() { entries.clear(); messages.length = 0; privateChannel = true;
  postFailure = null; failReceipt = false; dbState = 'conflict'; dbOutage = false; }
try {
  // Given a signed dead marker with public intake disabled, when scanned, then alert privately once.
  await seed('IREQ-DEAD-001');
  await reconcileInterestIntake(env, now);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].channel, 'CADMIN');
  assert.match(messages[0].client_msg_id, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(messages[0]).includes(ref('IREQ-DEAD-001')));
  assert.equal((await state('IREQ-DEAD-001')).alertStatus, 'alerted');
  await reconcileInterestIntake(env, now + 60_000);
  assert.equal(messages.length, 1);
  assert.equal(entries.has(key('IREQ-DEAD-001')), true);
  console.log('scenario=disabled-public-dead-alert-once PASS');

  // Given Slack accepted a post but its response was lost, when the lease expires, history recovers it.
  reset(); await seed('IREQ-LOST-001'); postFailure = 'response-lost';
  assert.equal((await reconcileInterestIntake(env, now)).retryNeeded, true);
  assert.equal(messages.length, 1);
  assert.equal((await state('IREQ-LOST-001')).alertStatus, 'alert_pending');
  await reconcileInterestIntake(env, now + 120_001);
  assert.equal(messages.length, 1);
  assert.equal((await state('IREQ-LOST-001')).alertStatus, 'alerted');
  console.log('scenario=accepted-response-lost-reconciled PASS');

  // Given two workers and one signed marker, when both scan, then CAS admits one post.
  reset(); await seed('IREQ-RACE-001');
  await Promise.all([reconcileInterestIntake(env, now), reconcileInterestIntake(env, now)]);
  assert.equal(messages.length, 1);
  assert.equal((await state('IREQ-RACE-001')).alertStatus, 'alerted');
  console.log('scenario=concurrent-cas-one-post PASS');

  // Given receipt CAS fails after Slack accepted, when retried, bot history prevents a second post.
  reset(); await seed('IREQ-ETAG-001'); failReceipt = true;
  assert.equal((await reconcileInterestIntake(env, now)).retryNeeded, true);
  assert.equal(messages.length, 1);
  await reconcileInterestIntake(env, now + 120_001);
  assert.equal(messages.length, 1);
  assert.equal((await state('IREQ-ETAG-001')).alertStatus, 'alerted');
  console.log('scenario=receipt-cas-recovery PASS');

  // Given a bad signature or different team prefix, when scanned, then no data is trusted or posted.
  reset(); await seed('IREQ-TAMPER-001', 'dead', false);
  await reconcileInterestIntake(env, now);
  await reconcileInterestIntake({ ...env, SLACK_TEAM_ID: 'TOTHER' }, now);
  assert.equal(messages.length, 0);
  assert.equal(entries.has(key('IREQ-TAMPER-001')), true);
  console.log('scenario=signature-and-team-isolation PASS');

  // Given a digest mismatch after an absent DB lookup, when scanned, then ciphertext stays and alerts.
  reset(); dbState = 'absent'; await seed('IREQ-DIGEST-001', 'pending');
  await bucket.put(ref('IREQ-DIGEST-001'), new Uint8Array([1, 2, 3]).buffer);
  await reconcileInterestIntake(env, now + 16 * 60_000);
  assert.equal((await state('IREQ-DIGEST-001')).status, 'dead');
  assert.equal((await state('IREQ-DIGEST-001')).alertStatus, 'alerted');
  assert.equal(entries.has(ref('IREQ-DIGEST-001')), true);
  assert.equal(messages.length, 1);
  console.log('scenario=digest-dead-preserves-ciphertext PASS');

  // Given a DB outage, when scanned, then marker and ciphertext remain for retry.
  reset(); dbOutage = true; await seed('IREQ-DB-001', 'pending');
  await assert.rejects(reconcileInterestIntake(env, now));
  assert.equal((await state('IREQ-DB-001')).status, 'pending');
  assert.equal(messages.length, 0);
  console.log('scenario=db-outage-preserves-marker PASS');

  // Given a missing private channel and Slack 429/5xx, when retried, no false receipt is signed.
  for (const fault of ['private', 429, 500]) {
    reset(); await seed('IREQ-RETRY-001');
    if (fault === 'private') privateChannel = false;
    else postFailure = fault;
    assert.equal((await reconcileInterestIntake(env, now)).retryNeeded, true);
    assert.notEqual((await state('IREQ-RETRY-001')).alertStatus, 'alerted');
    privateChannel = true; postFailure = null;
    await reconcileInterestIntake(env, now + 120_001);
    assert.equal((await state('IREQ-RETRY-001')).alertStatus, 'alerted');
    assert.equal(messages.length, 1);
  }
  console.log('scenario=private-gate-and-slack-retry PASS');

  // Given the first marker needs retry, when the same batch reaches a second marker, it still alerts.
  reset(); await seed('IREQ-AFAIL-001'); await seed('IREQ-BSUCCESS-001');
  postFailure = 'response-lost';
  assert.equal((await reconcileInterestIntake(env, now)).retryNeeded, true);
  assert.equal(messages.length, 2);
  assert.equal((await state('IREQ-BSUCCESS-001')).alertStatus, 'alerted');
  console.log('scenario=failed-head-does-not-skip-next PASS');

  // Given twelve dead markers beyond the two-item budget, when cursors advance, none starves.
  reset();
  for (let i = 0; i < 12; i += 1) await seed(`IREQ-BACKLOG-${String(i).padStart(2, '0')}`);
  let cursor;
  for (let i = 0; i < 8; i += 1) {
    const result = await reconcileInterestIntake(env, now, cursor);
    cursor = result.nextCursor ?? undefined;
    if (!result.possiblyMore) break;
  }
  assert.equal(messages.length, 12);
  assert.ok([...entries.keys()].filter((item) => item.startsWith(prefix)).length === 12);
  assert.ok(messages.every((message) => message.channel === 'CADMIN' && !JSON.stringify(message).includes('interest-private/')));
  console.log('scenario=backlog-10-plus-2-no-starvation PASS');
  console.log('INTEREST_DEAD_ALERT=PASS');
} finally { globalThis.fetch = originalFetch; }
