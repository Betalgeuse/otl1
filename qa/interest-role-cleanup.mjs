import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pg = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-interest-role-cleanup-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(55_000 + Math.floor(Math.random() * 9_000));
const env = {
  ...process.env,
  PGHOST: socket,
  PGPORT: port,
  PGDATABASE: "postgres",
  OTL_REHEARSAL_PGHOST: socket,
  OTL_REHEARSAL_PGPORT: port,
};
const run = (binary, args) => exec(binary, args, { cwd: root, env, encoding: "utf8" });
const roles = async () => (
  await run(join(pg, "psql"), [
    "-X", "-Atq", "-d", "postgres", "-c",
    "SELECT coalesce(string_agg(rolname,',' ORDER BY rolname),'') FROM pg_roles WHERE rolname LIKE 'otl_%' OR rolname='legacy_invitation_runtime'",
  ])
).stdout.trim();
let started = false;

try {
  await mkdir(socket);
  await run(join(pg, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pg, "pg_ctl"), [
    "-D", data,
    "-o", `-F -k ${socket} -p ${port} -c listen_addresses=''`,
    "-l", join(temp, "postgres.log"), "-w", "start",
  ]);
  started = true;
  for (const suite of ["qa/community-interest-local-e2e.mjs", "qa/interest-storage-pg.mjs"]) {
    await run(process.execPath, [suite]);
    assert.equal(await roles(), "", `${suite} must remove every temporary OTL role`);
  }
  console.log("PASS interest role cleanup: E2E and storage fixtures leave their PostgreSQL service role-free");
} finally {
  if (started) await run(join(pg, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
