import assert from "node:assert/strict";
import { CommunityReferralStore } from "../src/community-referral-store.ts";
import { deliverReferralNotifications } from "../src/community-referral-notifications.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-referral-retention-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(40000 + Math.floor(Math.random() * 20000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const migrations = (await readdir(join(root, "migrations"))).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
let started = false;
const run = (binary, args) => exec(binary, args, { cwd: root, env, encoding: "utf8" });
const psql = (sql) => run(join(pgBin, "psql"), ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql]);
const scalar = async (sql) => (await psql(sql)).stdout.trim();

try {
  await mkdir(socket);
  await run(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pgBin, "pg_ctl"), ["-D", data, "-o", `-F -k ${socket} -p ${port}`, "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  for (const migration of migrations.filter((name) => Number(name.slice(0, 3)) <= 33)) {
    if (migration.startsWith("006_")) {
      await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"]);
    } else if (!migration.startsWith("007_")) {
      await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${migration}`]);
    }
  }
  if (process.env.RETENTION_RED) {
    await scalar("SELECT otl.referral_retention_execute('expire_due','{}'::jsonb)");
    throw new Error("red fixture unexpectedly passed");
  }
  await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", "migrations/034_referral_runtime_retention.sql"]);
  await psql(`INSERT INTO otl.workspaces(team_id) VALUES('TRET'),('TOTHER');
    INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('TRET','CRET'),('TOTHER','COTHER');
    INSERT INTO otl.workspace_members(team_id,user_id) VALUES('TRET','UOWNER'),('TOTHER','UOTHER');
    INSERT INTO otl.member_referral_links(team_id,link_id,referrer_user_id,token_digest,status,created_at,status_changed_at)
      VALUES('TRET','LNK-RETN','UOWNER',repeat('a',64),'active','2025-01-01','2025-01-01'),
      ('TOTHER','LNK-OTHR','UOTHER',repeat('b',64),'active','2025-01-01','2025-01-01');
    INSERT INTO otl.referral_requests(team_id,request_id,receipt_id,link_id,referrer_user_id,email_digest,
      withdrawal_digest,state,submission_key,submission_hash,submitted_at,payload_purge_after,audit_purge_after)
      VALUES('TRET','REQ-DUE1','RCP-DUE1','LNK-RETN','UOWNER',repeat('c',64),repeat('d',64),'pending',
        'due1',repeat('e',32),'2025-01-01','2025-02-01','2027-01-01'),
      ('TRET','REQ-FRESH','RCP-FRESH','LNK-RETN','UOWNER',repeat('f',64),repeat('1',64),'pending',
        'fresh',repeat('2',32),'2026-01-01','2027-01-01','2028-01-01'),
      ('TOTHER','REQ-OTHER','RCP-OTHER','LNK-OTHR','UOTHER',repeat('3',64),repeat('4',64),'pending',
        'other',repeat('5',32),'2025-01-01','2025-02-01','2027-01-01');
    INSERT INTO otl.referral_request_events(team_id,request_id,event_key,event_type,actor_class,
      from_state,to_state,request_hash,occurred_at,audit_purge_after,result)
      VALUES('TRET','REQ-DUE1','old','submitted','runtime',NULL,'pending',repeat('a',32),'2025-01-01','2025-02-01','{}'),
      ('TRET','REQ-FRESH','fresh','submitted','runtime',NULL,'pending',repeat('b',32),'2026-01-01','2027-01-01','{}');`);
  const input = "'{\"teamId\":\"TRET\",\"now\":\"2026-09-19T00:00:00Z\",\"limit\":10}'::jsonb";
  assert.match(await scalar(`SET ROLE otl_referral_runtime; SELECT otl.referral_retention_execute('expire_due',${input});`), /"processed": 1/);
  assert.match(await scalar(`SET ROLE otl_referral_runtime; SELECT otl.referral_retention_execute('expire_due',${input});`), /"processed": 0/);
  assert.equal(await scalar("SELECT state FROM otl.referral_requests WHERE team_id='TRET' AND request_id='REQ-DUE1'"), "expired");
  assert.equal(await scalar("SELECT state FROM otl.referral_requests WHERE team_id='TRET' AND request_id='REQ-FRESH'"), "pending");
  assert.equal(await scalar("SELECT state FROM otl.referral_requests WHERE team_id='TOTHER' AND request_id='REQ-OTHER'"), "pending");
  assert.match(await scalar(`SET ROLE otl_referral_runtime; SELECT otl.referral_retention_execute('audit_retention',${input});`), /"processed": 1/);
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_request_events WHERE team_id='TRET' AND event_key='fresh'"), "1");
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_request_events WHERE team_id='TRET' AND event_key='old'"), "0");
  await assert.rejects(() => scalar(`SET ROLE otl_referral_runtime; SELECT otl.referral_admin_execute('decide','{}'::jsonb);`));
  await assert.rejects(() => scalar(`SET ROLE otl_referral_runtime; DELETE FROM otl.referral_request_events WHERE team_id='TRET';`));
  await psql(`INSERT INTO otl.referral_private_payloads(team_id,request_id,opaque_ref,object_digest,envelope_dek,nonce,key_version,schema_version)
    VALUES('TRET','REQ-FRESH','invite-private/REQ-FRESH/a.enc',repeat('a',64),'envelope-a','nonce-a','key-v1','invite-application.v1'),
    ('TOTHER','REQ-OTHER','invite-private/REQ-OTHER/b.enc',repeat('b',64),'envelope-b','nonce-b','key-v1','invite-application.v1');
    INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
    VALUES('TOTHER','REQ-OTHER','other-review','admin_review','2026-09-18'),
    ('TRET','REQ-FRESH','our-review','admin_review','2026-09-19');`);
  const db = { async queryJson(sql, params) {
    const expanded = sql.replace(/\$(\d+)/g, (_match, number) => {
      const value = params[Number(number) - 1];
      return `'${String(value).replaceAll("'", "''")}'`;
    });
    const raw = await scalar(expanded);
    return raw ? JSON.parse(raw) : null;
  } };
  const nonceStore = new CommunityReferralStore({ queryJson: (sql, params) => db.queryJson(sql, params) },
    { teamId: "TRET", channelId: "CRET", userId: "UOWNER" });
  for (let i = 0; i < 15; i += 1)
    assert.equal(await nonceStore.claimServiceNonce(String(i).padStart(64, "0"), "2026-09-18T00:00:00Z"), true);
  assert.match(await scalar(`SET ROLE otl_referral_runtime; SELECT otl.referral_retention_execute('nonce_retention',${input});`), /"processed": 10/);
  assert.match(await scalar(`SET ROLE otl_referral_runtime; SELECT otl.referral_retention_execute('nonce_retention',${input});`), /"processed": 5/);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_records WHERE team_id='TRET' AND kind='referral_service_nonce'"), "0");
  const scope = (teamId) => ({ teamId, channelId: "CBOUND", userId: "UADMIN" });
  const ours = new CommunityReferralStore(db, scope("TRET"));
  const theirs = new CommunityReferralStore(db, scope("TOTHER"));
  const claimAt = "2026-09-19T12:00:00Z";
  assert.equal((await ours.claimAdminReview(claimAt))?.requestId, "REQ-FRESH");
  assert.equal((await theirs.claimAdminReview(claimAt))?.requestId, "REQ-OTHER");
  assert.equal(await ours.claimAdminReview(claimAt), null);
  assert.equal(await theirs.claimAdminReview(claimAt), null);
  await psql(`INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
    SELECT 'TRET','REQ-FRESH','notification-'||n,'admin_decision','2026-09-19'
    FROM generate_series(1,12) n;`);
  const slackEffects = [];
  const slack = { async postAdmin(effect) { slackEffects.push(effect); } };
  const firstNotifications = await deliverReferralNotifications({ db, teamId: "TRET",
    adminId: "UOWNER", slack, now: Date.parse("2026-09-19T12:00:00Z") });
  assert.equal(firstNotifications.processed, 10);
  assert.equal(firstNotifications.possiblyMore, true);
  const secondNotifications = await deliverReferralNotifications({ db, teamId: "TRET",
    adminId: "UOWNER", slack, now: Date.parse("2026-09-19T12:00:00Z") });
  assert.equal(secondNotifications.processed, 2);
  assert.equal(slackEffects.length, 12);
  assert.equal(new Set(slackEffects.map((effect) => effect.effectKey)).size, 12);
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TRET' AND effect_type='admin_decision' AND status='sent'"), "12");
  await psql("CREATE DATABASE otl_retention_fresh");
  for (const migration of migrations.filter((name) => Number(name.slice(0, 3)) <= 34)) {
    if (migration.startsWith("006_")) {
      await run(join(pgBin, "psql"), ["-X", "-d", "otl_retention_fresh", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"]);
    } else if (!migration.startsWith("007_")) {
      await run(join(pgBin, "psql"), ["-X", "-d", "otl_retention_fresh", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${migration}`]);
    }
  }
  const fresh = await run(join(pgBin, "psql"), ["-X", "-d", "otl_retention_fresh", "-Atq", "-c", "SELECT count(*) FROM otl.schema_migrations WHERE version='034-referral-runtime-retention'"]);
  assert.equal(fresh.stdout.trim(), "1");
  console.log("PASS referral retention PG: fresh+upgrade 001-034 runtime due-only expiry=1 replay=0 cross-team=0 fresh=preserved aged-audit=1 nonce-retention=10+5 notifications=10+2 admin=denied direct-delete=denied");
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
