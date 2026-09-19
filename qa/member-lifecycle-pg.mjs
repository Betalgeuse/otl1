import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CommunityLifecycleStore } from "../src/community-lifecycle-store.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-member-lifecycle-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(57000 + Math.floor(Math.random() * 8000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const migrations = (await readdir(join(root, "migrations")))
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .sort();
let started = false;

const run = (binary, args, options = {}) =>
  exec(binary, args, { cwd: root, env, encoding: "utf8", ...options });
const psql = async (database, args) =>
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

  await applyThrough("postgres", 28);
  if (process.env.LIFECYCLE_RED === "1") {
    await scalar("postgres", "SELECT otl.lifecycle_execute('get','{}'::jsonb)");
  }

  await psql("postgres", ["-f", "qa/member-lifecycle-upgrade-fixture.sql"]);
  await psql("postgres", ["-f", "migrations/029_member_lifecycle.sql"]);
  const contract = await psql("postgres", ["-Atq", "-f", "qa/member-lifecycle-contract.sql"]);
  const edgeMatch = contract.stdout.match(/EDGE_COUNT=(\d+)/);
  const joinOnlyMatch = contract.stdout.match(/JOIN_ONLY_ELIGIBLE=(\w+)/);
  assert.ok(edgeMatch);
  assert.equal(Number(edgeMatch[1]), 30);
  assert.equal(joinOnlyMatch?.[1], "false");

  const lifecycleStore = new CommunityLifecycleStore({
    queryJson: async (_query, params) => {
      const operation = params[0]?.replaceAll("'", "''");
      const payload = params[1]?.replaceAll("'", "''");
      assert.ok(operation);
      assert.ok(payload);
      return JSON.parse(
        await scalar(
          "postgres",
          `SELECT otl.lifecycle_execute('${operation}','${payload}'::jsonb)`,
        ),
      );
    },
  });
  const storedMember = await lifecycleStore.member({
    teamId: "TLIFE",
    channelId: "CLIFE",
    userId: "UACTIVE",
  });
  assert.deepEqual(
    { state: storedMember.state, revision: storedMember.revision, seasonId: storedMember.seasonId },
    { state: "active", revision: 4, seasonId: 7 },
  );
  const replayedDay = await lifecycleStore.closeServiceDay({
    teamId: "TLIFE",
    channelId: "CLIFE",
    date: "2026-10-01",
    now: "2026-10-18T01:00:02Z",
  });
  assert.deepEqual(replayedDay, {
    date: "2026-10-01",
    eligible: true,
    reason: null,
    changed: false,
  });

  await psql("postgres", ["-c", "CREATE DATABASE otl_lifecycle_fresh"]);
  await applyThrough("otl_lifecycle_fresh", 29);
  assert.equal(
    await scalar(
      "otl_lifecycle_fresh",
      "SELECT count(*) FROM otl.schema_migrations WHERE version='029-member-lifecycle'",
    ),
    "1",
  );

  const concurrentPayload = (key, now) =>
    JSON.stringify({
      teamId: "TLIFE",
      channelId: "CLIFE",
      userId: "UCONCURRENT",
      now,
      expectedRevision: 1,
      key,
    }).replaceAll("'", "''");
  const concurrent = await Promise.allSettled([
    scalar(
      "postgres",
      `SELECT otl.lifecycle_execute('extend','${concurrentPayload("extend-a", "2026-10-08T12:00:01Z")}'::jsonb)`,
    ),
    scalar(
      "postgres",
      `SELECT otl.lifecycle_execute('extend','${concurrentPayload("extend-b", "2026-10-08T12:00:02Z")}'::jsonb)`,
    ),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    await scalar(
      "postgres",
      "SELECT revision||':'||extension_used FROM otl.member_lifecycles WHERE team_id='TLIFE' AND user_id='UCONCURRENT'",
    ),
    "2:true",
  );

  console.log(
    `PASS lifecycle storage: ${edgeMatch[1]} state-backed checks; JOIN_ONLY_ELIGIBLE=${joinOnlyMatch?.[1]}; fresh+upgrade 001-029; KST closure/weekends/evidence; rollout; active/grace/extension/dormant/return; stale/duplicate/concurrent/cross-scope denial; immutable audit; rollback=0`,
  );
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
