import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile),
  root = resolve(import.meta.dirname, ".."),
  pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-garden-pg-"),
  data = join(temp, "data"),
  socket = join(temp, "socket"),
  port = String(56500 + Math.floor(Math.random() * 3000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
let started = false;
const run = (bin, args) => exec(bin, args, { cwd: root, env, encoding: "utf8" });
const psql = (args) => run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
const call = async (op, payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const { stdout } = await psql([
    "-Atc",
    `SELECT otl.community_execute('${op}',convert_from(decode('${encoded}','base64'),'UTF8')::jsonb)`,
  ]);
  return JSON.parse(stdout.trim());
};
const scope = { teamId: "T-GARDEN", channelId: "C-GARDEN", userId: "U-GARDEN" };
const route = { source: "1.1", thread: "1.1", undoKey: null };
try {
  await run("mkdir", ["-p", socket]);
  await run(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pgBin, "pg_ctl"), [
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
  for (const file of [
    "001_initial.sql",
    "002_invitation_tables.sql",
    "003_invitation_functions.sql",
    "004_membership_guard.sql",
    "005_community.sql",
  ])
    await psql(["-f", `migrations/${file}`]);
  await psql([
    "--single-transaction",
    "-f",
    "migrations/006_normalized_foundation.sql",
    "-f",
    "migrations/007_normalized_legacy.sql",
  ]);
  for (const file of [
    "008_default_reminders.sql",
    "009_welcome_guides.sql",
    "010_first_registration.sql",
    "011_member_introductions.sql",
    "012_introduction_public_details.sql",
    "013_multiline_introductions.sql",
    "014_bug_ledger.sql",
    "015_bug_deliveries.sql",
    "016_bug_delivery_scheduler.sql",
    "017_bug_expiry_job_guard.sql",
    "018_bug_integrity.sql",
    "019_bug_team_scope.sql",
    "020_bug_private_atomic.sql",
    "021_bug_private_backfill.sql",
    "022_bug_private_read.sql",
    "023_current_channel_membership.sql",
    "024_durable_garden_publication.sql",
  ])
    await psql(["-f", `migrations/${file}`]);
  const goal = {
    ...scope,
    date: "2026-09-18",
    key: "goal-1",
    action: "goal",
    text: "durable grass",
    delivery: route,
  };
  const changed = await call("change", goal);
  assert.equal(changed.gardenDeliveryKey, "garden:2026-09-18:r1");
  assert.equal(changed.changed, true);
  const first = await call("claim_garden_delivery", {
    teamId: scope.teamId,
    channelId: scope.channelId,
    deliveryKey: changed.gardenDeliveryKey,
    leaseToken: "lease-1",
    now: "2026-09-18T03:00:00Z",
  });
  assert.equal(first.attempts, 1);
  assert.equal(
    await call("prepare_garden_delivery", {
      ...scope,
      deliveryKey: first.deliveryKey,
      leaseToken: "lease-1",
      payloadDigest: "a".repeat(64),
    }),
    true,
  );
  assert.equal(
    await call("finish_garden_delivery", {
      ...scope,
      deliveryKey: first.deliveryKey,
      leaseToken: "lease-1",
      status: "failed",
      errorCode: "rate_limited",
      retryAfter: "2026-09-18T03:01:00Z",
    }),
    true,
  );
  assert.equal(
    await call("claim_garden_delivery", {
      teamId: scope.teamId,
      channelId: scope.channelId,
      deliveryKey: first.deliveryKey,
      leaseToken: "too-early",
      now: "2026-09-18T03:00:59Z",
    }),
    null,
  );
  const retry = await call("claim_garden_delivery", {
    teamId: scope.teamId,
    channelId: scope.channelId,
    deliveryKey: first.deliveryKey,
    leaseToken: "lease-2",
    now: "2026-09-18T03:01:00Z",
  });
  assert.equal(retry.attempts, 2);
  assert.equal(
    await call("finish_garden_delivery", {
      ...scope,
      deliveryKey: first.deliveryKey,
      leaseToken: "lease-2",
      status: "sent",
      messageTs: "2.2",
    }),
    true,
  );
  const complete = await call("change", {
    ...scope,
    date: "2026-09-18",
    key: "complete-1",
    action: "complete",
    delivery: route,
  });
  const lost = await call("claim_garden_delivery", {
    teamId: scope.teamId,
    channelId: scope.channelId,
    deliveryKey: complete.gardenDeliveryKey,
    leaseToken: "lost-response",
    now: "2026-09-18T04:00:00Z",
  });
  assert.equal(lost.attempts, 1);
  const reclaimed = await call("claim_garden_delivery", {
    teamId: scope.teamId,
    channelId: scope.channelId,
    deliveryKey: complete.gardenDeliveryKey,
    leaseToken: "reconcile",
    now: "2026-09-18T04:05:01Z",
  });
  assert.equal(reclaimed.attempts, 2);
  assert.equal(
    await call("prepare_garden_delivery", {
      ...scope,
      deliveryKey: complete.gardenDeliveryKey,
      leaseToken: "reconcile",
      payloadDigest: "b".repeat(64),
    }),
    true,
  );
  assert.equal(
    await call("finish_garden_delivery", {
      ...scope,
      deliveryKey: complete.gardenDeliveryKey,
      leaseToken: "reconcile",
      status: "sent",
      messageTs: "3.3",
    }),
    true,
  );
  const replay = await call("change", goal);
  assert.equal(replay.changed, false);
  const { stdout } = await psql([
    "-Atc",
    `SELECT jsonb_build_object('rows',count(*),'sent',count(*) FILTER(WHERE status='sent'),'maxAttempts',max(attempts)) FROM otl.community_garden_deliveries WHERE team_id='${scope.teamId}'`,
  ]);
  assert.deepEqual(JSON.parse(stdout.trim()), { rows: 2, sent: 2, maxAttempts: 2 });
  console.log(
    "PASS PostgreSQL 024 transactionally enqueues garden, retries failures, reclaims accepted-response loss, and suppresses replay duplicates",
  );
} finally {
  if (started)
    await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
