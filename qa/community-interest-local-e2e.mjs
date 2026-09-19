import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mock } from 'bun:test';
import siteWorker from '../site/src/index.ts';
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
const { handleRequest } = await import('../src/index.ts');
const { runInterestDue } = await import('../src/community-interest-due.ts');
const { reconcileInterestIntake } = await import('../src/community-interest-reconcile.ts');
const { openCapability } = await import('../site/src/index.ts');
const { sign } = await import('../src/signing.ts');

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const pg = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const tag = randomUUID().replaceAll('-', '').slice(0, 12);
const database = `otl_i_${tag}_e2e`;
const owner = `otl_i_${tag}_owner`;
const runtimeRole = `otl_i_${tag}_runtime`;
const cluster = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'postgres' };
let sqlEnv = cluster;
const run = (binary, args) => exec(join(pg, binary), args, { cwd: root, env: sqlEnv, encoding: 'utf8' });
const sql = async (query) => (await run('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', query])).stdout.trim();
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const secret = Buffer.alloc(32, 3).toString('base64url');
const signing = 'local-slack-signing';
const objects = new Map();
const messages = [];
let privateAdminChannel = true;
let loseSubmitResponse = false;
let failNextCiphertextPut = false;
const bucket = {
  async put(key, bytes, options) {
    if (failNextCiphertextPut && key.startsWith('interest-private/')) {
      failNextCiphertextPut = false;
      throw new Error('R2 unavailable');
    }
    if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
    objects.set(key, bytes.slice(0));
    return { etag: 'one' };
  },
  async get(key) {
    const bytes = objects.get(key);
    return bytes ? { key, etag: 'one', arrayBuffer: async () => bytes.slice(0) } : null;
  },
  async delete(key) { objects.delete(key); },
  async list({ prefix, limit, cursor }) {
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
    return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit,
      cursor: keys.length > limit ? keys[limit - 1] : undefined };
  },
};
const dbUrl = (role) => `postgresql://${role}:local-only@local.neon.tech/${database}`;
const coreEnv = {
  SLACK_TEAM_ID: 'TREF', SLACK_SIGNING_SECRET: signing, SLACK_BOT_TOKEN: 'xoxb-local',
  DATABASE_URL: dbUrl(runtimeRole), INTEREST_RUNTIME_DATABASE_URL: dbUrl(runtimeRole),
  INTEREST_ADMIN_DATABASE_URL: dbUrl('otl_referral_admin_login'),
  INTEREST_MEMBER_DATABASE_URL: dbUrl('otl_interest_member_login'),
  SITE_CORE_HMAC_SECRET: secret, INVITE_EMAIL_PEPPER: secret, INVITE_PRIVATE_KEK: secret,
  INVITE_PRIVATE_KEK_VERSION: 'v1', INVITE_PRIVATE_OBJECTS: bucket,
  INTEREST_ACTION_SECRET: secret, PUBLIC_INTEREST_ENABLED: 'true', REFERRALS_ENABLED: 'true',
  COMMUNITY_ENABLED: 'true', COMMUNITY_ADMIN_ID: 'UADMIN', COMMUNITY_PUBLIC_CHANNEL_ID: 'CREF',
  INTEREST_ADMIN_CHANNEL_ID: 'CADMIN', DATABASE_MAINTENANCE: 'false',
};
const responseRows = (value) => Response.json({ rows: [[value]] });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url);
  if (target.hostname === 'challenges.cloudflare.com') return Response.json({ success: true, hostname: 'example.com' });
  if (target.hostname === 'slack.com' && target.pathname === '/api/conversations.info') {
    return Response.json({ ok: true, channel: { id: target.searchParams.get('channel'),
      context_team_id: 'TREF', is_private: privateAdminChannel, is_im: false, is_mpim: false,
      is_ext_shared: false, is_archived: false } });
  }
  if (target.hostname === 'slack.com') {
    const payload = JSON.parse(init.body);
    messages.push({ method: target.pathname, ...payload });
    return Response.json({ ok: true, ts: String(Date.now()/1000) });
  }
  if (target.hostname.endsWith('.neon.tech')) {
    const connection = new URL(init.headers['Neon-Connection-String']);
    const role = connection.username;
    const body = JSON.parse(init.body);
    const rendered = body.params.reduce((statement, value, index) => statement.replaceAll(`$${index+1}`, quote(value)), body.query);
    const previous = sqlEnv;
    sqlEnv = { ...cluster, PGDATABASE: database, PGUSER: role };
    try {
      const value = await sql(rendered);
      if (loseSubmitResponse && rendered.includes("interest_runtime_execute('submit'")) {
        loseSubmitResponse = false;
        return Response.json({ code: 'XX000' }, { status: 500 });
      }
      return responseRows(value);
    }
    catch (error) { return Response.json({ code: 'XX000' }, { status: 500 }); }
    finally { sqlEnv = previous; }
  }
  return originalFetch(url, init);
};
const core = { fetch: (request) => handleRequest(request, { env: coreEnv, store: {} }, { waitUntil() {} }) };
const siteEnv = {
  ASSETS: { async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    return new Response(await readFile(join(root, 'site/dist', name)), { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  } },
  CORE: core, RATE_LIMITER: { async limit() { return { success: true }; } },
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET: 'local-only',
  SITE_CORE_HMAC_SECRET: secret, PUBLIC_INTEREST_ENABLED: 'true',
};
const site = (path, init = {}) => siteWorker.fetch(new Request(`https://example.com${path}`, init), siteEnv);
async function slackAction(action, userId, channelId, actionTs = `${Math.floor(Date.now()/1000)}.123456`) {
  const payload = { type: 'block_actions', team: { id: 'TREF' }, user: { id: userId },
    container: { channel_id: channelId }, actions: [{ ...action, action_ts: actionTs }] };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = await sign(`v0:${timestamp}:${body}`, signing);
  return core.fetch(new Request('https://core.invalid/slack/interactions', { method: 'POST', body,
    headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}` } }));
}
let created = false;
try {
  assert.equal(await sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'otl_%' OR rolname='legacy_invitation_runtime'"), '0');
  await sql(`CREATE ROLE ${owner} LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION`);
  created = true;
  await sql(`CREATE DATABASE ${database} OWNER ${owner}`);
  sqlEnv = { ...cluster, PGUSER: owner, PGDATABASE: database };
  const migrations = (await readdir(join(root, 'migrations'))).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
  for (const migration of migrations) {
    if (migration.startsWith('006_')) await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', `migrations/${migration}`, '-f', 'migrations/007_normalized_legacy.sql']);
    else if (!migration.startsWith('007_')) await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', `migrations/${migration}`]);
  }
  await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', 'qa/referral-storage-fixture.sql']);
  await sql("INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TREF','UADMIN')");
  await sql(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD NULL`);
  await sql(`GRANT otl_referral_runtime TO ${runtimeRole}`);
  await sql(`SELECT otl.referral_runtime_execute('issue','{"teamId":"TREF","userId":"UREFERRER","linkId":"LNK-INTERESTE2E","tokenDigest":"${'1'.repeat(64)}","now":"${new Date().toISOString()}"}'::jsonb)`);
  const disabledCore = await handleRequest(new Request('https://core.invalid/internal/interest/submit', {
    method: 'POST', body: '{}',
  }), { env: { ...coreEnv, PUBLIC_INTEREST_ENABLED: 'false' }, store: {} }, { waitUntil() {} });
  assert.equal(disabledCore.status, 503);
  const disabledSite = await siteWorker.fetch(new Request('https://example.com/interest'),
    { ...siteEnv, PUBLIC_INTEREST_ENABLED: 'false' });
  assert.equal(disabledSite.status, 503);
  assert.equal((await core.fetch(new Request('https://core.invalid/internal/interest/submit',
    { method: 'POST', body: '{}' }))).status, 401);
  const page = await site('/interest');
  assert.equal(page.status, 200);
  const html = await page.text();
  const submissionKey = html.match(/name="submissionKey" value="([^"]+)"/)?.[1];
  assert.ok(submissionKey);
  const body = new URLSearchParams({ submissionKey, email: 'interest-e2e@example.com',
    displayName: '<@UVICTIM>', intent: 'Learn together', knownMemberClue: 'UREFERRER',
    consent: 'interest-consent-v1', inviteConsent: 'invite-consent-v1',
    shareNameEmailWithIntroducer: 'yes', 'cf-turnstile-response': 'valid-local' });
  const submitted = await site('/interest', { method: 'POST', body });
  assert.equal(submitted.status, 303);
  const receiptPath = submitted.headers.get('location');
  const cookie = submitted.headers.get('set-cookie').split(';')[0];
  const replay = await site('/interest', { method: 'POST', body: new URLSearchParams(body) });
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get('location'), receiptPath);
  assert.equal(await openCapability(secret, receiptPath.slice('/receipt/'.length),
    replay.headers.get('set-cookie').split(';')[0].split('=')[1]),
    await openCapability(secret, receiptPath.slice('/receipt/'.length), cookie.split('=')[1]));
  const changed = new URLSearchParams(body);
  changed.set('intent', 'A changed intention');
  assert.equal((await site('/interest', { method: 'POST', body: changed })).status, 503);
  const duplicate = new URLSearchParams(body);
  duplicate.set('submissionKey', randomUUID());
  const duplicateResponse = await site('/interest', { method: 'POST', body: duplicate });
  assert.equal(duplicateResponse.status, 303);
  assert.equal(duplicateResponse.headers.get('set-cookie'), null);
  await reconcileInterestIntake(coreEnv, Date.now()+16*60_000);
  assert.match(receiptPath, /^\/receipt\/INT-/);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests WHERE team_id='TREF'"), '1');
  assert.equal(await sql("SELECT count(*) FROM otl.referral_requests WHERE team_id='TREF'"), '0');
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 0);
  assert.equal([...objects.keys()].filter((key) => key.startsWith('interest-private/')).length, 1);
  console.log(JSON.stringify({ scenario: 'site-to-core-to-pg', status: 303, interest: 1, referral: 0, ciphertext: 1 }));
  privateAdminChannel = false;
  await runInterestDue(coreEnv, Date.now()+1000);
  assert.equal(messages.filter((entry) => entry.channel === 'CADMIN').length, 0);
  privateAdminChannel = true;
  await runInterestDue(coreEnv, Date.now()+6*60_000);
  const review = messages.find((entry) => entry.channel === 'CADMIN' && JSON.stringify(entry.blocks).includes('community_interest_request'));
  assert.ok(review);
  assert.ok(!JSON.stringify(review).includes('<@UVICTIM>'));
  const select = review.blocks.flatMap((block) => block.elements ?? []).find((element) => element.type === 'users_select');
  assert.equal((await slackAction({ action_id: select.action_id, selected_user: 'UREFERRER' }, 'UADMIN', 'CREF')).status, 200);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_introduction_prompts"), '0');
  assert.equal((await slackAction({ action_id: select.action_id, selected_user: 'UREFERRER' }, 'UADMIN', 'CADMIN')).status, 200);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_introduction_prompts"), '1');
  const dm = messages.find((entry) => entry.channel === 'UREFERRER' && JSON.stringify(entry.blocks).includes('community_interest_confirm'));
  assert.ok(dm);
  const confirm = dm.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === 'community_interest_confirm');
  const confirmTs = `${Math.floor(Date.now()/1000)}.321456`;
  assert.equal((await slackAction(confirm, 'UREFERRER', 'DREFERRER', confirmTs)).status, 200);
  assert.equal((await slackAction(confirm, 'UREFERRER', 'DREFERRER', confirmTs)).status, 200);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_introduction_evidence"), '1');
  assert.equal(await sql("SELECT state FROM otl.interest_requests WHERE team_id='TREF'"), 'introduction_verified');
  await runInterestDue(coreEnv, Date.now()+1000);
  const verified = messages.find((entry) => entry.channel === 'CADMIN' && JSON.stringify(entry.blocks).includes('community_interest_attach'));
  assert.ok(verified);
  const attach = verified.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id.startsWith('community_interest_attach'));
  const attachTs = `${Math.floor(Date.now()/1000)}.456321`;
  assert.equal((await slackAction(attach, 'UADMIN', 'CADMIN', attachTs)).status, 200);
  assert.equal((await slackAction(attach, 'UADMIN', 'CADMIN', attachTs)).status, 200);
  assert.equal(await sql("SELECT state FROM otl.interest_requests WHERE team_id='TREF'"), 'attached');
  assert.equal(await sql("SELECT count(*) FROM otl.interest_referral_bridges WHERE team_id='TREF'"), '1');
  assert.equal(await sql("SELECT state FROM otl.referral_requests WHERE team_id='TREF'"), 'pending');
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 0);
  const attachedId = await sql("SELECT request_id FROM otl.referral_requests WHERE team_id='TREF'");
  sqlEnv = { ...cluster, PGUSER: 'otl_referral_admin_login', PGDATABASE: database };
  await sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify({ teamId: 'TREF',
    adminId: 'UADMIN', requestId: attachedId, expectedRevision: 0, decision: 'approved',
    key: 'interest-e2e-approve', now: new Date().toISOString() })}'::jsonb)`);
  sqlEnv = { ...cluster, PGUSER: owner, PGDATABASE: database };
  assert.equal(await sql("SELECT state FROM otl.referral_requests WHERE team_id='TREF'"), 'approved');
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 1);
  const withdrawPage = await site(receiptPath, { headers: { cookie } });
  const withdrawalKey = (await withdrawPage.text()).match(/name="withdrawalKey" value="([^"]+)"/)?.[1];
  assert.ok(withdrawalKey);
  const withdrawn = await site(`${receiptPath}/withdraw`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ withdrawalKey }) });
  assert.equal(withdrawn.status, 200);
  assert.equal(await sql("SELECT state FROM otl.referral_requests WHERE team_id='TREF'"), 'withdrawn');
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 0);
  const falseBody = new URLSearchParams(body);
  falseBody.set('submissionKey', randomUUID());
  falseBody.set('email', 'false-share@example.com');
  falseBody.delete('shareNameEmailWithIntroducer');
  assert.equal((await site('/interest', { method: 'POST', body: falseBody })).status, 303);
  await runInterestDue(coreEnv, Date.now()+1000);
  const falseCard = messages.find((entry) => entry.channel === 'CADMIN' && entry.text?.startsWith('소개가 필요한 참여 문의')
    && JSON.stringify(entry.blocks).includes('false-share@example.com'));
  assert.ok(falseCard);
  assert.ok(!JSON.stringify(falseCard).includes('community_interest_request'));
  assert.ok(messages.filter((entry) => entry.channel === 'UREFERRER')
    .every((entry) => !JSON.stringify(entry).includes('false-share@example.com')));
  const falseInterestId = await sql("SELECT interest_id FROM otl.interest_requests WHERE team_id='TREF' AND state='pending_introduction'");
  sqlEnv = { ...cluster, PGUSER: 'otl_referral_admin_login', PGDATABASE: database };
  await assert.rejects(sql(`SELECT otl.interest_admin_execute('verify_offline','${JSON.stringify({
    teamId: 'TREF', adminId: 'UADMIN', interestId: falseInterestId, expectedRevision: 0,
    key: 'arbitrary-digest-attempt', memberId: 'UREFERRER', evidenceType: 'offline_document',
    evidenceDigest: 'f'.repeat(64), evidenceAt: new Date().toISOString(), now: new Date().toISOString(),
  })}'::jsonb)`), /offline introduction unavailable/);
  sqlEnv = { ...cluster, PGUSER: owner, PGDATABASE: database };
  assert.equal(await sql(`SELECT state FROM otl.interest_requests WHERE interest_id='${falseInterestId}'`), 'pending_introduction');
  assert.equal(await sql(`SELECT count(*) FROM otl.interest_introduction_prompts WHERE interest_id='${falseInterestId}'`), '0');
  const lostBody = new URLSearchParams(body);
  lostBody.set('submissionKey', randomUUID());
  lostBody.set('email', 'lost-response@example.com');
  loseSubmitResponse = true;
  assert.equal((await site('/interest', { method: 'POST', body: lostBody })).status, 503);
  const recovered = await site('/interest', { method: 'POST', body: lostBody });
  assert.equal(recovered.status, 303);
  assert.match(recovered.headers.get('set-cookie') ?? '', /HttpOnly/);
  await reconcileInterestIntake(coreEnv, Date.now()+1000);
  assert.equal([...objects.keys()].filter((key) => key.startsWith('interest-private-reconcile/')).length, 0);
  const failedBody = new URLSearchParams(body);
  failedBody.set('submissionKey', randomUUID());
  failedBody.set('email', 'r2-failure@example.com');
  failNextCiphertextPut = true;
  assert.equal((await site('/interest', { method: 'POST', body: failedBody })).status, 503);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests WHERE team_id='TREF'"), '3');
  await reconcileInterestIntake(coreEnv, Date.now()+16*60_000);
  assert.equal([...objects.keys()].filter((key) => key.startsWith('interest-private-reconcile/')).length, 0);
  const firstObjectRef = await sql("SELECT opaque_ref FROM otl.interest_private_payloads pp JOIN otl.interest_requests ir USING(team_id,interest_id) WHERE ir.team_id='TREF' AND ir.state='withdrawn'");
  await runInterestDue(coreEnv, Date.now()+25*60*60_000);
  assert.equal(objects.has(firstObjectRef), false);
  assert.equal(await sql("SELECT purge_status FROM otl.interest_private_payloads WHERE opaque_ref='" + firstObjectRef + "'"), 'purged');
  const dump = (await run('pg_dump', ['--data-only', '--schema=otl', database])).stdout;
  assert.ok(!dump.includes('interest-e2e@example.com') && !dump.includes('<@UVICTIM>')
    && !dump.includes('Learn together'));
  assert.ok(messages.every((entry) => entry.method === '/api/chat.postMessage'));
  console.log(JSON.stringify({ scenario: 'replay-consent-quota-recovery', replay: true, duplicateNoCapability: true,
    falseShareBlocked: true, reservationAfterApproval: 1, releasedAfterWithdrawal: true,
    recoveredCapability: true, r2MarkerAdopted: true, sqlPiiAbsent: true, r2FailureNoRow: true, retentionObjectPurged: true, defaultOff: true, publicAdminChannelRejected: true }));
  console.log(JSON.stringify({ scenario: 'signed-private-introduction-attach-withdraw', prompt: 1, bridge: 1, pending: true, withdrawn: true, adminChannel: 'CADMIN' }));
  console.log('INTEREST_LOCAL_E2E=PASS');
} finally {
  globalThis.fetch = originalFetch;
  sqlEnv = cluster;
  if (created) {
    await sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of ['otl_interest_member_login','otl_interest_member','otl_referral_admin_login',
      'otl_referral_admin','otl_referral_runtime','otl_lifecycle_admin_login','otl_lifecycle_admin',
      'otl_lifecycle_runtime','otl_guide_admin','otl_guide_runtime','legacy_invitation_runtime',runtimeRole,owner])
      await sql(`DROP ROLE IF EXISTS ${role}`);
    console.log(JSON.stringify({ scenario: 'local-pg-cleanup', database, dropped: true }));
  }
}
