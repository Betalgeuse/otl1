import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pg = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-capacity-"));
const socket = join(temp, "socket");
const data = join(temp, "data");
const clusterEnv = { ...process.env, PGHOST: socket, PGPORT: String(50000 + Math.floor(Math.random() * 9000)), PGDATABASE: "postgres" };
let dbEnv = clusterEnv;
const run = (bin, args) => exec(join(pg, bin), args, { cwd: root, env: dbEnv, encoding: "utf8" });
const sql = async (query) => (await run("psql", ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", query])).stdout.trim();
let started = false;
try {
  await mkdir(socket);
  await run("initdb", ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run("pg_ctl", ["-D", data, "-o", `-F -k ${socket} -p ${clusterEnv.PGPORT}`, "-l", join(temp, "pg.log"), "-w", "start"]);
  started = true;
  await sql("CREATE ROLE otl_capacity_owner LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION");
  await sql("CREATE DATABASE otl_capacity_fresh OWNER otl_capacity_owner");
  dbEnv = { ...clusterEnv, PGUSER: "otl_capacity_owner", PGDATABASE: "otl_capacity_fresh" };
  assert.equal(await sql("SELECT rolsuper::text||':'||rolcreaterole::text FROM pg_roles WHERE rolname=current_user"), "false:true");
  const migrations = (await readdir(join(root, "migrations"))).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
  for (const migration of migrations) {
    if (migration.startsWith("006_")) {
      await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"]);
    } else if (!migration.startsWith("007_")) {
      await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${migration}`]);
    }
  }
  await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", "qa/referral-storage-fixture.sql"]);
  await sql("INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TREF','UADMIN')");
  const query = (op, payload) => `SELECT otl.referral_capacity_admin_execute('${op}','${JSON.stringify(payload)}'::jsonb)`;
  const base = { teamId: "TREF", adminId: "UADMIN", userId: "UREFERRER", now: "2026-09-19T01:00:00Z" };
  assert.equal(JSON.parse(await sql(query("status", base))).remaining, 2);
  assert.equal(JSON.parse(await sql(query("set_member", { ...base, maximum: 0, expectedRevision: 0, key: "limit-zero" }))).remaining, 0);
  assert.equal(JSON.parse(await sql(query("set_member", { ...base, maximum: 2, expectedRevision: 1, key: "limit-two" }))).remaining, 2);
  const token = "1".repeat(64);
  const issued = JSON.parse(await sql(`SELECT otl.referral_runtime_execute('issue','${JSON.stringify({ teamId: "TREF", userId: "UREFERRER", linkId: "LNK-CAPACITY1", tokenDigest: token, now: "2026-09-19T01:00:00Z" })}'::jsonb)`));
  assert.equal(issued.linkId, "LNK-CAPACITY1");
  const submit = (n) => ({ teamId: "TREF", tokenDigest: token, emailDigest: String(n).repeat(64), requestId: `REQ-CAPACITY${n}`, receiptId: `RCP-CAPACITY${n}`, withdrawalDigest: "b".repeat(64), consentVersion: "invite-consent-v1", consentedAt: "2026-09-19T01:00:00Z", key: `submit-capacity-${n}`, opaqueRef: `invite-private/REQ-CAPACITY${n}/0.enc`, objectDigest: "d".repeat(64), envelopeDek: "opaque.envelope", nonce: "opaque-nonce", keyVersion: "invite-kek-2026-01", now: "2026-09-19T01:00:00Z" });
  for (const n of [3, 4, 5]) await sql(`SELECT otl.referral_runtime_execute('submit','${JSON.stringify(submit(n))}'::jsonb)`);
  const decision = (n) => ({ teamId: "TREF", adminId: "UADMIN", requestId: `REQ-CAPACITY${n}`, expectedRevision: 0, key: `approve-${n}`, decision: "approved", now: "2026-09-19T01:01:00Z" });
  const results = await Promise.allSettled([3, 4, 5].map((n) => sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify(decision(n))}'::jsonb)`)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "third concurrent approval exceeded capacity");
  assert.equal(JSON.parse(await sql(query("status", base))).remaining, 0);
  assert.equal(JSON.parse(await sql(`SELECT otl.referral_runtime_execute('issue','${JSON.stringify({ teamId: "TREF", userId: "UREFERRER", linkId: "LNK-REPLACED", tokenDigest: "9".repeat(64), now: "2026-09-19T01:01:30Z" })}'::jsonb)`)).kind, "unavailable");
  assert.equal(await sql(`SELECT otl.referral_runtime_execute('resolve','${JSON.stringify({ teamId: "TREF", tokenDigest: token })}'::jsonb)`), '{"available": false}');
  await assert.rejects(sql(`SELECT otl.referral_runtime_execute('submit','${JSON.stringify(submit(6))}'::jsonb)`), /referral unavailable/);
  const approved = await sql("SELECT request_id FROM otl.referral_requests WHERE team_id='TREF' AND state='approved' ORDER BY request_id");
  const [first, second] = approved.split("\n");
  assert.ok(first && second);
  await sql(`SELECT otl.referral_admin_execute('mark_invited','${JSON.stringify({ teamId: "TREF", adminId: "UADMIN", requestId: first, expectedRevision: 1, key: "manual-capacity", now: "2026-09-19T01:02:00Z" })}'::jsonb)`);
  const firstDigest = await sql(`SELECT email_digest FROM otl.referral_requests WHERE request_id='${first}'`);
  await sql(`SELECT otl.referral_runtime_execute('attribute_join','${JSON.stringify({ teamId: "TREF", userId: "UJOINED", emailDigest: firstDigest, eventId: "EvCapacityJoin", now: "2026-09-19T01:03:00Z" })}'::jsonb)`);
  assert.equal(JSON.parse(await sql(query("status", base))).joined, 1);
  assert.equal(JSON.parse(await sql(query("status", base))).remaining, 0);
  await sql(`SELECT otl.referral_runtime_execute('withdraw','${JSON.stringify({ teamId: "TREF", receiptId: second.replace("REQ-", "RCP-"), withdrawalDigest: "b".repeat(64), key: "withdraw-capacity", now: "2026-09-19T01:04:00Z" })}'::jsonb)`);
  assert.equal(JSON.parse(await sql(query("status", base))).remaining, 1);
  assert.equal(JSON.parse(await sql(query("set_member", { ...base, maximum: 1, expectedRevision: 2, key: "limit-one" }))).remaining, 0);
  assert.equal(JSON.parse(await sql(query("set_member", { ...base, maximum: 3, expectedRevision: 3, key: "limit-three" }))).remaining, 2);
  assert.equal(JSON.parse(await sql(`SELECT otl.referral_runtime_execute('issue','${JSON.stringify({ teamId: "TREF", userId: "UREFERRER", linkId: "LNK-REPLACED", tokenDigest: "9".repeat(64), now: "2026-09-19T01:05:00Z" })}'::jsonb)`)).linkId, "LNK-CAPACITY1");
  assert.equal(await sql(`SELECT otl.referral_runtime_execute('resolve','${JSON.stringify({ teamId: "TREF", tokenDigest: token })}'::jsonb)`), '{"available": true}');
  assert.equal(JSON.parse(await sql(query("set_default", { teamId: "TREF", adminId: "UADMIN", maximum: 1, expectedRevision: 0, key: "default-one", now: base.now }))).revision, 1);
  assert.equal(JSON.parse(await sql(query("status", base))).maximum, 3);
  assert.equal(JSON.parse(await sql(query("status_default", { teamId: "TREF", adminId: "UADMIN" }))).revision, 1);
  assert.equal(JSON.parse(await sql(query("set_default", { teamId: "TREF", adminId: "UADMIN", maximum: 0, expectedRevision: 1, key: "default-zero", now: base.now }))).revision, 2);
  assert.equal(JSON.parse(await sql(query("status", { ...base, userId: "UADMIN" }))).maximum, 0);
  assert.equal(JSON.parse(await sql(query("status", base))).maximum, 3);
  const replay = { ...base, maximum: 3, expectedRevision: 3, key: "limit-three" };
  assert.equal(JSON.parse(await sql(query("set_member", replay))).revision, 4);
  assert.equal(JSON.parse(await sql(query("set_member", { ...replay, expectedRevision: 4 }))).revision, 4);
  await assert.rejects(sql(query("set_member", { ...replay, maximum: 9 })), /capacity idempotency collision/);
  await assert.rejects(sql(query("set_member", { ...base, maximum: 9, expectedRevision: 3, key: "stale" })), /stale capacity revision/);
  const pending = await sql("SELECT request_id FROM otl.referral_requests WHERE team_id='TREF' AND state='pending' ORDER BY request_id LIMIT 1");
  await sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify({ teamId: "TREF", adminId: "UADMIN", requestId: pending, expectedRevision: 0, key: "approve-pending", decision: "approved", now: "2026-09-19T01:05:00Z" })}'::jsonb)`);
  assert.equal(JSON.parse(await sql(query("status", base))).reserved, 1);
  const declined = { teamId: "TREF", adminId: "UADMIN", requestId: pending, expectedRevision: 1, key: "decline-approved", decision: "declined", now: "2026-09-19T01:06:00Z" };
  await sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify(declined)}'::jsonb)`);
  assert.equal(JSON.parse(await sql(query("status", base))).reserved, 0);
  assert.equal(JSON.parse(await sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify(declined)}'::jsonb)`)).state, "declined");
  await sql(`SELECT otl.referral_runtime_execute('submit','${JSON.stringify(submit(6))}'::jsonb)`);
  await sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify({ teamId: "TREF", adminId: "UADMIN", requestId: "REQ-CAPACITY6", expectedRevision: 0, key: "approve-expire", decision: "approved", now: "2026-09-19T01:07:00Z" })}'::jsonb)`);
  assert.equal(JSON.parse(await sql(query("status", base))).reserved, 1);
  await sql(`SELECT otl.referral_retention_execute('expire_due','${JSON.stringify({ teamId: "TREF", now: "2026-10-20T01:00:00Z", limit: 10 })}'::jsonb)`);
  assert.equal(JSON.parse(await sql(query("status", base))).joined, 1);
  assert.equal(JSON.parse(await sql(query("status", base))).reserved, 0);
  assert.equal(JSON.parse(await sql(query("status", base))).remaining, 2);
  // Given one lifetime join and one approved reservation at the default maximum of two.
  for (const n of [0, 7, 8, 9]) await sql(`SELECT otl.referral_runtime_execute('submit','${JSON.stringify(submit(n))}'::jsonb)`);
  await sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify({ ...decision(0), key: "capacity-seed-0" })}'::jsonb)`);
  assert.equal(JSON.parse(await sql(query("set_member", { ...base, maximum: 2, expectedRevision: 4, key: "capacity-gate-two" }))).remaining, 0);
  const full = JSON.parse(await sql(query("status", base)));
  assert.deepEqual([full.joined, full.reserved, full.used, full.maximum], [1, 1, 2, 2]);
  if (process.env.CAPACITY_TEST_MUTANT === "disable_guard")
    await sql("ALTER TABLE otl.referral_requests DISABLE TRIGGER referral_capacity_guard");
  const fullRace = await Promise.allSettled([7, 8, 9].map((n) => sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify({ ...decision(n), key: `capacity-full-${n}` })}'::jsonb)`)));
  assert.equal(fullRace.filter((r) => r.status === "fulfilled").length, 0, "full-capacity race admitted an invitee");
  assert.ok(fullRace.every((r) => r.status === "rejected" && /referral capacity unavailable/.test(String(r.reason))));
  assert.equal(await sql("SELECT count(*) FROM otl.referral_requests WHERE team_id='TREF' AND request_id IN ('REQ-CAPACITY7','REQ-CAPACITY8','REQ-CAPACITY9') AND state='pending'"), "3");
  assert.equal(await sql("SELECT count(*) FROM otl.referral_request_events WHERE team_id='TREF' AND event_key LIKE 'capacity-full-%'"), "0");
  assert.equal(await sql("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TREF' AND effect_key LIKE 'decision:capacity-full-%'"), "0");
  const fullStatus = JSON.parse(await sql(query("status", base)));
  assert.equal(fullStatus.used, 2);
  console.log(JSON.stringify({ scenario: "full-capacity-race", owner: await sql("SELECT current_user||':'||rolsuper::text FROM pg_roles WHERE rolname=current_user"),
    before: [full.joined, full.reserved, full.maximum], approved: 0, after: [fullStatus.joined, fullStatus.reserved, fullStatus.maximum],
    events: 0, outbox: 0 }));
  assert.equal(JSON.parse(await sql(query("set_member", { ...base, maximum: 3, expectedRevision: 5, key: "capacity-gate-three" }))).remaining, 1);
  const openRace = await Promise.allSettled([7, 8, 9].map((n) => sql(`SELECT otl.referral_admin_execute('decide','${JSON.stringify({ ...decision(n), key: `capacity-open-${n}` })}'::jsonb)`)));
  assert.equal(openRace.filter((r) => r.status === "fulfilled").length, 1, "raised-capacity race did not admit exactly one");
  assert.equal(JSON.parse(await sql(query("status", base))).used, 3);
  assert.equal(await sql("SELECT count(*) FROM otl.referral_request_events WHERE team_id='TREF' AND event_key LIKE 'capacity-open-%'"), "1");
  assert.equal(await sql("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TREF' AND effect_key LIKE 'decision:capacity-open-%'"), "1");
  console.log(JSON.stringify({ scenario: "raised-capacity-race", approved: 1, denied: 2,
    status: JSON.parse(await sql(query("status", base))), events: 1, outbox: 1 }));
  await assert.rejects(sql(query("set_member", { ...base, adminId: "UREFERRER", maximum: 99, expectedRevision: 4, key: "self", now: base.now })), /referral admin denied/);
  await assert.rejects(sql(query("set_member", { ...base, teamId: "TOTHER", maximum: 99, expectedRevision: 4, key: "cross", now: base.now })), /referral admin denied/);
  await assert.rejects(sql("SET ROLE otl_referral_runtime; SELECT otl.referral_capacity_admin_execute('status','{}'::jsonb)"), /permission denied/);
  assert.equal(await sql("SELECT has_function_privilege('otl_referral_runtime','otl.referral_runtime_uncapped(text,jsonb)','EXECUTE')"), "f");
  assert.equal(await sql("SELECT has_function_privilege('otl_referral_runtime','otl.referral_capacity_admin_execute(text,jsonb)','EXECUTE')"), "f");
  assert.equal(await sql("SELECT has_function_privilege('otl_referral_admin','otl.referral_capacity_admin_execute(text,jsonb)','EXECUTE')"), "t");
  assert.equal(await sql("SELECT has_function_privilege('otl_referral_admin_login','otl.referral_capacity_admin_execute(text,jsonb)','EXECUTE')"), "t");
  assert.equal(await sql("SELECT has_table_privilege('otl_referral_admin_login','otl.referral_requests','UPDATE')"), "f");
  assert.equal(await sql("SELECT rolsuper::text||':'||rolcreaterole::text FROM pg_roles WHERE rolname='otl_referral_admin_login'"), "false:false");
  const freshVersionCount = await sql("SELECT count(*) FROM otl.schema_migrations WHERE version='036-referral-capacity'");
  await sql("CREATE DATABASE otl_capacity_upgrade OWNER otl_capacity_owner");
  for (const migration of migrations.filter((name) => Number(name.slice(0, 3)) <= 35)) {
    const args = migration.startsWith("006_") ? ["--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"] : ["-f", `migrations/${migration}`];
    if (!migration.startsWith("007_")) await run("psql", ["-X", "-d", "otl_capacity_upgrade", "-v", "ON_ERROR_STOP=1", ...args]);
  }
  dbEnv = clusterEnv;
  await sql("ALTER ROLE otl_referral_admin_login SUPERUSER");
  dbEnv = { ...clusterEnv, PGUSER: "otl_capacity_owner", PGDATABASE: "otl_capacity_upgrade" };
  await assert.rejects(run("psql", ["-X", "-d", "otl_capacity_upgrade", "-v", "ON_ERROR_STOP=1", "-f", "migrations/036_referral_capacity.sql"]), /unsafe referral admin login role/);
  assert.equal(await sql("SELECT count(*) FROM otl.schema_migrations WHERE version='036-referral-capacity'"), "0");
  dbEnv = clusterEnv;
  await sql("ALTER ROLE otl_referral_admin_login NOSUPERUSER");
  dbEnv = { ...clusterEnv, PGUSER: "otl_capacity_owner", PGDATABASE: "otl_capacity_upgrade" };
  await run("psql", ["-X", "-d", "otl_capacity_upgrade", "-v", "ON_ERROR_STOP=1", "-f", "migrations/036_referral_capacity.sql"]);
  const upgradedVersionCount = await sql("SELECT count(*) FROM otl.schema_migrations WHERE version='036-referral-capacity'");
  assert.equal(freshVersionCount, "1");
  assert.equal(upgradedVersionCount, "1");
  console.log(JSON.stringify({ scenario: "non-superuser-migrations", owner: await sql("SELECT rolsuper::text||':'||rolcreaterole::text FROM pg_roles WHERE rolname=current_user"),
    freshVersionCount, upgradedVersionCount, elevatedLoginRejected: true,
    loginRole: await sql("SELECT rolsuper::text||':'||rolcreaterole::text FROM pg_roles WHERE rolname='otl_referral_admin_login'") }));
  console.log("CAPACITY_PG=PASS nonsuperuser_fresh_upgrade=1 elevated_role_rejected=1 full_race=0-of-3 raised_race=1-of-3 joined=1 reservation=1 partial_outbox=0");
} finally {
  if (started) await run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
