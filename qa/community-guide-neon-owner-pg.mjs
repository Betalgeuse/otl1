import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-guide-neon-owner-");
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(62000 + Math.floor(Math.random() * 1000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
let started = false;
const run = (bin, args) => exec(bin, args, { cwd: root, env, encoding: "utf8" });
const psql = (database, user, args) =>
  run(join(pgBin, "psql"), ["-X", "-d", database, "-U", user, "-v", "ON_ERROR_STOP=1", ...args]);

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
  await psql("postgres", process.env.USER, [
    "-Atc",
    "CREATE ROLE guide_owner LOGIN CREATEROLE CREATEDB NOSUPERUSER",
  ]);
  await psql("postgres", process.env.USER, [
    "-Atc",
    "CREATE DATABASE guide_owner_db OWNER guide_owner",
  ]);
  const ownerFlags = (
    await psql("guide_owner_db", "guide_owner", [
      "-Atc",
      "SELECT rolsuper::text||':'||rolcreaterole::text FROM pg_roles WHERE rolname=current_user",
    ])
  ).stdout.trim();
  assert.equal(ownerFlags, "false:true");

  const migrations = readdirSync("migrations")
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .sort();
  for (const file of migrations.filter((name) => Number(name.slice(0, 3)) <= 5))
    await psql("guide_owner_db", "guide_owner", ["-f", `migrations/${file}`]);
  await psql("guide_owner_db", "guide_owner", [
    "--single-transaction",
    "-f",
    "migrations/006_normalized_foundation.sql",
    "-f",
    "migrations/007_normalized_legacy.sql",
  ]);
  for (const file of migrations.filter((name) => Number(name.slice(0, 3)) >= 8))
    await psql("guide_owner_db", "guide_owner", ["-f", `migrations/${file}`]);

  const roles = (
    await psql("guide_owner_db", "guide_owner", [
      "-Atc",
      "SELECT string_agg(rolname||':'||rolsuper::text||':'||rolcanlogin::text,',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('otl_guide_admin','otl_guide_runtime')",
    ])
  ).stdout.trim();
  assert.equal(roles, "otl_guide_admin:false:false,otl_guide_runtime:false:false");
  const matrix = (
    await psql("guide_owner_db", "guide_owner", [
      "-Atc",
      `SELECT concat_ws(':',
        has_function_privilege('public','otl.guide_runtime_execute(text,jsonb)','EXECUTE'),
        has_function_privilege('public','otl.guide_admin_execute(text,jsonb)','EXECUTE'),
        has_function_privilege('otl_guide_runtime','otl.guide_runtime_execute(text,jsonb)','EXECUTE'),
        has_function_privilege('otl_guide_runtime','otl.guide_admin_execute(text,jsonb)','EXECUTE'),
        has_function_privilege('otl_guide_admin','otl.guide_runtime_execute(text,jsonb)','EXECUTE'),
        has_function_privilege('otl_guide_admin','otl.guide_admin_execute(text,jsonb)','EXECUTE'))`,
    ])
  ).stdout.trim();
  assert.equal(matrix, "f:f:t:f:f:t");
  console.log(
    "PASS migration 028 applies as a non-superuser CREATEROLE database owner and preserves exact guide capabilities",
  );
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
