import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pg = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.slice(8) ?? "green";
assert.ok(["red", "green"].includes(phase), "phase must be red or green");
const temp = await mkdtemp(join(tmpdir(), "otl-ir-grant-"));
const socket = join(temp, "socket");
const data = join(temp, "data");
const port = String(52000 + Math.floor(Math.random() * 7000));
const owner = "otl_interest_grants_owner";
const upgradeDb = "otl_interest_grants_upgrade";
const freshDb = "otl_interest_grants_fresh";
const clusterEnv = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
let dbEnv = clusterEnv;
const run = (binary, args) => exec(join(pg, binary), args, { cwd: root, env: dbEnv, encoding: "utf8" });
const sql = async (query) => (await run("psql", ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", query])).stdout.trim();
const apply = async (database, migrations) => {
  dbEnv = { ...clusterEnv, PGDATABASE: database, PGUSER: owner };
  for (const migration of migrations) {
    if (migration.startsWith("007_")) continue;
    const args = migration.startsWith("006_")
      ? ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"]
      : ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${migration}`];
    await run("psql", args);
  }
};
const asRuntime = async (database, query) => {
  dbEnv = { ...clusterEnv, PGDATABASE: database, PGUSER: "otl_interest_runtime_login" };
  return sql(query);
};
const retentionInput = "'{\"teamId\":\"TRET\",\"now\":\"2026-09-20T00:00:00Z\"}'::jsonb";
const dueInput = "'{\"teamId\":\"TRET\"}'::jsonb";
async function assertRedAccess(database) {
  await assert.rejects(asRuntime(database, `SELECT otl.interest_retention_execute('expire_due',${retentionInput})`), /permission denied/);
  await assert.rejects(asRuntime(database, `SELECT otl.interest_retention_next_due(${dueInput})`), /permission denied/);
}
async function assertGreenAccess(database) {
  assert.equal(JSON.parse(await asRuntime(database, `SELECT otl.interest_retention_execute('expire_due',${retentionInput})`)).processed, 0);
  assert.equal(JSON.parse(await asRuntime(database, `SELECT otl.interest_retention_next_due(${dueInput})`)).nextDue, null);
}
async function assertExactRole(database) {
  dbEnv = { ...clusterEnv, PGDATABASE: database, PGUSER: owner };
  assert.equal(await sql("SELECT rolcanlogin::text||':'||rolinherit::text||':'||rolsuper::text||':'||rolcreatedb::text||':'||rolcreaterole::text||':'||rolreplication::text||':'||rolbypassrls::text FROM pg_roles WHERE rolname='otl_interest_runtime_login'"), "true:false:false:false:false:false:false");
  assert.equal(await sql("SELECT count(*) FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member WHERE member.rolname='otl_interest_runtime_login'"), "0");
  assert.equal(await sql("SELECT has_schema_privilege('otl_interest_runtime_login','otl','USAGE')"), "t");
  assert.equal(await sql("SELECT coalesce(string_agg(p.proname||'('||oidvectortypes(p.proargtypes)||')',',' ORDER BY p.proname),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl JOIN pg_roles grantee ON grantee.oid=acl.grantee WHERE n.nspname='otl' AND grantee.rolname='otl_interest_runtime_login' AND acl.privilege_type='EXECUTE'"), "interest_retention_execute(text, jsonb),interest_retention_next_due(jsonb),interest_runtime_execute(text, jsonb)");
  assert.equal(await sql("SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='otl_interest_runtime_login' AND table_schema='otl'"), "0");
  for (const fn of ["interest_admin_execute(text,jsonb)", "interest_delivery_execute(text,jsonb)", "interest_member_confirm(jsonb)", "referral_runtime_execute(text,jsonb)", "referral_admin_execute(text,jsonb)", "referral_retention_execute(text,jsonb)"])
    assert.equal(await sql(`SELECT has_function_privilege('otl_interest_runtime_login','otl.${fn}','EXECUTE')`), "f", `${fn} leaked to interest runtime`);
  assert.equal(await sql("SELECT has_table_privilege('otl_interest_runtime_login','otl.interest_requests','SELECT')"), "f");
}

let started = false;
try {
  await mkdir(socket);
  await run("initdb", ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run("pg_ctl", ["-D", data, "-o", `-F -k ${socket} -p ${port}`, "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  await sql(`CREATE ROLE ${owner} LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION`);
  await sql(`CREATE DATABASE ${upgradeDb} OWNER ${owner}`);
  await sql(`CREATE DATABASE ${freshDb} OWNER ${owner}`);
  const migrations = (await readdir(join(root, "migrations"))).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
  const before041 = migrations.filter((name) => !name.startsWith("041_"));
  await apply(upgradeDb, before041);
  dbEnv = { ...clusterEnv, PGDATABASE: upgradeDb, PGUSER: owner };
  await sql("CREATE ROLE otl_interest_runtime_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD NULL");
  await sql("GRANT USAGE ON SCHEMA otl TO otl_interest_runtime_login");
  await sql("GRANT EXECUTE ON FUNCTION otl.interest_runtime_execute(text,jsonb) TO otl_interest_runtime_login");
  await assertRedAccess(upgradeDb);
  if (phase === "red") {
    console.log("PASS interest retention runtime grants red: existing runtime login is denied both retention functions");
  } else {
    assert.ok(migrations.some((name) => name.startsWith("041_")), "migration 041 is required");
    dbEnv = { ...clusterEnv, PGDATABASE: upgradeDb, PGUSER: owner };
    await sql("ALTER ROLE otl_interest_runtime_login CREATEROLE");
    await assert.rejects(apply(upgradeDb, migrations.filter((name) => name.startsWith("041_"))), /unsafe interest retention runtime login role/);
    await sql("ALTER ROLE otl_interest_runtime_login NOCREATEROLE");
    await apply(upgradeDb, migrations.filter((name) => name.startsWith("041_")));
    await assertGreenAccess(upgradeDb);
    await assertExactRole(upgradeDb);
    await apply(freshDb, migrations);
    await assertGreenAccess(freshDb);
    await assertExactRole(freshDb);
    dbEnv = { ...clusterEnv, PGDATABASE: upgradeDb, PGUSER: owner };
    assert.equal(await sql("SELECT version FROM otl.schema_migrations WHERE version='041-interest-retention-runtime-grants'"), "041-interest-retention-runtime-grants");
    dbEnv = { ...clusterEnv, PGDATABASE: freshDb, PGUSER: owner };
    assert.equal(await sql("SELECT version FROM otl.schema_migrations WHERE version='041-interest-retention-runtime-grants'"), "041-interest-retention-runtime-grants");
    console.log("PASS interest retention runtime grants: red denial, upgrade and fresh exact direct-function role grants");
  }
} finally {
  if (started) {
    dbEnv = clusterEnv;
    await run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  }
  await rm(temp, { recursive: true, force: true });
}
