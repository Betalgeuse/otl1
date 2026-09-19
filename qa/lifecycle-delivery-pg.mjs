import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-lifecycle-delivery-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(57000 + Math.floor(Math.random() * 8000));
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
      await psql(database, [
        "--single-transaction",
        "-f",
        `migrations/${migration}`,
        "-f",
        "migrations/007_normalized_legacy.sql",
      ]);
      continue;
    }
    if (migration.startsWith("007_")) continue;
    await psql(database, ["-f", `migrations/${migration}`]);
  }
}

async function call(operation, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const raw = await scalar(
    "postgres",
    `SELECT otl.lifecycle_runtime_execute('${operation}',convert_from(decode('${encoded}','base64'),'UTF8')::jsonb)`,
  );
  return JSON.parse(raw);
}

const scope = { teamId: "TLR", channelId: "CLR" };
const now = "2026-10-08T15:00:01Z";
try {
  await mkdir(socket);
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
  await applyThrough("postgres", 32);
  assert.equal(
    await scalar(
      "postgres",
      "SELECT count(*) FROM otl.schema_migrations WHERE version='032-lifecycle-runtime-delivery'",
    ),
    "1",
  );

  await psql("postgres", [
    "-c",
    `INSERT INTO otl.workspaces(team_id) VALUES('TLR');
     INSERT INTO otl.workspace_channels(team_id,channel_id,membership_observed_at,complete_membership_observed_at)
       VALUES('TLR','CLR','2026-10-08T14:00:00Z','2026-10-08T14:00:00Z');
     UPDATE otl.workspaces SET primary_goal_channel_id='CLR' WHERE team_id='TLR';
     INSERT INTO otl.workspace_members(team_id,user_id) VALUES('TLR','UOWNER'),('TLR','UZOTHER');
     INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
       VALUES('TLR','CLR','UOWNER',true,'2026-10-08T14:00:00Z','2026-10-08T14:00:00Z'),
             ('TLR','CLR','UZOTHER',true,'2026-10-08T14:00:00Z','2026-10-08T14:00:00Z');
     INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,rollout_at,last_transition_at)
       VALUES('TLR','CLR','UOWNER','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z'),
             ('TLR','CLR','UZOTHER','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
     INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
       VALUES('TLR','CLR','UOWNER','2026-09-01T00:00:00Z','2026-09-01','rollout'),
             ('TLR','CLR','UZOTHER','2026-09-01T00:00:00Z','2026-09-01','rollout');
     INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status,updated_at)
       VALUES('TLR','CLR','UOWNER','dispatch:2026-10-08:goal','dispatch','{"date":"2026-10-08","kind":"goal"}','sent','2026-10-08T01:00:00Z');
     INSERT INTO otl.lifecycle_runtime_evaluations(team_id,channel_id,user_id,service_date,mode,eligible,
       signal_kind,candidate,explanation,evaluated_at)
       SELECT 'TLR','CLR',u,d,'shadow',true,NULL,false,'{"code":"window_incomplete"}',d::timestamptz
       FROM (VALUES('UOWNER'),('UZOTHER')) users(u),
         generate_series('2026-10-02'::date,'2026-10-07'::date,'1 day') days(d);`,
  ]);

  const shadow = await call("evaluate_batch", {
    ...scope,
    now,
    date: "2026-10-08",
    mode: "shadow",
    limit: 1,
  });
  assert.deepEqual(
    {
      processed: shadow.processed,
      candidates: shadow.candidates,
      transitions: shadow.transitions,
      possiblyMore: shadow.possiblyMore,
    },
    { processed: 1, candidates: 1, transitions: 0, possiblyMore: true },
  );
  assert.equal(
    await scalar("postgres", "SELECT state FROM otl.member_lifecycles WHERE user_id='UOWNER'"),
    "active",
  );
  assert.equal(await scalar("postgres", "SELECT count(*) FROM otl.lifecycle_notice_outbox"), "0");
  const secondShadow = await call("evaluate_batch", {
    ...scope,
    now,
    date: "2026-10-08",
    mode: "shadow",
    limit: 1,
  });
  assert.equal(secondShadow.processed, 1);
  assert.equal(secondShadow.possiblyMore, false);

  const enforce = await call("evaluate_batch", {
    ...scope,
    now,
    date: "2026-10-08",
    mode: "enforce",
    limit: 1,
  });
  assert.equal(enforce.transitions, 1);
  assert.equal(enforce.possiblyMore, true);
  assert.equal(
    await scalar(
      "postgres",
      "SELECT state||':'||revision FROM otl.member_lifecycles WHERE user_id='UOWNER'",
    ),
    "grace:1",
  );
  assert.equal(
    await scalar(
      "postgres",
      "SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE user_id='UOWNER'",
    ),
    "3",
  );
  assert.equal(
    await scalar(
      "postgres",
      `SELECT string_agg(notice_kind||'='||to_char(scheduled_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI'),',' ORDER BY scheduled_at)
       FROM otl.lifecycle_notice_outbox WHERE user_id='UOWNER'`,
    ),
    "grace_start=2026-10-09 00:00,three_days=2026-10-13 00:00,one_day=2026-10-15 00:00",
  );
  await call("evaluate_batch", { ...scope, now, date: "2026-10-08", mode: "enforce", limit: 1 });
  await psql("postgres", [
    "-c",
    `INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal)
       VALUES('TLR','CLR','UZOTHER','2026-10-09','stored current goal');`,
  ]);
  const signalPayload = Buffer.from(
    JSON.stringify({
      ...scope,
      userId: "UZOTHER",
      now: "2026-10-08T15:00:30Z",
      date: "2026-10-09",
      signal: "goal",
      expectedRevision: 1,
      key: "stored-goal-return",
    }),
  ).toString("base64");
  await scalar(
    "postgres",
    `SELECT otl.lifecycle_execute('signal',convert_from(decode('${signalPayload}','base64'),'UTF8')::jsonb)`,
  );
  await call("reconcile", { teamId: "TLR", now: "2026-10-08T15:00:31Z", limit: 10 });
  assert.equal(
    await scalar(
      "postgres",
      "SELECT state||':'||(SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE user_id='UZOTHER' AND status='cancelled') FROM otl.member_lifecycles WHERE user_id='UZOTHER'",
    ),
    "active:2",
    "only the stored current goal clears grace and cancels future policy notices",
  );

  const claim = await call("claim_notices", {
    teamId: "TLR",
    now,
    leaseToken: "lease-1",
    limit: 10,
  });
  assert.equal(claim.length, 2);
  assert.deepEqual(new Set(claim.map((item) => item.kind)), new Set(["grace_start"]));
  const ownerClaim = claim.find((item) => item.userId === "UOWNER");
  assert.ok(ownerClaim);
  assert.equal(
    await call("finish_notice", {
      teamId: "TLR",
      userId: "UOWNER",
      effectKey: ownerClaim.effectKey,
      leaseToken: "lease-1",
      now,
      status: "failed",
      errorCode: "http_429",
      retryAt: "2026-10-08T15:01:01Z",
    }),
    true,
  );
  assert.equal(
    (
      await call("claim_notices", {
        teamId: "TLR",
        now: "2026-10-08T15:01:00Z",
        leaseToken: "early",
        limit: 10,
      })
    ).length,
    0,
  );
  const retried = await call("claim_notices", {
    teamId: "TLR",
    now: "2026-10-08T15:01:01Z",
    leaseToken: "lease-2",
    limit: 10,
  });
  assert.equal(retried.length, 1);
  assert.equal(retried[0].attempts, 2);
  assert.equal(
    await call("finish_notice", {
      teamId: "TLR",
      userId: "UOWNER",
      effectKey: retried[0].effectKey,
      leaseToken: "lease-2",
      now: "2026-10-08T15:01:01Z",
      status: "sent",
      messageTs: "1.1",
    }),
    true,
  );

  const extension = await call("action", {
    ...scope,
    userId: "UOWNER",
    now: "2026-10-09T00:00:00Z",
    actionId: "lifecycle_extend",
    expectedRevision: 1,
    key: "extend:1",
  });
  assert.equal(extension.revision, 2);
  assert.deepEqual(
    await call("action", {
      ...scope,
      userId: "UOWNER",
      now: "2026-10-09T00:00:00Z",
      actionId: "lifecycle_extend",
      expectedRevision: 1,
      key: "extend:1",
    }),
    extension,
  );
  await assert.rejects(() =>
    call("action", {
      ...scope,
      userId: "UOWNER",
      now: "2026-10-09T00:00:01Z",
      actionId: "lifecycle_stop",
      expectedRevision: 1,
      key: "stale:1",
    }),
  );
  assert.equal(
    await scalar(
      "postgres",
      "SELECT revision||':'||(SELECT count(*) FROM otl.lifecycle_runtime_actions WHERE action_key='stale:1') FROM otl.member_lifecycles WHERE user_id='UOWNER'",
    ),
    "2:0",
    "a stale action rolls back without state or audit residue",
  );
  const review = await call("action", {
    ...scope,
    userId: "UOWNER",
    now: "2026-10-09T00:00:02Z",
    actionId: "lifecycle_review",
    expectedRevision: 2,
    key: "review:2",
  });
  assert.equal(review.reviewRequested, true);
  const stopped = await call("action", {
    ...scope,
    userId: "UOWNER",
    now: "2026-10-09T00:00:03Z",
    actionId: "lifecycle_stop",
    expectedRevision: 2,
    key: "stop:2",
  });
  assert.equal(stopped.state, "dormant");
  const adminPayload = Buffer.from(
    JSON.stringify({
      ...scope,
      userId: "UOWNER",
      now: "2026-10-09T00:00:04Z",
      expectedRevision: 3,
      key: "restore:3",
      evidenceKey: "correction:verified",
    }),
  ).toString("base64");
  const restored = JSON.parse(
    await scalar(
      "postgres",
      `SELECT otl.lifecycle_admin_execute('restore_error',convert_from(decode('${adminPayload}','base64'),'UTF8')::jsonb)`,
    ),
  );
  assert.equal(restored.state, "active");
  assert.equal(
    await scalar(
      "postgres",
      "SELECT string_agg(DISTINCT notice_kind,',' ORDER BY notice_kind) FROM otl.lifecycle_notice_outbox WHERE user_id='UOWNER'",
    ),
    "closure,extension,grace_start,one_day,return,three_days",
  );
  await psql("postgres", [
    "-c",
    `INSERT INTO otl.workspace_members(team_id,user_id) VALUES('TLR','UEXPIRE');
     INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
       VALUES('TLR','CLR','UEXPIRE',true,'2026-10-09T00:00:00Z','2026-10-09T00:00:00Z');
     INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,revision,rollout_at,last_transition_at,
       grace_started_at,grace_deadline)
       VALUES('TLR','CLR','UEXPIRE','grace',1,'2026-09-01T00:00:00Z','2026-10-01T00:00:00Z',
         '2026-10-01T00:00:00Z','2026-10-09');
     INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
       VALUES('TLR','CLR','UEXPIRE','2026-09-01T00:00:00Z','2026-09-01','rollout');`,
  ]);
  await call("reconcile", { teamId: "TLR", now: "2026-10-09T00:00:00Z", limit: 10 });
  assert.equal(
    await scalar(
      "postgres",
      "SELECT state||':'||revision FROM otl.member_lifecycles WHERE user_id='UEXPIRE'",
    ),
    "dormant:2",
  );
  await psql("postgres", [
    "-c",
    `INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal)
       VALUES('TLR','CLR','UEXPIRE','2026-10-09','new current goal');`,
  ]);
  const returnPayload = Buffer.from(
    JSON.stringify({
      ...scope,
      userId: "UEXPIRE",
      now: "2026-10-09T00:01:00Z",
      date: "2026-10-09",
      signal: "goal",
      expectedRevision: 2,
      key: "new-goal-return",
    }),
  ).toString("base64");
  await scalar(
    "postgres",
    `SELECT otl.lifecycle_execute('signal',convert_from(decode('${returnPayload}','base64'),'UTF8')::jsonb)`,
  );
  await call("reconcile", { teamId: "TLR", now: "2026-10-09T00:01:01Z", limit: 10 });
  assert.equal(
    await scalar(
      "postgres",
      "SELECT state||':'||(SELECT string_agg(notice_kind,',' ORDER BY notice_kind) FROM otl.lifecycle_notice_outbox WHERE user_id='UEXPIRE') FROM otl.member_lifecycles WHERE user_id='UEXPIRE'",
    ),
    "active:closure,return",
  );

  await psql("postgres", [
    "-c",
    `UPDATE otl.lifecycle_notice_outbox SET status='cancelled',lease_token=NULL,lease_expires_at=NULL
       WHERE status IN ('pending','failed','claimed');
     INSERT INTO otl.lifecycle_notice_outbox(team_id,channel_id,user_id,effect_key,notice_kind,lifecycle_revision,
       scheduled_at,payload,created_at,updated_at)
     VALUES('TLR','CLR','UOWNER','concurrent-only','return',4,'2026-10-09T00:01:00Z','{}',
       '2026-10-09T00:01:00Z','2026-10-09T00:01:00Z');`,
  ]);
  const concurrentClaims = await Promise.all([
    call("claim_notices", {
      teamId: "TLR",
      now: "2026-10-09T00:01:00Z",
      leaseToken: "race-a",
      limit: 1,
    }),
    call("claim_notices", {
      teamId: "TLR",
      now: "2026-10-09T00:01:00Z",
      leaseToken: "race-b",
      limit: 1,
    }),
  ]);
  assert.deepEqual(concurrentClaims.map((items) => items.length).sort(), [0, 1]);
  const raced = concurrentClaims.flat()[0];
  assert.ok(raced);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const leaseToken = attempt === 1 ? raced.leaseToken : `dead-${attempt}`;
    if (attempt > 1) {
      const retry = await call("claim_notices", {
        teamId: "TLR",
        now: `2026-10-09T00:0${attempt}:00Z`,
        leaseToken,
        limit: 1,
      });
      assert.equal(retry.length, 1);
    }
    await call("finish_notice", {
      teamId: "TLR",
      userId: "UOWNER",
      effectKey: "concurrent-only",
      leaseToken,
      now: `2026-10-09T00:0${attempt}:00Z`,
      status: "failed",
      errorCode: "http_503",
      retryAt: `2026-10-09T00:0${attempt + 1}:00Z`,
    });
  }
  assert.equal(
    await scalar(
      "postgres",
      "SELECT status||':'||attempts FROM otl.lifecycle_notice_outbox WHERE effect_key='concurrent-only'",
    ),
    "dead:3",
  );

  await assert.rejects(() =>
    scalar(
      "postgres",
      "SET ROLE otl_lifecycle_runtime; SELECT count(*) FROM otl.lifecycle_notice_outbox",
    ),
  );
  assert.equal(
    await scalar(
      "postgres",
      `SET ROLE otl_lifecycle_runtime; SELECT otl.lifecycle_runtime_execute('next_due','{"teamId":"TLR"}'::jsonb) IS NULL`,
    ),
    "t",
  );
  await assert.rejects(() =>
    scalar(
      "postgres",
      `SET ROLE otl_lifecycle_runtime; SELECT otl.lifecycle_admin_execute('restore_error','{}'::jsonb)`,
    ),
  );

  await psql("postgres", ["-c", "CREATE DATABASE otl_lifecycle_runtime_fresh"]);
  await applyThrough("otl_lifecycle_runtime_fresh", 32);
  assert.equal(
    await scalar(
      "otl_lifecycle_runtime_fresh",
      "SELECT count(*) FROM otl.schema_migrations WHERE version='032-lifecycle-runtime-delivery'",
    ),
    "1",
  );
  console.log(
    "PASS lifecycle PG: fresh+upgrade 001-032; shadow zero-effect; bounded fairness; enforce outbox; exact revision; 429 retry; role isolation",
  );
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
