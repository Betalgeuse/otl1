import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { prepareInterestPrivateObject, putPreparedInterestPrivateObject, readInterestPrivateObject, deleteInterestPrivateObject } from '../src/community-interest-private.ts';
import { CommunityInterestStore } from '../src/community-interest-store.ts';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const pg = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const tag = randomUUID().replaceAll('-', '').slice(0, 12);
const freshDb = `otl_i_${tag}_fresh`;
const upgradeDb = `otl_i_${tag}_upgrade`;
const ownerRole = `otl_i_${tag}_owner`;
const runtimeProbeRole = `otl_i_${tag}_runtime`;
const clusterEnv = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'postgres' };
let dbEnv = clusterEnv;
const run = (bin, args) => exec(join(pg, bin), args, { cwd: root, env: dbEnv, encoding: 'utf8' });
const sql = async (query) => (await run('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', query])).stdout.trim();
let created = false;
try {
  assert.equal(await sql("SELECT current_setting('server_version_num')::integer BETWEEN 170000 AND 179999"), 't');
  assert.equal(await sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'otl_%' OR rolname='legacy_invitation_runtime'"), '0', 'local service has existing OTL roles; do not mutate them');
  await sql(`CREATE ROLE ${ownerRole} LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION`);
  created = true;
  await sql(`CREATE DATABASE ${freshDb} OWNER ${ownerRole}`);
  dbEnv = { ...clusterEnv, PGUSER: ownerRole, PGDATABASE: freshDb };
  const migrations = (await readdir(join(root, 'migrations'))).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
  for (const migration of migrations) {
    if (migration.startsWith('006_')) await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', `migrations/${migration}`, '-f', 'migrations/007_normalized_legacy.sql']);
    else if (!migration.startsWith('007_')) await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', `migrations/${migration}`]);
  }
  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests"), '0');
  await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', 'qa/referral-storage-fixture.sql']);
  await sql("INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TREF','UADMIN')");
  const now = '2026-09-19T01:00:00Z';
  const call = (fn, op, value) => sql(`SELECT otl.${fn}('${op}','${JSON.stringify(value)}'::jsonb)`);
  const submit = (suffix, emailDigest) => ({
    teamId: 'TREF', interestId: `IREQ-${suffix}`, receiptId: `INT-${suffix}`,
    emailDigest, contentDigest: '7'.repeat(64), withdrawalDigest: 'b'.repeat(64), consentVersion: 'interest-consent-v1',
    consentedAt: now, inviteConsentAccepted: true, inviteConsentedAt: now, shareNameEmailWithIntroducer: false, key: `interest-submit-${suffix}`,
    opaqueRef: `interest-private/IREQ-${suffix}/revision-0-12345678-1234-1234-1234-123456789abc.enc`,
    objectDigest: 'c'.repeat(64), envelopeDek: 'opaque.envelope', nonce: 'opaque-nonce',
    keyVersion: 'interest-kek-2026-01', schemaVersion: 'interest-application.v1', now,
  });
  const objects = new Map();
  const bucket = {
    async put(key, bytes) { objects.set(key, bytes.slice(0)); },
    async get(key) { const bytes = objects.get(key); return bytes ? { async arrayBuffer() { return bytes.slice(0); } } : null; },
    async delete(key) { objects.delete(key); },
  };
  const privateConfig = { bucket, kek: Buffer.alloc(32, 7).toString('base64url'), keyVersion: 'interest-kek-2026-01' };
  const privatePayload = { email: 'person@example.com', displayName: 'Person', intent: 'A private interest', knownMemberClue: 'Met a member' };
  const prepared = await prepareInterestPrivateObject(privateConfig, 'IREQ-FIRST1', 0, privatePayload);
  await putPreparedInterestPrivateObject(privateConfig, prepared);
  const first = { ...submit('FIRST1', 'a'.repeat(64)), ...prepared.ref, shareNameEmailWithIntroducer: true };
  assert.deepEqual(await readInterestPrivateObject(privateConfig, { ...prepared.ref, requestId: first.interestId, revision: 0 }), privatePayload);
  assert.equal(JSON.parse(await call('interest_runtime_execute', 'submit', first)).created, true);
  await sql(`CREATE ROLE ${runtimeProbeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD NULL`);
  await sql(`GRANT otl_referral_runtime TO ${runtimeProbeRole}`);
  const ownerEnv = dbEnv;
  const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
  const runtimeDb = { async queryJson(query, params) {
    const rendered = params.reduce((statement, value, index) => statement.replaceAll(`$${index + 1}`, quoted(value)), query);
    const output = await sql(rendered);
    return output === '' ? null : JSON.parse(output);
  } };
  const runtimeStore = new CommunityInterestStore(runtimeDb);
  dbEnv = { ...ownerEnv, PGUSER: runtimeProbeRole };
  const [recoveredReceipt, recoveredObject] = await Promise.all([
    runtimeStore.findSubmission('TREF', first.key),
    runtimeStore.findPrivateIntake('TREF', first.interestId, first.objectDigest),
  ]);
  assert.deepEqual(recoveredReceipt,
    { receiptId: first.receiptId, accepted: true, created: false, sameSubmissionKey: true });
  assert.equal(recoveredObject, 'adopted');
  assert.equal(await runtimeStore.findSubmission('TOTHER', first.key), null);
  assert.equal(await runtimeStore.findSubmission('TREF', 'wrong-key-1234'), null);
  assert.equal(await runtimeStore.findPrivateIntake('TOTHER', first.interestId, first.objectDigest), 'absent');
  assert.equal(await runtimeStore.findPrivateIntake('TREF', first.interestId, '0'.repeat(64)), 'conflict');
  assert.equal(await runtimeStore.findPrivateIntake('TREF', 'IREQ-WRONG1', first.objectDigest), 'conflict');
  assert.equal(await runtimeStore.findPrivateIntake('TREF', 'IREQ-MISSING1', '0'.repeat(64)), 'absent');
  const nonceDigest = 'f'.repeat(64);
  const nonceExpires = new Date(Date.now() + 300_000).toISOString();
  assert.equal(await runtimeStore.claimServiceNonce(nonceDigest, nonceExpires, 'TREF'), true);
  assert.equal(await runtimeStore.claimServiceNonce(nonceDigest, nonceExpires, 'TREF'), false);
  await assert.rejects(sql("SELECT count(*) FROM otl.interest_service_nonces"), /permission denied/);
  assert.equal(await sql("SELECT has_table_privilege(current_user,'otl.interest_submission_receipts','SELECT')"), 'f');
  assert.equal(await sql("SELECT has_table_privilege(current_user,'otl.interest_private_payloads','SELECT')"), 'f');
  await assert.rejects(sql("SELECT count(*) FROM otl.interest_submission_receipts"), /permission denied/);
  await assert.rejects(sql("SELECT count(*) FROM otl.interest_private_payloads"), /permission denied/);
  assert.ok(!JSON.stringify([recoveredReceipt, recoveredObject]).includes(privatePayload.email));
  assert.ok(!JSON.stringify([recoveredReceipt, recoveredObject]).includes(privatePayload.intent));
  dbEnv = ownerEnv;
  console.log(JSON.stringify({ scenario: 'runtime-reconcile-read', role: runtimeProbeRole,
    receiptRecovered: true, objectAdopted: true, crossTeamDenied: true, wrongKeyMissing: true,
    wrongDigestConflict: true, directTablesDenied: true, piiAbsent: true }));

  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests WHERE team_id='TREF'"), '1');
  assert.equal(await sql("SELECT count(*) FROM otl.interest_private_payloads WHERE team_id='TREF'"), '1');
  assert.equal(await sql("SELECT count(*) FROM otl.referral_requests WHERE team_id='TREF'"), '0');
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 0);
  assert.deepEqual(JSON.parse(await call('interest_runtime_execute', 'submit', { ...first, now: '2026-09-19T01:01:00Z', consentedAt: '2026-09-19T01:01:00Z', inviteConsentedAt: '2026-09-19T01:01:00Z', interestId: 'IREQ-RETRY1', receiptId: 'INT-RETRY1', withdrawalDigest: '9'.repeat(64), opaqueRef: 'interest-private/IREQ-RETRY1/revision-0-12345678-1234-1234-1234-123456789abc.enc', objectDigest: '8'.repeat(64) })), { receiptId: first.receiptId, accepted: true, created: false, sameSubmissionKey: true });
  assert.equal(await sql("SELECT count(*) FROM otl.interest_consents WHERE team_id='TREF'"), '1');
  assert.equal(await sql("SELECT count(*) FROM otl.interest_attachment_consents WHERE team_id='TREF'"), '1');
  await assert.rejects(call('interest_runtime_execute', 'submit', { ...submit('NOCONSENT1', '0'.repeat(64)), inviteConsentAccepted: false }), /invalid interest submission/);
  assert.equal(await sql("SELECT consented_at='2026-09-19T01:00:00Z'::timestamptz FROM otl.interest_consents WHERE interest_id='IREQ-FIRST1'"), 't');
  await assert.rejects(call('interest_runtime_execute', 'submit', { ...first, shareNameEmailWithIntroducer: false }), /idempotency collision/);
  await assert.rejects(call('interest_runtime_execute', 'submit', { ...first, inviteConsentAccepted: false }), /invalid interest submission/);
  await assert.rejects(call('interest_runtime_execute', 'submit', { ...first, contentDigest: '8'.repeat(64) }), /idempotency collision/);
  assert.equal(JSON.parse(await call('interest_runtime_execute', 'submit', { ...first, objectDigest: 'd'.repeat(64) })).sameSubmissionKey, true);
  assert.equal(JSON.parse(await call('interest_runtime_execute', 'submit', submit('DUPE1', first.emailDigest))).sameSubmissionKey, false);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests WHERE team_id='TREF'"), '1');
  const token = '1'.repeat(64);
  await call('referral_runtime_execute', 'issue', { teamId: 'TREF', userId: 'UREFERRER', linkId: 'LNK-INTEREST1', tokenDigest: token, now });
  const referral = (suffix, emailDigest) => ({
    teamId: 'TREF', tokenDigest: token, emailDigest, requestId: `REQ-${suffix}`,
    receiptId: `RCP-${suffix}`, withdrawalDigest: 'e'.repeat(64), consentVersion: 'invite-consent-v1',
    consentedAt: now, key: `interest-referral-${suffix}`,
    opaqueRef: `invite-private/REQ-${suffix}/revision-0-12345678-1234-1234-1234-123456789abc.enc`,
    objectDigest: 'd'.repeat(64), envelopeDek: 'fresh.envelope', nonce: 'fresh-nonce',
    keyVersion: 'invite-kek-2026-01', schemaVersion: 'invite-application.v1', now,
  });
  await assert.rejects(call('referral_runtime_execute', 'submit', referral('BLOCK1', first.emailDigest)), /open interest exists/);
  assert.equal(await sql("SELECT count(*) FROM otl.referral_requests WHERE team_id='TREF'"), '0');
  const referred = referral('EXIST1', 'f'.repeat(64));
  await call('referral_runtime_execute', 'submit', referred);
  assert.equal(JSON.parse(await call('interest_runtime_execute', 'submit', submit('DUPE2', referred.emailDigest))).created, false);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests WHERE team_id='TREF'"), '1');
  assert.equal(await sql("SELECT has_function_privilege('otl_referral_runtime','otl.interest_admin_execute(text,jsonb)','EXECUTE')"), 'f');
  assert.equal(await sql("SELECT has_function_privilege('otl_referral_runtime','otl.interest_member_confirm(jsonb)','EXECUTE')"), 'f');
  assert.equal(await sql("SELECT has_function_privilege('otl_referral_admin_login','otl.interest_admin_execute(text,jsonb)','EXECUTE')"), 't');
  assert.equal(await sql("SELECT has_function_privilege('otl_interest_member_login','otl.interest_member_confirm(jsonb)','EXECUTE')"), 't');
  assert.equal(await sql("SELECT has_table_privilege('otl_interest_member_login','otl.interest_requests','SELECT')"), 'f');
  const adminContextInput = { teamId: 'TREF', adminId: 'UADMIN', interestId: first.interestId, key: 'context-first1', now };
  dbEnv = { ...ownerEnv, PGUSER: 'otl_referral_admin_login' };
  const initialContext = JSON.parse(await call('interest_admin_execute', 'context', adminContextInput));
  assert.equal(initialContext.revision, 0);
  assert.equal(initialContext.emailDigest, first.emailDigest);
  assert.equal(initialContext.memberId, null);
  assert.equal(initialContext.tokenDigest, null);
  await assert.rejects(call('interest_admin_execute', 'context', { ...adminContextInput, teamId: 'TOTHER' }), /admin denied/);
  dbEnv = { ...ownerEnv, PGUSER: runtimeProbeRole };
  await assert.rejects(call('interest_admin_execute', 'context', adminContextInput), /permission denied/);
  dbEnv = ownerEnv;
  console.log(JSON.stringify({ scenario: 'restricted-admin-context', revision: initialContext.revision, emailDigest: true, noCandidate: true, crossTeamDenied: true, runtimeDenied: true }));
  const admin = { teamId: 'TREF', adminId: 'UADMIN', interestId: first.interestId, expectedRevision: 0, key: 'first-admin1', now };
  const firstPrompt = { ...admin, key: 'first-prompt1', memberId: 'UREFERRER',
    nonceDigest: '9'.repeat(64), expiresAt: '2026-09-20T01:00:00Z' };
  await assert.rejects(call('interest_admin_execute', 'verify_offline', { ...admin,
    memberId: 'UREFERRER', evidenceType: 'offline_document', evidenceDigest: '8'.repeat(64), evidenceAt: now }), /offline introduction unavailable/);
  await call('interest_admin_execute', 'request_introduction', firstPrompt);
  dbEnv = { ...ownerEnv, PGUSER: 'otl_interest_member_login' };
  assert.equal(JSON.parse(await sql(`SELECT otl.interest_member_confirm('${JSON.stringify({
    teamId: 'TREF', interestId: first.interestId, memberId: 'UREFERRER', expectedRevision: 0,
    signedNonceDigest: firstPrompt.nonceDigest, evidenceDigest: firstPrompt.nonceDigest,
    key: 'first-confirm1', now,
  })}'::jsonb)`)).state, 'introduction_verified');
  dbEnv = ownerEnv;
  await sql(`INSERT INTO otl.interest_requests(team_id,interest_id,receipt_id,email_digest,withdrawal_digest,
    submission_key,submission_hash,submitted_at,payload_purge_after,audit_purge_after)
    VALUES('TREF','IREQ-FORGED1','INT-FORGED1',repeat('0',64),repeat('b',64),
      'forged-no-consent','00000000000000000000000000000000','${now}'::timestamptz,
      '${now}'::timestamptz+interval '30 days','${now}'::timestamptz+interval '12 months')`);
  await sql(`INSERT INTO otl.interest_introduction_evidence(team_id,interest_id,member_id,evidence_type,
    evidence_digest,actor_id,evidence_at,verified_at,event_key)
    VALUES('TREF','IREQ-FORGED1','UREFERRER','slack_signed_confirmation',repeat('8',64),
      'UREFERRER','${now}'::timestamptz,'${now}'::timestamptz,'forged-owner-fixture')`);
  await sql("UPDATE otl.interest_requests SET state='introduction_verified',revision=1 WHERE interest_id='IREQ-FORGED1'");
  await assert.rejects(call('interest_admin_execute', 'attach', { ...admin, interestId: 'IREQ-FORGED1', expectedRevision: 1, key: 'attach-no-consent', referral: { ...referral('FORGED1', '0'.repeat(64)), key: 'interest-attach:IREQ-FORGED1' } }), /attachment consent unavailable/);
  assert.equal(await sql("SELECT count(*) FROM otl.referral_requests WHERE request_id='REQ-FORGED1'"), '0');
  await sql("UPDATE otl.interest_outbox SET status='cancelled' WHERE interest_id='IREQ-FORGED1'");
  const attach = { ...admin, expectedRevision: 1, key: 'attach-first1', referral: { ...referral('ATTACH1', first.emailDigest), key: `interest-attach:${first.interestId}` } };
  await assert.rejects(call('interest_admin_execute', 'attach', { ...attach, referral: { ...attach.referral, tokenDigest: '2'.repeat(64) } }), /invalid referral attachment/);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_referral_bridges"), '0');
  await call('referral_capacity_admin_execute', 'set_member', { teamId: 'TREF', adminId: 'UADMIN', userId: 'UREFERRER', maximum: 0, expectedRevision: 0, key: 'interest-zero', now });
  assert.equal(JSON.parse(await call('interest_admin_execute', 'attach', attach)).state, 'attached');
  assert.equal(await sql("SELECT count(*) FROM otl.interest_referral_bridges WHERE team_id='TREF' AND interest_id='IREQ-FIRST1' AND request_id='REQ-ATTACH1'"), '1');
  assert.equal(await sql("SELECT state FROM otl.referral_requests WHERE request_id='REQ-ATTACH1'"), 'pending');
  assert.equal(JSON.parse(await call('interest_admin_execute', 'attach', attach)).requestId, 'REQ-ATTACH1');
  await assert.rejects(call('interest_admin_execute', 'attach', { ...attach, key: 'attach-different', expectedRevision: 2 }), /introduction unverified/);
  await assert.rejects(call('referral_admin_execute', 'decide', { teamId: 'TREF', adminId: 'UADMIN', requestId: 'REQ-ATTACH1', expectedRevision: 0, decision: 'approved', key: 'approve-at-zero', now }), /capacity unavailable/);
  await call('referral_capacity_admin_execute', 'set_member', { teamId: 'TREF', adminId: 'UADMIN', userId: 'UREFERRER', maximum: 2, expectedRevision: 1, key: 'interest-two', now });
  await call('referral_admin_execute', 'decide', { teamId: 'TREF', adminId: 'UADMIN', requestId: 'REQ-ATTACH1', expectedRevision: 0, decision: 'approved', key: 'approve-interest', now });
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 1);
  const withdrawal = { teamId: 'TREF', receiptId: first.receiptId, withdrawalDigest: first.withdrawalDigest, key: 'withdraw-first1', now };
  assert.equal(JSON.parse(await call('interest_runtime_execute', 'withdraw', withdrawal)).accepted, true);
  assert.equal(await sql("SELECT state FROM otl.referral_requests WHERE request_id='REQ-ATTACH1'"), 'withdrawn');
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 0);
  assert.equal(JSON.parse(await call('interest_runtime_execute', 'withdraw', withdrawal)).accepted, true);
  const before = submit('BEFORE1', '1'.repeat(64));
  await call('interest_runtime_execute', 'submit', before);
  await assert.rejects(call('interest_admin_execute', 'request_introduction', {
    ...admin, interestId: before.interestId, key: 'false-share-prompt1',
    memberId: 'UREFERRER', nonceDigest: '7'.repeat(64), expiresAt: '2026-09-20T01:00:00Z',
  }), /prompt unavailable/);
  await assert.rejects(call('interest_admin_execute', 'verify_offline', {
    ...admin, interestId: before.interestId, key: 'false-share-offline1',
    memberId: 'UREFERRER', evidenceType: 'offline_document', evidenceDigest: '7'.repeat(64), evidenceAt: now,
  }), /offline introduction unavailable/);
  await assert.rejects(call('interest_admin_execute', 'attach', { ...admin,
    interestId: before.interestId, key: 'false-share-attach1', referral: {
      ...referral('FALSESHARE1', before.emailDigest), key: `interest-attach:${before.interestId}`, },
  }), /introduction unverified/);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_referral_bridges WHERE interest_id='IREQ-BEFORE1'"), '0');
  await sql(`INSERT INTO otl.interest_introduction_evidence(team_id,interest_id,member_id,evidence_type,
    evidence_digest,actor_id,evidence_at,verified_at,event_key)
    VALUES('TREF','IREQ-BEFORE1','UREFERRER','offline_document',repeat('7',64),
      'UADMIN','${now}'::timestamptz,'${now}'::timestamptz,'owner-injected-offline1')`);
  await sql("UPDATE otl.interest_requests SET state='introduction_verified',revision=1 WHERE interest_id='IREQ-BEFORE1'");
  await assert.rejects(call('interest_admin_execute', 'attach', { ...admin,
    interestId: before.interestId, expectedRevision: 1, key: 'false-share-injected1', referral: {
      ...referral('FALSESHARE2', before.emailDigest), key: `interest-attach:${before.interestId}`,
    },
  }), /sharing consent unavailable/);
  assert.equal(await sql("SELECT count(*) FROM otl.referral_requests WHERE request_id='REQ-FALSESHARE2'"), '0');
  await call('interest_runtime_execute', 'withdraw', { teamId: 'TREF', receiptId: before.receiptId, withdrawalDigest: before.withdrawalDigest, key: 'withdraw-before1', now });
  assert.equal(await sql("SELECT state FROM otl.interest_requests WHERE interest_id='IREQ-BEFORE1'"), 'withdrawn');
  const absentObject = JSON.parse(await call('interest_retention_execute', 'claim_purge', { teamId: 'TREF', key: 'purge-absent1', now: '2026-09-20T02:00:00Z' }));
  assert.equal(absentObject.interestId, before.interestId);
  await call('interest_retention_execute', 'finish_purge', { teamId: 'TREF', interestId: before.interestId, key: 'purge-absent1', status: 'failed', now: '2026-09-20T02:00:00Z' });
  const purge = JSON.parse(await call('interest_retention_execute', 'claim_purge', { teamId: 'TREF', key: 'purge-first1', now: '2026-09-20T02:00:00Z' }));
  assert.equal(purge.opaqueRef, prepared.ref.opaqueRef);
  assert.equal(purge.objectDigest, prepared.ref.objectDigest);
  await assert.rejects(call('interest_retention_execute', 'finish_purge', { teamId: 'TREF', interestId: purge.interestId, key: 'wrong-key', status: 'purged', now: '2026-09-20T02:01:00Z' }), /claim unavailable/);
  await deleteInterestPrivateObject(privateConfig, purge.opaqueRef);
  assert.equal(objects.has(purge.opaqueRef), false);
  assert.equal(JSON.parse(await call('interest_retention_execute', 'finish_purge', { teamId: 'TREF', interestId: purge.interestId, key: purge.claimKey, status: 'purged', now: '2026-09-20T02:01:00Z' })).status, 'purged');
  assert.equal(await sql(`SELECT envelope_dek IS NULL FROM otl.interest_private_payloads WHERE interest_id='${purge.interestId}'`), 't');
  const due = submit('EXPIRE1', '2'.repeat(64));
  await call('interest_runtime_execute', 'submit', due);
  assert.ok(JSON.parse(await call('interest_retention_execute', 'expire_due', { teamId: 'TREF', now: '2026-10-20T02:00:00Z' })).processed >= 1);
  assert.equal(await sql("SELECT state FROM otl.interest_requests WHERE interest_id='IREQ-EXPIRE1'"), 'expired');
  const confirmed = { ...submit('MEMBER1', '3'.repeat(64)), shareNameEmailWithIntroducer: true };
  await call('interest_runtime_execute', 'submit', confirmed);
  const promptNow = new Date().toISOString();
  const prompt = { teamId: 'TREF', adminId: 'UADMIN', interestId: confirmed.interestId,
    expectedRevision: 0, memberId: 'UREFERRER', nonceDigest: '4'.repeat(64),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), key: 'member-prompt1', now: promptNow };
  dbEnv = { ...ownerEnv, PGUSER: 'otl_referral_admin_login' };
  await assert.rejects(call('interest_admin_execute', 'request_introduction', { ...prompt, memberId: 'UBOT' }), /prompt unavailable/);
  assert.equal(JSON.parse(await call('interest_admin_execute', 'request_introduction', prompt)).state, 'pending_introduction');
  await assert.rejects(call('interest_admin_execute', 'request_introduction', { ...prompt, key: 'member-prompt2', memberId: 'UJOINED' }), /prompt already issued/);
  dbEnv = { ...ownerEnv, PGUSER: 'otl_interest_member_login' };
  const contextCall = (value) => sql(`SELECT otl.interest_member_confirm('${JSON.stringify(value)}'::jsonb)`);
  const memberContextInput = { operation: 'context', teamId: 'TREF', interestId: confirmed.interestId,
    memberId: 'UREFERRER', signedNonceDigest: prompt.nonceDigest };
  const memberContext = JSON.parse(await contextCall(memberContextInput));
  assert.equal(memberContext.revision, 0);
  assert.equal(memberContext.shareNameEmailWithIntroducer, true);
  assert.ok(memberContext.opaqueRef.startsWith('interest-private/'));
  assert.equal(memberContext.envelopeDek, confirmed.envelopeDek);
  await assert.rejects(contextCall({ ...memberContextInput, teamId: 'TOTHER' }), /member introduction denied/);
  await assert.rejects(contextCall({ ...memberContextInput, memberId: 'UJOINED' }), /(prompt unavailable|member introduction denied)/);
  await assert.rejects(contextCall({ ...memberContextInput, signedNonceDigest: '5'.repeat(64) }), /prompt unavailable/);
  dbEnv = { ...ownerEnv, PGUSER: runtimeProbeRole };
  await assert.rejects(contextCall(memberContextInput), /permission denied/);
  dbEnv = ownerEnv;
  console.log(JSON.stringify({ scenario: 'restricted-member-context', noPii: true,
    crossTeamDenied: true, wrongMemberDenied: true, wrongNonceDenied: true, runtimeDenied: true }));
  const memberConfirmation = { teamId: 'TREF', interestId: confirmed.interestId, memberId: 'UREFERRER',
    expectedRevision: 0, signedNonceDigest: '4'.repeat(64), evidenceDigest: '4'.repeat(64),
    key: 'member-confirm1', now: promptNow };
  dbEnv = { ...ownerEnv, PGUSER: 'otl_interest_member_login' };
  await assert.rejects(sql(`SELECT otl.interest_member_confirm('${JSON.stringify({ ...memberConfirmation, evidenceDigest: '5'.repeat(64) })}'::jsonb)`), /member introduction denied/);
  assert.equal(JSON.parse(await sql(`SELECT otl.interest_member_confirm('${JSON.stringify(memberConfirmation)}'::jsonb)`)).state, 'introduction_verified');
  await assert.rejects(sql(`SELECT otl.interest_member_confirm('${JSON.stringify({ ...memberConfirmation, key: 'member-confirm2' })}'::jsonb)`), /stale introduction/);
  dbEnv = ownerEnv;
  assert.equal(await sql("SELECT evidence_type FROM otl.interest_introduction_evidence WHERE interest_id='IREQ-MEMBER1'"), 'slack_signed_confirmation');
  dbEnv = { ...ownerEnv, PGUSER: 'otl_interest_member_login' };
  await assert.rejects(contextCall(memberContextInput), /prompt unavailable/);
  dbEnv = { ...ownerEnv, PGUSER: 'otl_referral_admin_login' };
  const verifiedContext = JSON.parse(await call('interest_admin_execute', 'context', { ...adminContextInput, interestId: confirmed.interestId }));
  assert.equal(verifiedContext.memberId, 'UREFERRER');
  assert.equal(verifiedContext.tokenDigest, token);
  assert.equal(verifiedContext.emailDigest, confirmed.emailDigest);
  dbEnv = ownerEnv;
  await assert.rejects(call('interest_admin_execute', 'attach', { ...admin, interestId: confirmed.interestId, expectedRevision: 1, key: 'cross-team', teamId: 'TOTHER', referral: { ...referral('CROSS1', confirmed.emailDigest), key: 'interest-attach:IREQ-MEMBER1' } }), /admin denied/);
  const joinedReferral = { ...referral('JOINED1', confirmed.emailDigest), key: 'interest-attach:IREQ-MEMBER1' };
  await call('interest_admin_execute', 'attach', { ...admin, interestId: confirmed.interestId, expectedRevision: 1, key: 'attach-member1', referral: joinedReferral });
  await call('referral_admin_execute', 'decide', { teamId: 'TREF', adminId: 'UADMIN', requestId: 'REQ-JOINED1', expectedRevision: 0, decision: 'approved', key: 'approve-joined1', now });
  await call('referral_admin_execute', 'mark_invited', { teamId: 'TREF', adminId: 'UADMIN', requestId: 'REQ-JOINED1', expectedRevision: 1, key: 'invite-joined1', now });
  await call('referral_runtime_execute', 'attribute_join', { teamId: 'TREF', userId: 'UJOINED', emailDigest: confirmed.emailDigest, eventId: 'EvInterestJoined1', now });
  assert.equal(await sql("SELECT state FROM otl.referral_requests WHERE request_id='REQ-JOINED1'"), 'joined');
  assert.equal(await sql("SELECT payload_purge_after= '2026-09-26T01:00:00Z'::timestamptz FROM otl.referral_requests WHERE request_id='REQ-JOINED1'"), 't');
  await assert.rejects(call('interest_runtime_execute', 'withdraw', { teamId: 'TREF', receiptId: confirmed.receiptId, withdrawalDigest: confirmed.withdrawalDigest, key: 'withdraw-joined1', now }), /downstream referral terminal/);
  assert.equal(await sql("SELECT state FROM otl.interest_requests WHERE interest_id='IREQ-MEMBER1'"), 'attached');
  const delivery = JSON.parse(await call('interest_delivery_execute', 'claim', { teamId: 'TREF', adminId: 'UADMIN', claimKey: 'delivery-claim1', now }));
  assert.ok(delivery.opaqueRef.startsWith('interest-private/'));
  await assert.rejects(call('interest_delivery_execute', 'finish', { teamId: 'TREF', adminId: 'UADMIN', claimKey: 'wrong', outboxId: delivery.outboxId, status: 'sent', now }), /claim unavailable/);
  assert.equal(JSON.parse(await call('interest_delivery_execute', 'finish', { teamId: 'TREF', adminId: 'UADMIN', claimKey: 'delivery-claim1', outboxId: delivery.outboxId, status: 'sent', now })).status, 'sent');
  await assert.rejects(call('interest_delivery_execute', 'claim', { teamId: 'TOTHER', adminId: 'UADMIN', claimKey: 'cross-delivery', now }), /invalid interest delivery/);
  const raceDigest = '6'.repeat(64);
  const race = await Promise.allSettled([
    call('interest_runtime_execute', 'submit', submit('RACE1', raceDigest)),
    call('referral_runtime_execute', 'submit', referral('RACE1', raceDigest)),
  ]);
  assert.ok(race.some((r) => r.status === 'fulfilled'));
  assert.equal(await sql(`SELECT (SELECT count(*) FROM otl.interest_requests WHERE team_id='TREF' AND email_digest='${raceDigest}' AND state IN ('pending_introduction','introduction_verified')) + (SELECT count(*) FROM otl.referral_requests WHERE team_id='TREF' AND email_digest='${raceDigest}' AND state IN ('pending','approved'))`), '1');
  await call('referral_runtime_execute', 'submit', referral('CAPA1', '7'.repeat(64)));
  await call('referral_runtime_execute', 'submit', referral('CAPB1', '8'.repeat(64)));
  const capacityRace = await Promise.allSettled(['CAPA1', 'CAPB1'].map((suffix) =>
    call('referral_admin_execute', 'decide', { teamId: 'TREF', adminId: 'UADMIN',
      requestId: `REQ-${suffix}`, expectedRevision: 0, decision: 'approved',
      key: `approve-${suffix}`, now })));
  assert.equal(capacityRace.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).reserved, 1);
  assert.equal(JSON.parse(await sql("SELECT otl.referral_capacity_status('TREF','UREFERRER')")).joined, 1);
  assert.equal(JSON.parse(await call('interest_runtime_execute', 'submit', submit('FULL1', '5'.repeat(64)))).created, true);
  await sql("INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TOTHER','UOTHER')");
  await call('interest_runtime_execute', 'submit', { ...submit('OUTBOX1', '4'.repeat(64)), teamId: 'TOTHER' });
  for (let attempt = 1; attempt <= 5; attempt++) {
    const deliveryNow = new Date(Date.parse(now) + (attempt - 1) * 10 * 60_000).toISOString();
    const claimKey = `delivery-dead-${attempt}`;
    const leased = JSON.parse(await call('interest_delivery_execute', 'claim', { teamId: 'TOTHER', adminId: 'UOTHER', claimKey, now: deliveryNow }));
    assert.equal(leased.interestId, 'IREQ-OUTBOX1');
    const finished = JSON.parse(await call('interest_delivery_execute', 'finish', { teamId: 'TOTHER', adminId: 'UOTHER', claimKey, outboxId: leased.outboxId, status: 'failed', now: deliveryNow }));
    assert.equal(finished.status, attempt === 5 ? 'dead' : 'failed');
  }
  assert.equal(await call('interest_delivery_execute', 'claim', { teamId: 'TOTHER', adminId: 'UOTHER', claimKey: 'delivery-after-dead', now: '2026-09-20T00:00:00Z' }), 'null');
  const deadTime = '2026-09-20T02:00:00Z';
  for (let attempt = 2; attempt <= 5; attempt++) {
    const key = `dead-purge-${attempt}`;
    const claimNow = new Date(Date.parse(deadTime) + (attempt - 1) * 10 * 60_000).toISOString();
    const claim = JSON.parse(await call('interest_retention_execute', 'claim_purge', { teamId: 'TREF', key, now: claimNow }));
    assert.equal(claim.interestId, before.interestId);
    const finished = JSON.parse(await call('interest_retention_execute', 'finish_purge', { teamId: 'TREF', interestId: before.interestId, key, status: 'failed', now: claimNow }));
    assert.equal(finished.status, attempt === 5 ? 'dead' : 'failed');
  }
  assert.equal(await sql("SELECT purge_status FROM otl.interest_private_payloads WHERE interest_id='IREQ-BEFORE1'"), 'dead');
  const audit = JSON.parse(await call('interest_retention_execute', 'audit_retention', { teamId: 'TREF', now: '2027-10-01T00:00:00Z', limit: 10 }));
  assert.ok(audit.processed >= 1);
  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests WHERE interest_id='IREQ-FIRST1'"), '0');
  assert.equal(await sql("SELECT count(*) FROM otl.referral_requests WHERE request_id='REQ-ATTACH1'"), '1');
  console.log(JSON.stringify({ scenario: 'interest-security-retention', signedRole: true, staleDenied: true,
    joinedWithdrawalDenied: true, joinedPayloadDays: 7, concurrentOpenEmail: 1, deliveryLease: 'sent', deliveryDeadAfter: 5,
    purgeDeadAfter: 5, auditRemoved: audit.processed, approvalRace: '1-of-2' }));
  console.log(JSON.stringify({ scenario: 'interest-fresh', submit: 1, duplicate: 2, referralBeforeAttach: 0,
    bridge: 1, pendingAttachAtCapacityZero: true, approvalAtZeroDenied: true, withdrawalReleased: true,
    purge: 'purged', expiry: 'expired', roleDenied: true }));
  dbEnv = clusterEnv;
  await sql(`CREATE DATABASE ${upgradeDb} OWNER ${ownerRole}`);
  dbEnv = { ...clusterEnv, PGUSER: ownerRole, PGDATABASE: upgradeDb };
  for (const migration of migrations.filter((name) => Number(name.slice(0, 3)) <= 36)) {
    if (migration.startsWith('006_')) await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', `migrations/${migration}`, '-f', 'migrations/007_normalized_legacy.sql']);
    else if (!migration.startsWith('007_')) await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', `migrations/${migration}`]);
  }
  assert.equal(await sql("SELECT count(*) FROM otl.schema_migrations WHERE version='037-interest-requests'"), '0');
  dbEnv = clusterEnv;
  await sql('ALTER ROLE otl_interest_member_login SUPERUSER');
  dbEnv = { ...clusterEnv, PGUSER: ownerRole, PGDATABASE: upgradeDb };
  await assert.rejects(run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', 'migrations/037_interest_requests.sql']), /unsafe interest member role/);
  assert.equal(await sql("SELECT count(*) FROM otl.schema_migrations WHERE version='037-interest-requests'"), '0');
  await assert.rejects(sql('SELECT count(*) FROM otl.interest_requests'), /does not exist/);
  dbEnv = clusterEnv;
  await sql('ALTER ROLE otl_interest_member_login NOSUPERUSER');
  dbEnv = { ...clusterEnv, PGUSER: ownerRole, PGDATABASE: upgradeDb };
  await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-f', 'migrations/037_interest_requests.sql']);
  assert.equal(await sql("SELECT count(*) FROM otl.schema_migrations WHERE version='037-interest-requests'"), '1');
  assert.equal(await sql("SELECT count(*) FROM otl.interest_requests"), '0');
  console.log(JSON.stringify({ scenario: 'interest-migration', owner: await sql("SELECT rolsuper::text||':'||rolcreaterole::text FROM pg_roles WHERE rolname=current_user"), freshVersion: 1, upgradeVersion: 1, unsafeRoleRollback: true }));
  console.log('INTEREST_PG=PASS fresh=1 upgrade=1 rollback=1');
} finally {
  dbEnv = clusterEnv;
  if (created) {
    await sql(`DROP DATABASE IF EXISTS ${freshDb} WITH (FORCE)`);
    await sql(`DROP DATABASE IF EXISTS ${upgradeDb} WITH (FORCE)`);
    for (const role of ['otl_interest_member_login','otl_interest_member','otl_referral_admin_login',
      'otl_referral_admin','otl_referral_runtime','otl_lifecycle_admin_login','otl_lifecycle_admin',
      'otl_lifecycle_runtime','otl_guide_admin','otl_guide_runtime','legacy_invitation_runtime',runtimeProbeRole,ownerRole]) {
      await sql(`DROP ROLE IF EXISTS ${role}`);
    }
    console.log(JSON.stringify({ scenario: 'local-pg-cleanup', freshDb, upgradeDb, dropped: true }));
  }
}
