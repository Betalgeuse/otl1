import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/community-private-backfill-qa-");
const data = join(temp, "pgdata");
const socket = join(temp, "socket");
const port = String(62000 + Math.floor(Math.random() * 2000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };

async function command(binary, args) {
  return exec(binary, args, { cwd: root, env, encoding: "utf8" });
}

async function psql(args) {
  return command(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
}

let started = false;
try {
  await command("mkdir", ["-p", socket]);
  await command(join(pgBin, "initdb"), [
    "-D",
    data,
    "--no-locale",
    "--encoding=UTF8",
    "--auth=trust",
  ]);
  await command(join(pgBin, "pg_ctl"), [
    "-D",
    data,
    "-o",
    `-F -k ${socket} -p ${port}`,
    "-l",
    join(temp, "postgres.log"),
    "-w",
    "start",
  ]);
  started = true;
  await psql(["-f", "migrations/001_initial.sql"]);
  await psql(["-f", "migrations/005_community.sql"]);
  await psql([
    "--single-transaction",
    "-f",
    "migrations/006_normalized_foundation.sql",
    "-f",
    "migrations/007_normalized_legacy.sql",
  ]);
  for (const migration of [
    "014_bug_ledger",
    "015_bug_deliveries",
    "016_bug_delivery_scheduler",
    "017_bug_expiry_job_guard",
  ])
    await psql(["-f", `migrations/${migration}.sql`]);
  await psql(["-f", "qa/bug-private-backfill-fixture.sql"]);
  const before = await psql([
    "-Atc",
    "SELECT count(*) FROM otl.bug_report_revisions WHERE bug_id='BUG-BACKFILL021A' AND sanitized_fields::text LIKE '%CANARY-BACKFILL-021%'",
  ]);
  assert.equal(before.stdout.trim(), "3");
  for (const migration of [
    "018_bug_integrity",
    "019_bug_team_scope",
    "020_bug_private_atomic",
    "021_bug_private_backfill",
  ])
    await psql(["-f", `migrations/${migration}.sql`]);
  const contract = await psql(["-At", "-f", "qa/bug-private-backfill-contract.sql"]);
  const result = JSON.parse(contract.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null");
  assert.deepEqual(result, {
    backfillReplayZero: true,
    eventsPreserved: true,
    opaqueLineagePreserved: true,
    outboxUnique: true,
    upgradeCanaryAbsent: true,
  });
  console.log(JSON.stringify({ status: "PASS", ...result, cleanup: "complete" }));
} finally {
  if (started) await command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
