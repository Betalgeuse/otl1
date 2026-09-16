import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-bug-storage-");
const data = join(temp, "pgdata");
const socket = join(temp, "socket");
const port = String(56000 + Math.floor(Math.random() * 5000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };

async function command(binary, args, options = {}) {
  return exec(binary, args, { cwd: root, env, encoding: "utf8", ...options });
}

async function psql(args) {
  return command(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
}

async function callJson(functionName, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  return psql([
    "-Atc",
    `SELECT otl.${functionName}(convert_from(decode('${encoded}','base64'),'UTF8')::jsonb)`,
  ]);
}

let started = false;
let finalResult;
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

  const baseline = await psql([
    "-Atc",
    "SELECT jsonb_build_object('transition_function_missing', to_regprocedure('otl.bug_transition(jsonb)') IS NULL, 'get_draft_function_missing', to_regprocedure('otl.bug_get_draft(jsonb)') IS NULL, 'find_active_function_missing', to_regprocedure('otl.bug_find_active_draft(jsonb)') IS NULL, 'report_table_missing', to_regclass('otl.bug_reports') IS NULL)",
  ]);
  const baselineJson = JSON.parse(baseline.stdout.trim());
  assert.deepEqual(baselineJson, {
    find_active_function_missing: true,
    get_draft_function_missing: true,
    report_table_missing: true,
    transition_function_missing: true,
  });

  if (process.argv.includes("--baseline")) {
    throw new Error("EXPECTED_BASELINE_FAILURE: bug storage contract is absent");
  }

  await psql(["--single-transaction", "-f", "migrations/014_bug_ledger.sql"]);
  const verification = await psql(["-At", "-f", "qa/bug-storage-contract.sql"]);
  const lines = verification.stdout.trim().split("\n").filter(Boolean);
  const result = JSON.parse(lines.at(-1) ?? "null");
  assert.equal(result.contract_edges_tested, result.contract_edges_total);
  assert.equal(result.side_effect_failures, 0);
  assert.deepEqual(result.manual_status_sequence, [
    "new",
    "needs_info",
    "triaged",
    "queued",
    "reproducing",
  ]);
  assert.equal(result.rollback_rows, 0);
  assert.equal(result.read_apis, true);

  const canonicalFixture = JSON.parse(
    await readFile(join(root, "qa/fixtures/bug-packets/confirmed-valid.v1.json"), "utf8"),
  );
  const fixtureDraft = {
    bugId: canonicalFixture.bugId,
    teamId: "T-FIXTURE",
    publicAlias: "B-QACONFIRM01",
    reporterId: "fixture-reporter",
    source: "api",
    sourceOpaqueRef: canonicalFixture.source.opaqueRef,
    idempotencyKey: "fixture-draft",
    sanitizedFields: { title: "canonical fixture", ...canonicalFixture.fields },
    opaqueRef: "object/fixture/draft",
    objectDigest: "8".repeat(64),
    envelopeDek: "encrypted-envelope",
    kekVersion: "v1",
    nonce: "nonce-123456",
  };
  await callJson("bug_create_draft", fixtureDraft);
  const fixtureEnvelope = {
    packet: canonicalFixture,
    storage: {
      teamId: "T-FIXTURE",
      reporterId: "fixture-reporter",
      expectedPacketRevision: 1,
      idempotencyKey: "fixture-confirm",
      opaqueRef: "object/fixture/confirmed",
      objectDigest: "9".repeat(64),
      envelopeDek: "encrypted-envelope",
      kekVersion: "v1",
      nonce: "nonce-654321",
    },
  };
  const fixtureConfirmation = await callJson("bug_confirm_packet", fixtureEnvelope);
  assert.deepEqual(JSON.parse(fixtureConfirmation.stdout.trim()), canonicalFixture);
  const fixtureRead = await psql([
    "-Atc",
    'SELECT otl.bug_get_draft(\'{"teamId":"T-FIXTURE","bugId":"BUG-QACONFIRM01","reporterId":"fixture-reporter"}\'::jsonb)',
  ]);
  const fixtureStored = JSON.parse(fixtureRead.stdout.trim());
  assert.deepEqual(fixtureStored.currentRevision.confirmedPacket, canonicalFixture);
  assert.equal(fixtureStored.currentRevision.latestOpaqueRef, "object/fixture/confirmed");
  assert.equal(JSON.stringify(fixtureStored).includes("encrypted-envelope"), false);

  finalResult = {
    status: "PASS",
    baseline: baselineJson,
    ...result,
    canonical_fixture_digest_unchanged: true,
    database: "disposable-local-postgresql",
    cleanup: "complete",
  };
} finally {
  if (started) {
    await command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  }
  await rm(temp, { recursive: true, force: true });
}
assert.notEqual(finalResult, undefined);
console.log(JSON.stringify(finalResult));
