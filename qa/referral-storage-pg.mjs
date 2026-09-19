import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-referral-storage-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(58000 + Math.floor(Math.random() * 6000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const migrations = (await readdir(join(root, "migrations")))
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .sort();
let started = false;

const run = (binary, args) => exec(binary, args, { cwd: root, env, encoding: "utf8" });
const psql = (database, args) =>
  run(join(pgBin, "psql"), ["-X", "-d", database, "-v", "ON_ERROR_STOP=1", ...args]);
const scalar = async (database, sql) => (await psql(database, ["-Atq", "-c", sql])).stdout.trim();

async function applyThrough(database, maximum) {
  for (const migration of migrations.filter((name) => Number(name.slice(0, 3)) <= maximum)) {
    if (migration.startsWith("006_")) {
      await psql(database, ["--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"]);
      continue;
    }
    if (!migration.startsWith("007_")) await psql(database, ["-f", `migrations/${migration}`]);
  }
}

try {
  await mkdir(socket);
  await run(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pgBin, "pg_ctl"), ["-D", data, "-o", `-F -k ${socket} -p ${port}`, "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  await applyThrough("postgres", 29);
  if (process.env.REFERRAL_RED === "1") {
    await scalar("postgres", "SELECT otl.referral_runtime_execute('resolve','{}'::jsonb)");
  }
  await psql("postgres", ["-f", "qa/referral-storage-fixture.sql"]);
  await psql("postgres", ["-f", "migrations/030_referral_applications.sql"]);
  const contract = await psql("postgres", ["-Atq", "-f", "qa/referral-storage-contract.sql"]);
  assert.match(contract.stdout, /REFERRAL_STORAGE_CHECKS=([3-9][0-9]|[1-9][0-9]{2,})/);
  assert.match(contract.stdout, /PII_ROWS=0/);
  assert.match(contract.stdout, /LEGACY_EXECUTE_PUBLIC=false/);

  await psql("postgres", ["-c", "CREATE DATABASE otl_referral_fresh"]);
  await applyThrough("otl_referral_fresh", 30);
  assert.equal(await scalar("otl_referral_fresh", "SELECT count(*) FROM otl.schema_migrations WHERE version='030-referral-applications'"), "1");

  const payload = (key) => JSON.stringify({
    teamId: "TREF", tokenDigest: "a".repeat(64), emailDigest: "e".repeat(64),
    requestId: `REQ-${key}`, receiptId: `RCP-${key}`, withdrawalDigest: "b".repeat(64),
    consentVersion: "invite-consent-v1", consentedAt: "2026-09-19T01:00:00Z", key,
    opaqueRef: `invite-private/REQ-${key}/0.enc`, objectDigest: "d".repeat(64),
    envelopeDek: "opaque.envelope", nonce: "opaque-nonce", keyVersion: "invite-kek-2026-01",
    now: "2026-09-19T01:00:00Z",
  }).replaceAll("'", "''");
  const concurrent = await Promise.all([
    scalar("postgres", `SELECT otl.referral_runtime_execute('submit','${payload("RACE-A")}'::jsonb)`),
    scalar("postgres", `SELECT otl.referral_runtime_execute('submit','${payload("RACE-B")}'::jsonb)`),
  ]);
  assert.equal(new Set(concurrent.map((value) => JSON.parse(value).receiptId)).size, 1);
  assert.equal(await scalar("postgres", "SELECT count(*) FROM otl.referral_requests WHERE team_id='TREF' AND email_digest=repeat('e',64) AND state IN ('pending','approved')"), "1");
  const concurrentRequestId = JSON.parse(concurrent[0]).receiptId.replace("RCP-", "REQ-");
  const adminPayload = (decision, key) => JSON.stringify({
    teamId: "TREF", adminId: "UADMIN", requestId: concurrentRequestId,
    decision, expectedRevision: 0, key, now: "2026-09-19T01:01:00Z",
  }).replaceAll("'", "''");
  const decisions = await Promise.allSettled([
    scalar("postgres", `SELECT otl.referral_admin_execute('decide','${adminPayload("approved", "RACE-APPROVE")}'::jsonb)`),
    scalar("postgres", `SELECT otl.referral_admin_execute('decide','${adminPayload("declined", "RACE-DECLINE")}'::jsonb)`),
  ]);
  assert.equal(decisions.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(decisions.filter((value) => value.status === "rejected").length, 1);
  assert.equal(await scalar("postgres", `SELECT count(*) FROM otl.referral_decisions WHERE request_id='${concurrentRequestId}'`), "1");
  assert.equal(await scalar("postgres", `SELECT count(*) FROM otl.referral_outbox WHERE request_id='${concurrentRequestId}' AND effect_type='admin_decision'`), "1");

  console.log("PASS referral storage: fresh+upgrade=001-030 checks=" + contract.stdout.match(/REFERRAL_STORAGE_CHECKS=(\d+)/)?.[1] + " concurrent-open=1 concurrent-decision=1 pii-rows=0 roles=isolated rollback=clean legacy=disabled");
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
