import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-projection-pg-");
const data = join(temp, "data"),
  socket = join(temp, "socket"),
  port = String(57000 + Math.floor(Math.random() * 2000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
let started = false;
const run = (bin, args) => exec(bin, args, { cwd: root, env, encoding: "utf8" });
const psql = (args) => run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
async function call(op, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const { stdout } = await psql([
    "-Atc",
    `SELECT otl.community_execute('${op}',convert_from(decode('${encoded}','base64'),'UTF8')::jsonb)`,
  ]);
  return JSON.parse(stdout.trim());
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
  for (const n of Array.from({ length: 18 }, (_, i) => String(i + 8).padStart(3, "0"))) {
    const file = (await import("node:fs"))
      .readdirSync("migrations")
      .find((x) => x.startsWith(`${n}_`));
    await psql(["-f", `migrations/${file}`]);
  }
  const fixture = `INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,revision)
 SELECT 'T-PROJ','C-PROJ','U-'||lpad(((n-1)%4+1)::text,2,'0'),date '2026-08-08'+(n-1),'goal-'||n,CASE WHEN n=1 THEN 0 ELSE 2 END FROM generate_series(1,42)n;
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day,revision) VALUES('T-PROJ','C-PROJ','U-BLANK','2026-09-18',0);
 INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status)
 SELECT 'T-PROJ','C-PROJ','U-'||lpad(((n-1)%4+1)::text,2,'0'),'typed-'||n,'pending',jsonb_build_object('date',(date '2026-08-08'+(n-1))::text,'source',(1000+n)::text||'.1','thread',(2000+n)::text||'.1'),'sent' FROM generate_series(1,27)n;
 INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status)
 SELECT 'T-PROJ','C-PROJ','U-ADMIN','prompt-'||n,'prompt',jsonb_build_object('date',(date '2026-08-08'+(n-1))::text,'kind','goal','ts',(3000+n)::text||'.1'),'sent' FROM generate_series(28,42)n;
 INSERT INTO otl.profiles(team_id,user_id,start_date) VALUES('T-PROJ','U-01','2026-09-01'),('T-PROJ','U-02','2026-09-01');
 INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,revision) VALUES
 ('T-PROJ','C-PROJ','UA','2026-07-15','a',2),('T-PROJ','C-PROJ','UB','2026-07-15','b',2),('T-PROJ','C-PROJ','UC','2026-07-15','c',2),('T-PROJ','C-PROJ','UD','2026-07-15','d',2);
 INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status) VALUES
 ('T-PROJ','C-PROJ','U-ADMIN','prompt-shared','prompt',jsonb_build_object('date','2026-07-15','kind','goal','ts','9000.1'),'sent');`;
  await psql(["-c", fixture]);
  const scope = {
    teamId: "T-PROJ",
    channelId: "C-PROJ",
    from: "2026-08-08",
    through: "2026-09-18",
    limit: 100,
    reconciliationKey: "qa-42",
  };
  const before = (
    await psql([
      "-Atc",
      "SELECT md5(string_agg(row_to_json(d)::text,',' ORDER BY day,user_id)) FROM otl.community_days d WHERE team_id='T-PROJ' AND channel_id='C-PROJ'",
    ])
  ).stdout.trim();
  const dry = await call("reconcile_garden_projections", { ...scope, dryRun: true });
  assert.deepEqual(
    [dry.plannedRoutes, dry.fallbackRoutes, dry.unroutableDays, dry.insertedRoutes],
    [42, 15, 0, 0],
  );
  const applied = await call("reconcile_garden_projections", { ...scope, dryRun: false });
  assert.deepEqual(
    [applied.insertedRoutes, applied.deliveriesEnqueued, applied.profileRepairs],
    [42, 42, 2],
  );
  const replay = await call("reconcile_garden_projections", { ...scope, dryRun: false });
  assert.equal(replay.replayed, true);
  assert.equal(replay.insertedRoutes, 0);
  assert.equal(replay.deliveriesEnqueued, 0);
  await assert.rejects(
    () => call("reconcile_garden_projections", { ...scope, userId: "U-01", dryRun: false }),
    /scope mismatch/,
  );
  const after = (
    await psql([
      "-Atc",
      "SELECT md5(string_agg(row_to_json(d)::text,',' ORDER BY day,user_id)) FROM otl.community_days d WHERE team_id='T-PROJ' AND channel_id='C-PROJ'",
    ])
  ).stdout.trim();
  assert.equal(after, before);
  assert.equal(
    (
      await psql(["-Atc", "SELECT count(*) FROM otl.community_events WHERE team_id='T-PROJ'"])
    ).stdout.trim(),
    "0",
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        "SELECT count(*) FROM otl.community_garden_deliveries WHERE day_revision=0",
      ])
    ).stdout.trim(),
    "1",
  );
  const shared = {
    teamId: "T-PROJ",
    channelId: "C-PROJ",
    from: "2026-07-15",
    through: "2026-07-15",
    limit: 10,
    reconciliationKey: "qa-shared",
    dryRun: false,
  };
  const four = await call("reconcile_garden_projections", shared);
  assert.equal(four.insertedRoutes, 4);
  const routes = JSON.parse(
    (
      await psql([
        "-Atc",
        "SELECT json_agg(json_build_object('u',user_id,'p',projection_key,'t',thread_ts) ORDER BY user_id) FROM otl.community_garden_projections WHERE day='2026-07-15'",
      ])
    ).stdout.trim(),
  );
  assert.equal(routes.length, 4);
  assert.equal(new Set(routes.map((x) => x.p)).size, 4);
  assert.deepEqual(new Set(routes.map((x) => x.t)), new Set(["9000.1"]));
  const firstKey = (
    await psql([
      "-Atc",
      "SELECT delivery_key FROM otl.community_garden_deliveries WHERE user_id='UA' AND day='2026-07-15'",
    ])
  ).stdout.trim();
  const claimed = await call("claim_garden_delivery", {
    teamId: "T-PROJ",
    channelId: "C-PROJ",
    deliveryKey: firstKey,
    leaseToken: "lease-old",
    now: "2026-09-18T01:00:00Z",
  });
  await call("finish_garden_delivery", {
    teamId: "T-PROJ",
    channelId: "C-PROJ",
    userId: "UA",
    deliveryKey: claimed.deliveryKey,
    leaseToken: "lease-old",
    status: "failed",
    errorCode: "rate_limited",
    retryAfter: "2026-09-18T02:00:00Z",
  });
  await call("change", {
    teamId: "T-PROJ",
    channelId: "C-PROJ",
    userId: "UA",
    date: "2026-09-18",
    key: "later",
    action: "goal",
    text: "later",
    delivery: { source: "9100.1", thread: "9100.1", undoKey: null },
  });
  assert.equal(
    (
      await psql([
        "-Atc",
        `SELECT status FROM otl.community_garden_deliveries WHERE user_id='UA' AND delivery_key='${firstKey}'`,
      ])
    ).stdout.trim(),
    "failed",
  );
  await call("change", {
    teamId: "T-PROJ",
    channelId: "C-PROJ",
    userId: "UA",
    date: "2026-07-15",
    key: "same-route-new",
    action: "complete",
    delivery: { source: "9000.1", thread: "9000.1", undoKey: null },
  });
  assert.equal(
    (
      await psql([
        "-Atc",
        `SELECT status FROM otl.community_garden_deliveries WHERE user_id='UA' AND delivery_key='${firstKey}'`,
      ])
    ).stdout.trim(),
    "cancelled",
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        "SELECT count(*) FROM otl.community_garden_deliveries WHERE user_id='UB' AND day='2026-07-15' AND status='pending'",
      ])
    ).stdout.trim(),
    "1",
  );
  console.log(
    "PASS projection 025: 42-day/15-fallback reconcile, revision0, rerun0, four-user shared root, canonical preservation, other-date retry isolation",
  );
} finally {
  if (started)
    await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
