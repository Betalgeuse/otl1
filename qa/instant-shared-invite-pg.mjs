import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pg = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-direct-join-"));
const socket = join(temp, "socket");
const data = join(temp, "data");
const clusterEnv = {
  ...process.env,
  PGHOST: socket,
  PGPORT: String(51000 + Math.floor(Math.random() * 8000)),
  PGDATABASE: "postgres",
};
let dbEnv = clusterEnv;
const run = (bin, args) => exec(join(pg, bin), args, { cwd: root, env: dbEnv, encoding: "utf8" });
const sql = async (query) =>
  (await run("psql", ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", query])).stdout.trim();
const migrations = (await readdir(join(root, "migrations")))
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .sort();
async function applyThrough(database, maximum) {
  for (const migration of migrations.filter((name) => Number(name.slice(0, 3)) <= maximum)) {
    const args = migration.startsWith("006_")
      ? [
          "--single-transaction",
          "-f",
          `migrations/${migration}`,
          "-f",
          "migrations/007_normalized_legacy.sql",
        ]
      : ["-f", `migrations/${migration}`];
    if (!migration.startsWith("007_"))
      await run("psql", ["-X", "-d", database, "-v", "ON_ERROR_STOP=1", ...args]);
  }
}
let started = false;
try {
  await mkdir(socket);
  await run("initdb", ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run("pg_ctl", [
    "-D",
    data,
    "-o",
    `-F -k ${socket} -p ${clusterEnv.PGPORT}`,
    "-l",
    join(temp, "pg.log"),
    "-w",
    "start",
  ]);
  started = true;
  await sql("CREATE ROLE otl_direct_owner LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION");
  await sql("CREATE DATABASE otl_direct_fresh OWNER otl_direct_owner");
  dbEnv = { ...clusterEnv, PGUSER: "otl_direct_owner", PGDATABASE: "otl_direct_fresh" };
  await applyThrough("otl_direct_fresh", 42);
  await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-f", "qa/referral-storage-fixture.sql"]);
  await sql(
    "INSERT INTO otl.workspace_members(team_id,user_id,display_name,is_bot,is_app_user,slack_deleted) VALUES('TREF','ULEAK','Leak',false,false,false)",
  );
  const token = "a".repeat(64);
  await sql(
    `SELECT otl.referral_runtime_execute('issue','${JSON.stringify({ teamId: "TREF", userId: "UREFERRER", linkId: "LNK-DIRECT42", tokenDigest: token, now: "2026-09-21T01:00:00Z" })}'::jsonb)`,
  );
  const direct = (n) => ({
    teamId: "TREF",
    tokenDigest: token,
    emailDigest: String(n).repeat(64),
    requestId: `REQ-DIRECT42${n}`,
    receiptId: `RCP-DIRECT42${n}`,
    withdrawalDigest: "b".repeat(64),
    consentVersion: "invite-consent-v1",
    consentedAt: "2026-09-21T01:00:00Z",
    key: `direct-join-${n}`,
    now: "2026-09-21T01:00:00Z",
  });
  const race = await Promise.all(
    [1, 2, 3].map((n) =>
      sql(`SELECT otl.referral_direct_join('${JSON.stringify(direct(n))}'::jsonb)`),
    ),
  );
  assert.equal(race.map((value) => JSON.parse(value).accepted).filter(Boolean).length, 2);
  assert.equal(
    await sql(
      "SELECT count(*) FROM otl.referral_requests WHERE admission_mode='shared_invite' AND state='approved'",
    ),
    "2",
  );
  const replayInput = {
    ...direct(1),
    requestId: "REQ-DIRECT42REPLAY",
    receiptId: "RCP-DIRECT42REPLAY",
    withdrawalDigest: "c".repeat(64),
    now: "2026-09-21T01:00:05Z",
  };
  const replay = JSON.parse(
    await sql(`SELECT otl.referral_direct_join('${JSON.stringify(replayInput)}'::jsonb)`),
  );
  assert.equal(replay.accepted, true);
  assert.equal(replay.requestId, "REQ-DIRECT421");
  assert.equal(
    await sql("SELECT count(*) FROM otl.referral_requests WHERE admission_mode='shared_invite'"),
    "2",
  );
  assert.equal(await sql("SELECT count(*) FROM otl.referral_private_payloads"), "0");
  assert.equal(
    await sql("SELECT count(*) FROM otl.referral_outbox WHERE effect_type='admin_review'"),
    "0",
  );
  assert.equal(await sql("SELECT count(*) FROM otl.referral_decisions"), "0");
  assert.equal(await sql("SELECT count(*) FROM otl.referral_manual_invite_assertions"), "0");
  const first = direct(1);
  const matched = JSON.parse(
    await sql(
      `SELECT otl.referral_attribute_join('${JSON.stringify({ teamId: "TREF", userId: "UJOINED", emailDigest: first.emailDigest, eventId: "EvDirect42", now: "2026-09-21T02:00:00Z" })}'::jsonb)`,
    ),
  );
  assert.equal(matched.newlyAttributed, true);
  const duplicate = JSON.parse(
    await sql(
      `SELECT otl.referral_attribute_join('${JSON.stringify({ teamId: "TREF", userId: "UJOINED", emailDigest: first.emailDigest, eventId: "EvDirect42", now: "2026-09-21T02:00:01Z" })}'::jsonb)`,
    ),
  );
  assert.equal(duplicate.newlyAttributed, false);
  assert.equal(
    await sql(
      `SELECT otl.referral_attribute_join('${JSON.stringify({ teamId: "TREF", userId: "ULEAK", emailDigest: "f".repeat(64), eventId: "EvLeak42", now: "2026-09-21T02:01:00Z" })}'::jsonb) IS NULL`,
    ),
    "t",
  );
  assert.equal(await sql("SELECT count(*) FROM otl.member_referral_attributions"), "1");
  await sql(
    `SELECT otl.referral_retention_execute('expire_due','${JSON.stringify({ teamId: "TREF", now: "2026-10-22T01:00:00Z", limit: 10 })}'::jsonb)`,
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM otl.referral_requests WHERE admission_mode='shared_invite' AND state='expired'",
    ),
    "1",
  );
  assert.equal(
    await sql(
      "SELECT has_function_privilege('otl_referral_runtime','otl.referral_direct_join(jsonb)','EXECUTE')",
    ),
    "t",
  );
  assert.equal(
    await sql(
      "SELECT has_function_privilege('otl_referral_admin_login','otl.referral_direct_join(jsonb)','EXECUTE')",
    ),
    "f",
  );
  assert.equal(
    await sql(
      "SELECT count(*) FROM otl.schema_migrations WHERE version='042-instant-shared-invite-join'",
    ),
    "1",
  );

  await sql("CREATE DATABASE otl_direct_upgrade OWNER otl_direct_owner");
  await applyThrough("otl_direct_upgrade", 41);
  await run("psql", [
    "-X",
    "-d",
    "otl_direct_upgrade",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "migrations/042_instant_shared_invite_join.sql",
  ]);
  assert.equal(await sql("SELECT 1"), "1");
  const upgradeVersion = (
    await run("psql", [
      "-X",
      "-d",
      "otl_direct_upgrade",
      "-Atq",
      "-c",
      "SELECT count(*) FROM otl.schema_migrations WHERE version='042-instant-shared-invite-join'",
    ])
  ).stdout.trim();
  assert.equal(upgradeVersion, "1");
  console.log(
    "PASS instant shared invite pg: concurrent=2-of-3 private=0 admin-review=0 exact=joined duplicate=idempotent leak=unmatched expiry=releases fresh=1 upgrade=1 grants=least-privilege",
  );
} finally {
  if (started) await run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
