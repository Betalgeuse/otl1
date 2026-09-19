import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-review-topology-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(56000 + Math.floor(Math.random() * 3000));
const baseEnv = { ...process.env, PGHOST: socket, PGPORT: port };
let started = false;
const run = (bin, args, database = "postgres") =>
  exec(bin, args, { cwd: root, env: { ...baseEnv, PGDATABASE: database }, encoding: "utf8" });
const psql = async (sql, database = "upgrade") =>
  (await run(join(pgBin, "psql"), ["-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql], database)).stdout.trim();
const payload = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const call = async (op, value, database = "upgrade") =>
  JSON.parse(await psql(`SELECT otl.community_execute('${op}',convert_from(decode('${payload(value)}','base64'),'UTF8')::jsonb)`, database));
const migrationFiles = (await readdir(join(root, "migrations")))
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .sort();

async function applyThrough(database, maximum) {
  const first = migrationFiles.filter((name) => Number(name.slice(0, 3)) <= 5 && Number(name.slice(0, 3)) <= maximum);
  for (const file of first) await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${file}`], database);
  if (maximum >= 7)
    await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", "migrations/006_normalized_foundation.sql", "-f", "migrations/007_normalized_legacy.sql"], database);
  for (const file of migrationFiles.filter((name) => Number(name.slice(0, 3)) >= 8 && Number(name.slice(0, 3)) <= maximum))
    await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${file}`], database);
}

try {
  await run("mkdir", ["-p", socket]);
  await run(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pgBin, "pg_ctl"), ["-D", data, "-o", `-F -k ${socket} -p ${port}`, "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  await run(join(pgBin, "createdb"), ["upgrade"]);
  await run(join(pgBin, "createdb"), ["fresh"]);
  await applyThrough("upgrade", 30);
  await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", "qa/review-thread-topology-fixture.sql"], "upgrade");

  const scope = { teamId: "T-REVIEW", channelId: "C-REVIEW", userId: "U1" };
  await call("change", { ...scope, date: "2026-09-18", key: "goal", action: "goal", text: "ship", delivery: { source: "1100.1", thread: "1100.1" } });
  await call("change", { ...scope, date: "2026-09-18", key: "reflection", action: "reflection", text: "done", outcome: "complete", delivery: { source: "1900.1", thread: "1900.1" } });
  assert.equal(await psql("SELECT count(*)>=3 FROM otl.community_garden_projections WHERE team_id='T-REVIEW' AND user_id='U1'"), "t");
  await psql("INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,revision) VALUES('T-REVIEW','C-REVIEW','U2','2026-09-18','goal',1)");
  const oldBatch = await call("claim_reminder_batch", { teamId: "T-REVIEW", channelId: "C-REVIEW", now: "2026-09-18T11:00:00Z", workerId: "qa", leaseToken: "old-top-level" });
  assert.equal(oldBatch.threadTs, undefined);
  assert.equal(oldBatch.jobs.some((job) => job.kind === "review"), true);
  await call("finish_reminder_batch", { teamId: "T-REVIEW", channelId: "C-REVIEW", leaseToken: "old-top-level", status: "cancelled" });
  await psql("UPDATE otl.community_records SET status='pending',reminder_attempts=0,reminder_batch_key=NULL,reminder_first_attempt_at=NULL WHERE team_id='T-REVIEW' AND kind='reminder' AND body->>'kind'='review'");

  await psql(`UPDATE otl.community_garden_deliveries SET status='sent',attempts=1,payload='{"text":"old","blocks":[{"type":"image"}]}',payload_digest=repeat('a',64),message_ts='1700.1' WHERE delivery_id=(SELECT min(delivery_id) FROM otl.community_garden_deliveries WHERE team_id='T-REVIEW' AND user_id='U1');
    UPDATE otl.community_garden_projections p SET published_revision=d.day_revision,message_ts=d.message_ts,payload_digest=d.payload_digest FROM otl.community_garden_deliveries d WHERE d.projection_key=p.projection_key AND d.message_ts='1700.1'`);
  await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", "migrations/031_review_thread_gardens.sql"], "upgrade");
  assert.equal(await psql("SELECT count(*) FROM otl.community_review_roots"), "0");

  const bound = await call("bind_review_root", { teamId: "T-REVIEW", channelId: "C-REVIEW", userId: "UADMIN", date: "2026-09-18", messageTs: "1800.1" });
  assert.deepEqual({ root: bound.threadTs, enqueued: bound.enqueued }, { root: "1800.1", enqueued: 1 });
  assert.equal((await call("bind_review_root", { teamId: "T-REVIEW", channelId: "C-REVIEW", userId: "UADMIN", date: "2026-09-18", messageTs: "1800.1" })).enqueued, 0);
  assert.equal(await psql("SELECT count(*) FROM otl.community_review_roots WHERE team_id='T-REVIEW' AND day='2026-09-18'"), "1");

  const batch = await call("claim_review_reminder_batch", { teamId: "T-REVIEW", channelId: "C-REVIEW", now: "2026-09-18T11:01:00Z", workerId: "qa", leaseToken: "threaded-1" });
  assert.deepEqual({ date: batch.date, kind: batch.kind, threadTs: batch.threadTs }, { date: "2026-09-18", kind: "review", threadTs: "1800.1" });
  assert.equal(batch.jobs.every((job) => job.kind === "review"), true);
  const reclaimed = await call("claim_review_reminder_batch", { teamId: "T-REVIEW", channelId: "C-REVIEW", now: "2026-09-18T11:06:01Z", workerId: "qa", leaseToken: "threaded-2" });
  assert.equal(reclaimed.batchKey, batch.batchKey);
  assert.equal(reclaimed.attempt, 2);
  await call("finish_review_reminder_batch", { teamId: "T-REVIEW", channelId: "C-REVIEW", leaseToken: "threaded-2", status: "sent", messageTs: "1800.2" });
  await psql("UPDATE otl.community_records SET status='pending',reminder_attempts=0,reminder_batch_key=NULL,body=body-'threadTs'-'messageTs' WHERE team_id='T-REVIEW' AND user_id='U2' AND record_key='reminder:2026-09-18:review'; UPDATE otl.community_records SET body=body||'{\"ts\":\"1800.9\"}'::jsonb WHERE team_id='T-REVIEW' AND record_key='common-thread:2026-09-18:review'");
  assert.equal(await call("claim_review_reminder_batch", { teamId: "T-REVIEW", channelId: "C-REVIEW", now: "2026-09-18T11:07:00Z", workerId: "qa", leaseToken: "stale-root" }), null);
  await psql("UPDATE otl.community_records SET body=body||'{\"ts\":\"1800.1\"}'::jsonb WHERE team_id='T-REVIEW' AND record_key='common-thread:2026-09-18:review'; UPDATE otl.community_records SET status='failed',reminder_attempts=3 WHERE team_id='T-REVIEW' AND user_id='U2' AND record_key='reminder:2026-09-18:review'");
  assert.equal(await call("claim_review_reminder_batch", { teamId: "T-REVIEW", channelId: "C-REVIEW", now: "2026-09-18T11:08:00Z", workerId: "qa", leaseToken: "exhausted" }), null);

  await psql(`INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status) VALUES
    ('T-OTHER','C-OTHER','U1','reminder:2026-09-18:review','reminder','{"date":"2026-09-18","kind":"review"}','pending'),
    ('T-OTHER','C-OTHER','U1','common:2026-09-18:review','dispatch','{"date":"2026-09-18","kind":"review"}','failed')`);
  assert.equal(await call("claim_review_reminder_batch", { teamId: "T-OTHER", channelId: "C-OTHER", now: "2026-09-18T11:00:00Z", workerId: "qa", leaseToken: "held" }), null);
  assert.equal(await psql("SELECT status FROM otl.community_records WHERE team_id='T-OTHER' AND record_key='reminder:2026-09-18:review'"), "pending");

  const reconcile = { teamId: "T-REVIEW", channelId: "C-REVIEW", from: "2026-09-18", through: "2026-09-18", limit: 20, reconciliationKey: "review-upgrade", dryRun: false };
  const applied = await call("reconcile_review_thread_gardens", reconcile);
  assert.equal(applied.canonicalRoutes, 1);
  assert.equal((await call("reconcile_review_thread_gardens", reconcile)).replayed, true);
  const concurrent = await Promise.all([
    call("reconcile_review_thread_gardens", { ...reconcile, reconciliationKey: "concurrent-a" }),
    call("reconcile_review_thread_gardens", { ...reconcile, reconciliationKey: "concurrent-b" }),
  ]);
  assert.equal(concurrent.reduce((sum, item) => sum + item.deliveriesEnqueued, 0), 0);
  assert.equal(await psql("SELECT count(*) FROM otl.community_garden_projections WHERE team_id='T-REVIEW' AND day='2026-09-18' AND route_kind<>'review_prompt' AND EXISTS(SELECT 1 FROM otl.community_garden_deliveries d WHERE d.projection_key=community_garden_projections.projection_key AND d.status IN ('pending','claimed','failed'))"), "0");
  assert.equal(await psql("SELECT count(*) FROM otl.community_garden_projections WHERE team_id='T-REVIEW' AND user_id='U1' AND day='2026-09-18' AND thread_ts='1800.1' AND route_provenance='canonical_review'"), "1");

  await Promise.all([
    call("change", { ...scope, date: "2026-09-18", key: "edit-a", action: "reflection", text: "edit a" }),
    call("change", { ...scope, date: "2026-09-18", key: "edit-b", action: "reflection", text: "edit b" }),
  ]);
  await Promise.all([
    call("route_review_garden", { ...scope, date: "2026-09-18", sourceTs: "1901.1" }),
    call("route_review_garden", { ...scope, date: "2026-09-18", sourceTs: "1901.2" }),
  ]);
  assert.equal(await psql("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='T-REVIEW' AND user_id='U1' AND day='2026-09-18' AND thread_ts='1800.1' AND status='pending'"), "1");
  assert.equal(await call("claim_review_garden_retirement", { teamId: "T-REVIEW", channelId: "C-REVIEW", now: "2026-09-18T11:59:00Z", workerId: "qa", leaseToken: "too-soon" }), null);

  const key = await psql("SELECT delivery_key FROM otl.community_garden_deliveries WHERE team_id='T-REVIEW' AND user_id='U1' AND thread_ts='1800.1' AND status='pending'");
  const garden = await call("claim_garden_delivery", { teamId: "T-REVIEW", channelId: "C-REVIEW", deliveryKey: key, leaseToken: "garden-1", now: "2026-09-18T12:00:00Z" });
  await call("prepare_garden_delivery", { ...scope, deliveryKey: key, leaseToken: "garden-1", payloadDigest: "b".repeat(64), payload: { text: "replacement", blocks: [{ type: "image" }] } });
  const lostResponse = await call("claim_garden_delivery", { teamId: "T-REVIEW", channelId: "C-REVIEW", deliveryKey: key, leaseToken: "garden-2", now: "2026-09-18T12:05:01Z" });
  assert.deepEqual({ key: lostResponse.deliveryKey, attempts: lostResponse.attempts }, { key, attempts: garden.attempts + 1 });
  const preservedPayload = await call("prepare_garden_delivery", { ...scope, deliveryKey: key, leaseToken: "garden-2", payloadDigest: "b".repeat(64), payload: { text: "different" } });
  assert.equal(preservedPayload.payload.text, "replacement");
  await call("finish_garden_delivery", { ...scope, deliveryKey: key, leaseToken: "garden-2", status: "sent", messageTs: "1800.3" });
  const retirement = await call("claim_review_garden_retirement", { teamId: "T-REVIEW", channelId: "C-REVIEW", now: "2026-09-18T12:01:00Z", workerId: "qa", leaseToken: "retire-1" });
  assert.deepEqual({ messageTs: retirement.messageTs, replacementMessageTs: retirement.replacementMessageTs, action: retirement.action, preserveReplies: retirement.preserveReplies, payload: retirement.restorePayload.text }, { messageTs: "1700.1", replacementMessageTs: "1800.3", action: "update", preserveReplies: true, payload: "old" });
  await call("finish_review_garden_retirement", { teamId: "T-REVIEW", channelId: "C-REVIEW", retirementId: retirement.retirementId, leaseToken: "retire-1", status: "retired" });
  const restore = await call("claim_review_garden_restore", { teamId: "T-REVIEW", channelId: "C-REVIEW", retirementId: retirement.retirementId, workerId: "qa", leaseToken: "restore-1" });
  assert.equal(restore.restorePayload.text, "old");
  await call("finish_review_garden_restore", { teamId: "T-REVIEW", channelId: "C-REVIEW", retirementId: retirement.retirementId, leaseToken: "restore-1", status: "restored" });

  const beforeInvalid = await psql("SELECT count(*) FROM otl.community_review_roots");
  await assert.rejects(call("bind_review_root", { teamId: "T-REVIEW", channelId: "C-REVIEW", userId: "UADMIN", date: "bad", messageTs: "bad" }), /date|timestamp|invalid/i);
  assert.equal(await psql("SELECT count(*) FROM otl.community_review_roots"), beforeInvalid);
  assert.equal(await psql("SELECT count(*) FROM otl.community_review_roots WHERE team_id='T-OTHER'"), "0");
  assert.equal(await psql("SELECT has_function_privilege('public','otl.community_execute(text,jsonb)','EXECUTE')"), "f");
  assert.equal(await psql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='otl' AND p.proname IN ('review_root_ts','enqueue_review_garden','community_execute') AND (NOT coalesce(p.proconfig,'{}')@>ARRAY['search_path=pg_catalog, otl'] OR has_function_privilege('public',p.oid,'EXECUTE'))"), "0");
  assert.equal(await psql("SELECT count(*) FROM otl.schema_migrations WHERE version='031-review-thread-gardens'"), "1");

  await applyThrough("fresh", 31);
  assert.equal(await psql("SELECT count(*) FROM otl.schema_migrations WHERE version='031-review-thread-gardens'", "fresh"), "1");
  assert.match(await readFile(join(temp, "postgres.log"), "utf8"), /database system is ready/);
  console.log(`REVIEW_THREAD_OBSERVABLES=${await psql(`SELECT jsonb_build_object(
    'roots',count(*) FILTER(WHERE metric='root'),
    'canonicalProjections',count(*) FILTER(WHERE metric='canonical'),
    'activeNonReview',count(*) FILTER(WHERE metric='non_review'),
    'restoredRetirements',count(*) FILTER(WHERE metric='restored'),
    'otherTeamRoots',count(*) FILTER(WHERE metric='other_root'),
    'sentGardenAttempts',max(value) FILTER(WHERE metric='sent_attempts'),
    'exhaustedReminderAttempts',max(value) FILTER(WHERE metric='reminder_attempts')
  ) FROM (
    SELECT 'root' metric,0 value FROM otl.community_review_roots WHERE team_id='T-REVIEW'
    UNION ALL SELECT 'canonical',0 FROM otl.community_garden_projections WHERE team_id='T-REVIEW' AND route_provenance='canonical_review'
    UNION ALL SELECT 'non_review',0 FROM otl.community_garden_deliveries WHERE team_id='T-REVIEW' AND status IN ('pending','claimed','failed') AND route_provenance<>'canonical_review'
    UNION ALL SELECT 'restored',0 FROM otl.community_garden_retirements WHERE team_id='T-REVIEW' AND status='restored'
    UNION ALL SELECT 'other_root',0 FROM otl.community_review_roots WHERE team_id='T-OTHER'
    UNION ALL SELECT 'sent_attempts',attempts FROM otl.community_garden_deliveries WHERE team_id='T-REVIEW' AND message_ts='1800.3'
    UNION ALL SELECT 'reminder_attempts',reminder_attempts FROM otl.community_records WHERE team_id='T-REVIEW' AND user_id='U2' AND record_key='reminder:2026-09-18:review'
  ) observed`)}`);
  console.log("PASS review topology 031: baseline fan-out/top-level, exact review root, held replies, review-only gardens, idempotent concurrency, replacement-before-retirement, reversible payload, tenant isolation, fresh+upgrade");
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
