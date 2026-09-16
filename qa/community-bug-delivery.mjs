import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CommunityBugDeliveryStore } from "../src/community-bug-delivery-store.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-bug-delivery-");
const data = join(temp, "pgdata");
const socket = join(temp, "socket");
const port = String(61000 + Math.floor(Math.random() * 3000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };

async function command(binary, args) {
  return exec(binary, args, { cwd: root, env, encoding: "utf8" });
}

async function psql(args) {
  return command(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
}

async function callJson(functionName, input) {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64");
  const response = await psql([
    "-At",
    "-c",
    `SELECT otl.${functionName}(convert_from(decode('${payload}','base64'),'UTF8')::jsonb)`,
  ]);
  return JSON.parse(response.stdout.trim());
}

let started = false;
let result;
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
  await psql(["-f", "migrations/014_bug_ledger.sql"]);
  const baseline = JSON.parse(
    (
      await psql([
        "-Atc",
        "SELECT jsonb_build_object('delivery_table_missing',to_regclass('otl.bug_deliveries') IS NULL,'enqueue_function_missing',to_regprocedure('otl.bug_enqueue_delivery(jsonb)') IS NULL,'claim_function_missing',to_regprocedure('otl.bug_claim_delivery(jsonb)') IS NULL)",
      ])
    ).stdout.trim(),
  );
  assert.deepEqual(baseline, {
    claim_function_missing: true,
    delivery_table_missing: true,
    enqueue_function_missing: true,
  });
  if (process.argv.includes("--baseline")) {
    throw new Error("EXPECTED_DELIVERY_BASELINE_FAILURE: persisted question has no retry outbox");
  }
  await psql(["-f", "migrations/015_bug_deliveries.sql"]);
  await psql(["-f", "migrations/016_bug_delivery_scheduler.sql"]);
  await callJson("bug_create_draft", {
    bugId: "BUG-PARSER001",
    teamId: "T-DELIVERY",
    publicAlias: "B-PARSER00001",
    reporterId: "U-OWNER",
    source: "slack",
    sourceOpaqueRef: "slack:T-DELIVERY:C-DELIVERY:3.1",
    sourceChannelId: "C-DELIVERY",
    sourceThread: "3.1",
    idempotencyKey: "parser-draft",
    sanitizedFields: { title: "parser fixture", actual: "fails", steps: [] },
    opaqueRef: "object/parser/draft",
    objectDigest: "1".repeat(64),
    envelopeDek: "encrypted-envelope",
    kekVersion: "v1",
    nonce: "nonce-123456",
  });
  await callJson("bug_transition", {
    bugId: "BUG-PARSER001",
    toState: "needs_info",
    actors: ["deterministic_worker"],
    guard: { missingRequiredField: true },
    evidence: {
      reasonCodes: "expected_missing",
      questionId: "parser-q1",
      fieldName: "expected",
      templateVersion: "question.expected.v1",
      questionText: "renderer-only fixture",
    },
    expectedRevision: 0,
    idempotencyKey: "parser-question",
  });
  const store = new CommunityBugDeliveryStore({
    async queryJson(query, params) {
      const functionName = query.match(/otl\.(bug_[a-z_]+)/)?.[1];
      assert.equal(functionName, "bug_enqueue_delivery");
      return callJson(functionName, JSON.parse(params[0]));
    },
  });
  const parsed = await store.enqueue({
    teamId: "T-DELIVERY",
    bugId: "BUG-PARSER001",
    reporterId: "U-OWNER",
    deliveryKey: "BUG-PARSER001:1:question:reporter_thread",
    deliveryKind: "question",
    packetRevision: 1,
    questionId: "parser-q1",
    destination: "reporter_thread",
    templateId: "question.expected.v1",
    fieldName: "expected",
    rendererVersion: "bug-question.v1",
  });
  assert.deepEqual(
    [parsed.status, parsed.attempts, parsed.retryAfter, parsed.lastErrorCode, parsed.messageTs],
    ["pending", 0, null, null, null],
  );
  const output = await psql(["-At", "-f", "qa/bug-delivery-contract.sql"]);
  result = JSON.parse(output.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null");
  assert.deepEqual(result, {
    autonomousDue: 2,
    expiredThirdClaim: true,
    cleanupRows: 0,
    deadLetterAttempts: 3,
    deadLetterStatus: "failed",
    independentRetry: true,
    deliveryKinds: 4,
    questionEvents: 2,
    sentAttempts: 2,
    sentStatus: "sent",
    sideEffectFailures: 0,
  });
} finally {
  if (started) {
    await command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  }
  await rm(temp, { recursive: true, force: true });
}
assert.notEqual(result, undefined);
console.log(JSON.stringify({ status: "PASS", ...result, cleanup: "complete" }));
