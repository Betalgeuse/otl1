import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile),
  root = resolve(import.meta.dirname, ".."),
  pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-projection-upgrade-");
const data = join(temp, "data"),
  socket = join(temp, "socket"),
  port = String(59000 + Math.floor(Math.random() * 1000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
let started = false;
const run = (bin, args) => exec(bin, args, { cwd: root, env, encoding: "utf8" });
const psql = (args) => run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
async function call(op, payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64");
  const { stdout } = await psql([
    "-Atc",
    `SELECT otl.community_execute('${op}',convert_from(decode('${b}','base64'),'UTF8')::jsonb)`,
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
  for (let version = 8; version <= 24; version++) {
    const prefix = `${String(version).padStart(3, "0")}_`;
    const file = (await import("node:fs"))
      .readdirSync("migrations")
      .find((name) => name.startsWith(prefix));
    await psql(["-f", `migrations/${file}`]);
  }
  const seed = `INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,revision) VALUES
 ('T-UP','C-UP','UA','2026-09-15','a',2),('T-UP','C-UP','UB','2026-09-15','b',2),('T-UP','C-UP','UA','2026-09-14','older',1);
 INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status) VALUES
 ('T-UP','C-UP','UA','route-a','pending',jsonb_build_object('date','2026-09-15','source','102.1','thread','100.1'),'sent'),
 ('T-UP','C-UP','UB','route-b','pending',jsonb_build_object('date','2026-09-15','source','202.1','thread','200.1'),'sent'),
 ('T-UP','C-UP','UA','route-old','pending',jsonb_build_object('date','2026-09-14','source','90.1','thread','90.1'),'sent');
 INSERT INTO otl.community_garden_deliveries(team_id,channel_id,user_id,delivery_key,day,day_revision,source_ts,thread_ts,status,attempts,retry_after,error_code,payload_digest,message_ts,created_at,updated_at) VALUES
 ('T-UP','C-UP','UA','a-r1','2026-09-15',1,'101.1','100.1','failed',1,'2026-09-18T02:00:00Z','rate_limited',repeat('1',64),NULL,'2026-09-17T00:00:00Z','2026-09-17T01:00:00Z'),
 ('T-UP','C-UP','UA','a-r2','2026-09-15',2,'102.1','100.1','sent',1,NULL,NULL,repeat('2',64),'500.2','2026-09-18T00:00:00Z','2026-09-18T01:00:00Z'),
 ('T-UP','C-UP','UB','b-r1','2026-09-15',1,'201.1','200.1','sent',1,NULL,NULL,repeat('3',64),'600.1','2026-09-17T00:00:00Z','2026-09-17T01:00:00Z'),
 ('T-UP','C-UP','UB','b-r2','2026-09-15',2,'202.1','200.1','failed',2,'2026-09-18T03:00:00Z','transport_error',repeat('4',64),NULL,'2026-09-18T00:00:00Z','2026-09-18T02:00:00Z'),
 ('T-UP','C-UP','UA','other-date','2026-09-14',1,'90.1','90.1','failed',1,'2026-09-18T03:00:00Z','rate_limited',repeat('5',64),NULL,'2026-09-17T00:00:00Z','2026-09-17T01:00:00Z');`;
  await psql(["-c", seed]);
  await psql(["-f", "migrations/025_garden_projection_consistency.sql"]);
  const rows = JSON.parse(
    (
      await psql([
        "-Atc",
        "SELECT json_agg(row_to_json(x) ORDER BY user_id) FROM (SELECT user_id,desired_revision,published_revision,source_ts,message_ts,payload_digest FROM otl.community_garden_projections WHERE day='2026-09-15')x",
      ])
    ).stdout.trim(),
  );
  assert.deepEqual(rows, [
    {
      user_id: "UA",
      desired_revision: 2,
      published_revision: 2,
      source_ts: "102.1",
      message_ts: "500.2",
      payload_digest: "2".repeat(64),
    },
    {
      user_id: "UB",
      desired_revision: 2,
      published_revision: 1,
      source_ts: "202.1",
      message_ts: "600.1",
      payload_digest: "3".repeat(64),
    },
  ]);
  assert.equal(
    (
      await psql([
        "-Atc",
        "SELECT status FROM otl.community_garden_deliveries WHERE delivery_key='a-r1'",
      ])
    ).stdout.trim(),
    "cancelled",
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        "SELECT status FROM otl.community_garden_deliveries WHERE delivery_key='a-r2'",
      ])
    ).stdout.trim(),
    "sent",
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        "SELECT status FROM otl.community_garden_deliveries WHERE delivery_key='b-r1'",
      ])
    ).stdout.trim(),
    "sent",
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        "SELECT status FROM otl.community_garden_deliveries WHERE delivery_key='b-r2'",
      ])
    ).stdout.trim(),
    "failed",
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        "SELECT status FROM otl.community_garden_deliveries WHERE delivery_key='other-date'",
      ])
    ).stdout.trim(),
    "failed",
  );
  const scope = {
    teamId: "T-UP",
    channelId: "C-UP",
    from: "2026-09-14",
    through: "2026-09-15",
    limit: 10,
    reconciliationKey: "upgrade-rerun",
    dryRun: false,
  };
  const reconciled = await call("reconcile_garden_projections", scope);
  assert.equal(reconciled.insertedRoutes, 0);
  assert.equal(reconciled.deliveriesEnqueued, 0);
  const replay = await call("reconcile_garden_projections", scope);
  assert.equal(replay.replayed, true);
  assert.equal(replay.insertedRoutes, 0);
  console.log(
    "PASS 024-to-025 upgrade chooses deterministic route winners, preserves consistent sent receipts and retry history, supersedes only older route work, rerun0",
  );
} finally {
  if (started)
    await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
