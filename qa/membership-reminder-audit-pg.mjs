import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-member-audit-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(57000 + Math.floor(Math.random() * 8000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
let started = false;
const run = (bin, args) => exec(bin, args, { cwd: root, env, encoding: "utf8" });
const psql = async (sql) =>
  (await run(join(pgBin, "psql"), ["-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql])).stdout.trim();
const payload = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const call = async (op, value) =>
  JSON.parse(
    await psql(
      `SELECT otl.community_execute('${op}',convert_from(decode('${payload(value)}','base64'),'UTF8')::jsonb)`,
    ),
  );
const files = (await readdir(join(root, "migrations")))
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .sort();
async function apply(filesToApply) {
  for (const file of filesToApply)
    await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${file}`]);
}
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
  await apply(files.filter((name) => Number(name.slice(0, 3)) <= 5));
  await run(join(pgBin, "psql"), [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "--single-transaction",
    "-f",
    "migrations/006_normalized_foundation.sql",
    "-f",
    "migrations/007_normalized_legacy.sql",
  ]);
  await apply(files.filter((name) => Number(name.slice(0, 3)) >= 8));

  const base = { teamId: "TAUDIT", channelId: "CAUDIT", userId: "UADMIN" };
  const member = (userId, displayName) => ({
    userId,
    displayName,
    isBot: false,
    isAppUser: false,
    deleted: false,
  });
  assert.equal(
    await call("reconcile_channel_members", {
      ...base,
      observedAt: "2026-09-18T01:00:00Z",
      complete: true,
      members: [member("U1", "Newest One"), member("U2", "Newest Two")],
    }),
    true,
  );
  assert.equal(
    await call("reconcile_channel_members", {
      ...base,
      observedAt: "2026-09-18T00:00:00Z",
      complete: true,
      members: [member("U3", "Old Three")],
    }),
    false,
  );
  assert.equal(
    await call("reconcile_channel_members", {
      ...base,
      observedAt: "2026-09-18T01:00:00Z",
      complete: true,
      members: [member("U3", "Equal Three")],
    }),
    false,
  );
  assert.equal(
    await psql(
      "SELECT string_agg(user_id||':'||is_current,',' ORDER BY user_id) FROM otl.workspace_channel_memberships WHERE team_id='TAUDIT'",
    ),
    "U1:true,U2:true",
  );
  await assert.rejects(
    call("reconcile_channel_members", {
      ...base,
      observedAt: "2026-09-18T02:00:00Z",
      complete: true,
      members: [{ ...member("U4", ""), displayName: "" }],
    }),
    /invalid channel member/,
  );
  assert.equal(
    await psql(
      "SELECT membership_observed_at='2026-09-18T01:00:00Z' FROM otl.workspace_channels WHERE team_id='TAUDIT'",
    ),
    "t",
  );
  assert.equal(
    await call("reconcile_channel_members", {
      ...base,
      observedAt: "2026-09-18T02:00:00Z",
      complete: true,
      members: [],
    }),
    true,
  );
  assert.equal(
    await psql(
      "SELECT count(*) FROM otl.workspace_channel_memberships WHERE team_id='TAUDIT' AND is_current",
    ),
    "0",
  );
  assert.equal(
    await psql(
      "SELECT display_name FROM otl.workspace_members WHERE team_id='TAUDIT' AND user_id='U1'",
    ),
    "Newest One",
  );

  await psql("UPDATE otl.workspaces SET primary_goal_channel_id='CAUDIT' WHERE team_id='TAUDIT'");
  assert.equal(
    await call("observe_member_join", {
      ...base,
      observedAt: "2026-09-18T03:00:00Z",
      member: member("U1", "Rejoined One"),
    }),
    true,
  );
  let joined = await call("preferences", { ...base, userId: "U1" });
  assert.equal(joined.enabled, true);
  await call("preferences", {
    ...base,
    userId: "U1",
    enabled: false,
    goalTime: "12:34",
    reviewTime: "21:09",
  });
  await call("reconcile_channel_members", {
    ...base,
    observedAt: "2026-09-18T04:00:00Z",
    complete: true,
    members: [],
  });
  assert.equal(
    await call("observe_member_join", {
      ...base,
      observedAt: "2026-09-18T05:00:00Z",
      member: member("U1", "Rejoined Again"),
    }),
    true,
  );
  joined = await call("preferences", { ...base, userId: "U1" });
  assert.deepEqual(
    { enabled: joined.enabled, goalTime: joined.goalTime, reviewTime: joined.reviewTime },
    { enabled: false, goalTime: "12:34", reviewTime: "21:09" },
  );
  assert.equal(
    await psql(
      "SELECT display_name||':'||is_current FROM otl.workspace_members JOIN otl.workspace_channel_memberships USING(team_id,user_id) WHERE team_id='TAUDIT' AND user_id='U1'",
    ),
    "Rejoined Again:true",
  );
  assert.equal(
    await call("observe_member_join", {
      ...base,
      observedAt: "2026-09-18T04:30:00Z",
      member: member("U1", "Stale Replay"),
    }),
    false,
  );
  assert.equal(
    await psql(
      "SELECT display_name FROM otl.workspace_members WHERE team_id='TAUDIT' AND user_id='U1'",
    ),
    "Rejoined Again",
  );

  await psql(`
    INSERT INTO otl.workspace_members(team_id,user_id,display_name,is_bot,is_app_user,slack_deleted,directory_synced_at)
      SELECT 'TAUDIT','UE'||lpad(n::text,3,'0'),'Eligible '||n,false,false,false,'2026-09-18T05:00:00Z' FROM generate_series(1,201)n;
    INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
      SELECT 'TAUDIT','CAUDIT','UE'||lpad(n::text,3,'0'),true,'2026-09-18T05:00:00Z','2026-09-18T05:00:00Z' FROM generate_series(1,201)n;
    INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,preference_source,eligible_from,goal_time,review_time)
      SELECT 'TAUDIT','CAUDIT','UE'||lpad(n::text,3,'0'),true,'default','2026-09-18','11:00','20:00' FROM generate_series(1,201)n;
    INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
      SELECT 'TAUDIT','CAUDIT','UE'||lpad(n::text,3,'0'),'active','2026-09-18T05:00:00Z','2026-09-18T05:00:00Z' FROM generate_series(1,201)n;
    INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
      SELECT 'TAUDIT','CAUDIT','UE'||lpad(n::text,3,'0'),'2026-09-18T05:00:00Z','2026-09-18','rollout' FROM generate_series(1,201)n;
  `);
  const now = "2026-09-18T02:00:00Z";
  const sizes = [];
  for (let index = 0; index < 3; index += 1) {
    const batch = await call("claim_reminder_batch", {
      teamId: "TAUDIT",
      channelId: "CAUDIT",
      now,
      workerId: "qa",
      leaseToken: `chunk-${index}`,
    });
    sizes.push(batch.jobs.length);
    assert.equal(
      await call("finish_reminder_batch", {
        teamId: "TAUDIT",
        channelId: "CAUDIT",
        leaseToken: batch.leaseToken,
        status: "sent",
      }),
      true,
    );
  }
  assert.deepEqual(sizes, [100, 100, 1]);
  assert.equal(
    await call("claim_reminder_batch", {
      teamId: "TAUDIT",
      channelId: "CAUDIT",
      now,
      workerId: "qa",
      leaseToken: "chunk-end",
    }),
    null,
  );

  await psql(`
    INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
      VALUES('TAUDIT','CAUDIT','U1','active','2026-09-18T05:00:00Z','2026-09-18T05:00:00Z'),
            ('TAUDIT','CAUDIT','U2','active','2026-09-18T05:00:00Z','2026-09-18T05:00:00Z')
      ON CONFLICT DO NOTHING;
    INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
      SELECT team_id,channel_id,user_id,'2026-09-18T05:00:00Z','2026-09-18','rollout'
      FROM otl.member_lifecycles l WHERE team_id='TAUDIT' AND user_id IN ('U1','U2')
        AND NOT EXISTS(SELECT 1 FROM otl.grass_seasons s WHERE s.team_id=l.team_id AND s.user_id=l.user_id);
    INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,preference_source,eligible_from,goal_time,review_time) VALUES('TAUDIT','CAUDIT','U2',true,'default','2026-09-18','11:00','20:00') ON CONFLICT(team_id,channel_id,user_id) DO UPDATE SET enabled=true;
    UPDATE otl.community_preferences SET enabled=true,goal_time='11:00',eligible_from='2026-09-18' WHERE team_id='TAUDIT' AND user_id IN ('U1','U2');
    UPDATE otl.workspace_channel_memberships SET is_current=true,synced_at='2026-09-18T06:00:00Z' WHERE team_id='TAUDIT' AND user_id IN ('U1','U2');
    INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body)
      VALUES ('TAUDIT','CAUDIT','U1','reminder:2026-09-18:goal','reminder','{"date":"2026-09-18","kind":"goal"}'),
             ('TAUDIT','CAUDIT','U2','reminder:2026-09-18:goal','reminder','{"date":"2026-09-18","kind":"goal"}')
      ON CONFLICT(team_id,channel_id,user_id,record_key) DO UPDATE SET status='pending',reminder_attempts=0,reminder_batch_key=NULL,reminder_first_attempt_at=NULL,reminder_lease_token=NULL,reminder_lease_expires_at=NULL,reminder_retry_after=NULL,reminder_last_error_code=NULL;
  `);
  const definite = await call("claim_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    now,
    workerId: "qa",
    leaseToken: "definite-1",
  });
  assert.equal(definite.jobs.length, 2);
  await call("finish_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    leaseToken: "definite-1",
    status: "failed",
    errorCode: "rate_limited",
    retryAfterSeconds: 1,
  });
  await psql(
    "UPDATE otl.workspace_channel_memberships SET is_current=false WHERE team_id='TAUDIT' AND user_id='U2'; UPDATE otl.community_records SET reminder_retry_after='2026-09-18T02:00:01Z' WHERE reminder_batch_key='definite-1'",
  );
  const definiteRetry = await call("claim_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    now: "2026-09-18T02:00:02Z",
    workerId: "qa",
    leaseToken: "definite-2",
  });
  assert.deepEqual(
    definiteRetry.jobs.map((value) => value.userId),
    ["U1"],
  );
  await call("finish_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    leaseToken: "definite-2",
    status: "sent",
  });
  assert.equal(
    await psql(
      "SELECT status FROM otl.community_records WHERE team_id='TAUDIT' AND user_id='U2' AND record_key='reminder:2026-09-18:goal'",
    ),
    "cancelled",
  );

  await psql(
    `UPDATE otl.community_records SET status='pending',reminder_attempts=0,reminder_batch_key=NULL,reminder_first_attempt_at=NULL,reminder_lease_token=NULL,reminder_lease_expires_at=NULL,reminder_retry_after=NULL,reminder_last_error_code=NULL WHERE team_id='TAUDIT' AND user_id IN ('U1','U2') AND record_key='reminder:2026-09-18:goal'; UPDATE otl.workspace_channel_memberships SET is_current=true WHERE team_id='TAUDIT' AND user_id='U2'`,
  );
  const ambiguous = await call("claim_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    now,
    workerId: "qa",
    leaseToken: "ambiguous-1",
  });
  await call("finish_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    leaseToken: "ambiguous-1",
    status: "failed",
    errorCode: "transport_error",
    retryAfterSeconds: 1,
  });
  await psql(
    "UPDATE otl.workspace_channel_memberships SET is_current=false WHERE team_id='TAUDIT' AND user_id='U2'; UPDATE otl.community_records SET reminder_retry_after='2026-09-18T02:00:01Z' WHERE reminder_batch_key='ambiguous-1'",
  );
  const ambiguousRetry = await call("claim_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    now: "2026-09-18T02:00:02Z",
    workerId: "qa",
    leaseToken: "ambiguous-2",
  });
  assert.ok(ambiguousRetry.jobs.some((value) => value.userId === "U2"));
  const pruned = await call("prune_reminder_batch", {
    teamId: "TAUDIT",
    channelId: "CAUDIT",
    now: "2026-09-18T02:00:02Z",
    leaseToken: "ambiguous-2",
  });
  assert.deepEqual(
    pruned.jobs.map((value) => value.userId),
    ["U1"],
  );

  await call("put_record", {
    ...base,
    key: "common:2026-09-18:goal",
    kind: "dispatch",
    body: { date: "2026-09-18", kind: "goal", text: "stable exact payload" },
  });
  const common1 = await call("claim_common_delivery", { ...base, now, leaseToken: "common-1" });
  assert.equal(common1.attempt, 1);
  await call("finish_common_delivery", {
    ...base,
    leaseToken: "common-1",
    status: "failed",
    errorCode: "http_5xx",
    retryAfterSeconds: 1,
  });
  await psql(
    "UPDATE otl.community_records SET reminder_retry_after='2026-09-18T02:00:01Z' WHERE record_key='common:2026-09-18:goal'",
  );
  const common2 = await call("claim_common_delivery", {
    ...base,
    now: "2026-09-18T02:00:02Z",
    leaseToken: "common-2",
  });
  assert.deepEqual(
    { attempt: common2.attempt, text: common2.text },
    { attempt: 2, text: "stable exact payload" },
  );
  await call("finish_common_delivery", {
    ...base,
    leaseToken: "common-2",
    status: "failed",
    errorCode: "http_5xx",
    retryAfterSeconds: 1,
  });
  await psql(
    "UPDATE otl.community_records SET reminder_retry_after='2026-09-18T02:00:03Z' WHERE record_key='common:2026-09-18:goal'",
  );
  const common3 = await call("claim_common_delivery", {
    ...base,
    now: "2026-09-18T02:00:04Z",
    leaseToken: "common-3",
  });
  assert.equal(common3.attempt, 3);
  await call("finish_common_delivery", {
    ...base,
    leaseToken: "common-3",
    status: "failed",
    errorCode: "http_5xx",
    retryAfterSeconds: 1,
  });
  assert.equal(
    await call("claim_common_delivery", {
      ...base,
      now: "2026-09-18T02:00:06Z",
      leaseToken: "common-4",
    }),
    null,
  );
  await call("put_record", {
    ...base,
    key: "common:2026-09-18:review",
    kind: "dispatch",
    body: { date: "2026-09-18", kind: "review", text: "concurrent payload" },
  });
  const concurrent = await Promise.all([
    call("claim_common_delivery", { ...base, now, leaseToken: "concurrent-a" }),
    call("claim_common_delivery", { ...base, now, leaseToken: "concurrent-b" }),
  ]);
  assert.equal(concurrent.filter(Boolean).length, 1);
  assert.notEqual(
    await call("next_schedule_due", { teamId: "TAUDIT", channelId: "CAUDIT", now }),
    undefined,
  );
  const fixture = await run(join(pgBin, "psql"), [
    "-XAtq",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "qa/current-member-reminders.sql",
  ]);
  assert.match(fixture.stdout, /PASS current member reminder SQL/);

  console.log(
    "PASS migration 027: monotonic/empty/atomic membership, opt-out preserving rejoin, 201-member chunks, per-peer retry pruning, ambiguity-before-prune, durable common retry",
  );
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
