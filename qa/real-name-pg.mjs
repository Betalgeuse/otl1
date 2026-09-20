import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pg = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-real-name-"));
const socket = join(temp, "socket");
const data = join(temp, "data");
const env = { ...process.env, PGHOST: socket, PGPORT: String(51000 + Math.floor(Math.random() * 9000)), PGDATABASE: "postgres" };
const run = (binary, args) => exec(join(pg, binary), args, { cwd: root, env });
let started = false;
try {
  await mkdir(socket);
  await run("initdb", ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run("pg_ctl", ["-D", data, "-o", `-F -k ${socket} -p ${env.PGPORT}`, "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  const migrations = (await readdir(join(root, "migrations"))).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
  for (const migration of migrations) {
    if (migration.startsWith("007_")) continue;
    if (migration.startsWith("006_"))
      await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"]);
    else if (migration.startsWith("040_")) {
      await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "qa/referral-storage-fixture.sql"]);
      await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "INSERT INTO otl.member_introductions(team_id,user_id,intro,channel_id,message_ts,revision) VALUES ('TREF','UREFERRER','Existing introduction','CREF','1.000001',1)"]);
      await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${migration}`]);
    } else await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${migration}`]);
  }
  const version = await run("psql", ["-X", "-Atq", "-c", "SELECT version FROM otl.schema_migrations WHERE version='040-real-name-introductions'"]);
  assert.equal(version.stdout.trim(), "040-real-name-introductions");
  const existing = await run("psql", ["-X", "-Atq", "-c", "SELECT coalesce(confirmed_name,'<null>') FROM otl.member_introductions WHERE team_id='TREF' AND user_id='UREFERRER'"]);
  assert.equal(existing.stdout.trim(), "<null>", "upgrade must not infer a legal name from Slack display name");
  await run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "qa/real-name-storage.sql"]);
  console.log("PASS real-name PostgreSQL: upgrade preservation, prepare/abort/finish, active/unknown/paused referral, scoped runtime role");
} finally {
  if (started) await run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
