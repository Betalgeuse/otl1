import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-bug-expiry-");
const data = join(temp, "pgdata");
const socket = join(temp, "socket");
const port = String(64000 + Math.floor(Math.random() * 1000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };

async function command(binary, args) {
  return exec(binary, args, { cwd: root, env, encoding: "utf8" });
}
async function psql(args) {
  return command(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
}
function psqlSession() {
  const child = spawn(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-At"], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waitFor = (marker) =>
    new Promise((resolvePromise, rejectPromise) => {
      const inspect = (chunk) => {
        stdout += String(chunk);
        if (stdout.includes(marker)) {
          child.stdout.off("data", inspect);
          resolvePromise();
        }
      };
      child.stdout.on("data", inspect);
      child.once("error", rejectPromise);
      child.once("close", (code) => {
        if (!stdout.includes(marker)) rejectPromise(new Error(stderr || `psql exited ${code}`));
      });
    });
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const finish = (sql) =>
    new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) =>
        code === 0 ? resolvePromise(stdout) : rejectPromise(new Error(stderr || `psql exited ${code}`)),
      );
      child.stdin.end(`${sql}\n\\q\n`);
    });
  return { child, finish, waitFor };
}

let started = false;
try {
  await command("mkdir", ["-p", socket]);
  await command(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await command(join(pgBin, "pg_ctl"), [
    "-D", data, "-o", `-F -k ${socket} -p ${port}`, "-l", join(temp, "postgres.log"), "-w", "start",
  ]);
  started = true;
  await psql(["-f", "migrations/001_initial.sql"]);
  await psql(["-f", "migrations/005_community.sql"]);
  await psql(["--single-transaction", "-f", "migrations/006_normalized_foundation.sql", "-f", "migrations/007_normalized_legacy.sql"]);
  for (const migration of [
    "014_bug_ledger",
    "015_bug_deliveries",
    "016_bug_delivery_scheduler",
    "017_bug_expiry_job_guard",
    "018_bug_integrity",
    "019_bug_team_scope",
    "020_bug_private_atomic",
  ])
    await psql(["-f", `migrations/${migration}.sql`]);

  const contract = await psql(["-At", "-f", "qa/bug-expiry-job-guard-contract.sql"]);
  const result = JSON.parse(contract.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null");
  assert.deepEqual(result, {
    confirmedTransitionJob: true,
    expiryBoundary: true,
    jobsZeroBeforeConfirmation: true,
    questionCap: true,
    replayIdempotent: true,
    transactionalOutbox: true,
  });

  const fixture = `
    INSERT INTO otl.bug_reports(bug_id,team_id,public_alias,reporter_id,source,source_opaque_ref,source_channel_id,source_thread,title,state,needs_info_started_at,question_count,confirmed_packet_digest)
    VALUES('BUG-RACE000001','T-RACE','B-RACE000001','U-RACE','slack','slack:T-RACE:C-RACE:1','C-RACE','1.1','race','needs_info','2026-09-16T12:00:00Z',1,repeat('a',64));
    INSERT INTO otl.bug_report_revisions(bug_id,packet_revision,schema_version,status,sanitized_fields,opaque_ref,object_digest,envelope_dek,kek_version,nonce)
    VALUES('BUG-RACE000001',1,'bug_intake.v1','draft','{}','bugs/race/revision-1.enc',repeat('a',64),'encrypted-envelope','v1','nonce-123456');`;
  await psql(["-c", fixture]);
  const reporter = psqlSession();
  reporter.child.stdin.write(`BEGIN;
    SELECT bug_id FROM otl.bug_reports WHERE bug_id='BUG-RACE000001' FOR UPDATE;
    \\echo BUG_ROW_LOCKED
  `);
  await reporter.waitFor("BUG_ROW_LOCKED");
  const skipped = await psql(["-Atc", "SELECT otl.bug_expire_due_intakes(jsonb_build_object('teamId','T-RACE','now','2026-09-17T12:00:00Z','limit',10))"]);
  assert.equal(skipped.stdout.trim(), "0", "SKIP LOCKED must not race a reporter-held report row");
  await reporter.finish(`
    SELECT otl.bug_transition(jsonb_build_object('bugId','BUG-RACE000001','toState','triaged','actors',jsonb_build_array('reporter','deterministic_worker'),'guard',jsonb_build_object('allMissingSupplied',true),'evidence',jsonb_build_object('packetDigest',repeat('a',64)),'expectedRevision',0,'idempotencyKey','reporter-wins'));
    COMMIT;`);
  const race = JSON.parse((await psql(["-Atc", "SELECT jsonb_build_object('state',state,'events',(SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-RACE000001'),'deliveries',(SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-RACE000001')) FROM otl.bug_reports WHERE bug_id='BUG-RACE000001'"])).stdout.trim());
  assert.deepEqual(race, { deliveries: 0, events: 1, state: "triaged" });

  await psql(["-c", `
    SELECT otl.bug_create_draft(jsonb_build_object(
      'bugId','BUG-PRIVATERACE1','teamId','T-RACE','publicAlias','B-PRIVATERACE10',
      'reporterId','U-RACE','source','slack','sourceOpaqueRef','slack:T-RACE:C-RACE:2',
      'sourceChannelId','C-RACE','sourceThread','2.1','idempotencyKey','private-race-draft',
      'sanitizedFields',jsonb_build_object('title','CANARY-PRIVATE-RACE','actual','CANARY-PRIVATE-RACE','steps','[]'::jsonb,'privacy',true),
      'opaqueRef','bugs/private-race.enc','objectDigest',repeat('b',64),
      'envelopeDek','encrypted-envelope','kekVersion','v1','nonce','nonce-123456'));
  `]);
  const privateReporter = psqlSession();
  privateReporter.child.stdin.write(`BEGIN;
    SELECT bug_id FROM otl.bug_reports WHERE bug_id='BUG-PRIVATERACE1' FOR UPDATE;
    \\echo PRIVATE_ROW_LOCKED
  `);
  await privateReporter.waitFor("PRIVATE_ROW_LOCKED");
  const privateSkipped = await psql([
    "-Atc",
    "SELECT otl.bug_reconcile_private_incidents(jsonb_build_object('teamId','T-RACE','now','2026-09-17T12:00:00Z','limit',10))",
  ]);
  assert.equal(privateSkipped.stdout.trim(), "0", "private reconcile must skip a reporter-held row");
  await privateReporter.finish("UPDATE otl.bug_reports SET updated_at=clock_timestamp() WHERE bug_id='BUG-PRIVATERACE1'; COMMIT;");
  const privateReconciled = await psql([
    "-Atc",
    "SELECT otl.bug_reconcile_private_incidents(jsonb_build_object('teamId','T-RACE','now','2026-09-17T12:00:01Z','limit',10))",
  ]);
  assert.equal(privateReconciled.stdout.trim(), "1");
  const privateRace = JSON.parse((await psql(["-Atc", "SELECT jsonb_build_object('state',state,'events',(SELECT count(*) FROM otl.bug_events WHERE bug_id='BUG-PRIVATERACE1'),'deliveries',(SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='BUG-PRIVATERACE1'),'jobs',(SELECT count(*) FROM otl.bug_jobs WHERE bug_id='BUG-PRIVATERACE1'),'canary',EXISTS(SELECT 1 FROM otl.bug_report_revisions WHERE bug_id='BUG-PRIVATERACE1' AND sanitized_fields::text LIKE '%CANARY-PRIVATE-RACE%')) FROM otl.bug_reports WHERE bug_id='BUG-PRIVATERACE1'"])).stdout.trim());
  assert.deepEqual(privateRace, { canary: false, deliveries: 2, events: 1, jobs: 0, state: "private_incident" });
  console.log(JSON.stringify({ status: "PASS", ...result, competingReporter: true, privateReconcileRace: true, cleanup: "complete" }));
} finally {
  if (started) await command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
