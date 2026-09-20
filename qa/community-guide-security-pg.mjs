import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-guide-security-pg-");
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(61000 + Math.floor(Math.random() * 1000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
let started = false;
const run = (bin, args) => exec(bin, args, { cwd: root, env, encoding: "utf8" });
const psql = (args) => run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
const psqlAs = (user, args) =>
  run(join(pgBin, "psql"), ["-X", "-U", user, "-v", "ON_ERROR_STOP=1", ...args]);
const payload = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const sqlPayload = (value) => `convert_from(decode('${payload(value)}','base64'),'UTF8')::jsonb`;

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
  const migrations = readdirSync("migrations")
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .sort();
  for (const file of migrations.filter((name) => Number(name.slice(0, 3)) <= 5))
    await psql(["-f", `migrations/${file}`]);
  await psql([
    "--single-transaction",
    "-f",
    "migrations/006_normalized_foundation.sql",
    "-f",
    "migrations/007_normalized_legacy.sql",
  ]);
  for (const file of migrations.filter((name) => Number(name.slice(0, 3)) >= 8 && Number(name.slice(0, 3)) < 39))
    await psql(["-f", `migrations/${file}`]);

  const body = 'v0.0.55 안내\n"ONE THING" \\ @channel';
  const release = {
    teamId: "TQA",
    channelId: "CQA",
    version: "v0.0.55",
    body,
    orderedFileIds: ["FLOGO1", "FDAILY2"],
    authorId: "UADMIN",
    sourceTs: "100.100",
    editedTs: "100.200",
  };
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: 1, body, orderedFileIds: release.orderedFileIds }))
    .digest("hex");
  const published = { ...release, hash };
  await psql([
    "-Atc",
    "INSERT INTO otl.workspaces(team_id) VALUES('TQA'); INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('TQA','CQA'); INSERT INTO otl.workspace_members(team_id,user_id) VALUES('TQA','UADMIN'); INSERT INTO otl.guide_publishers(team_id,channel_id,user_id) VALUES('TQA','CQA','UADMIN')",
  ]);
  await psql(["-Atc", `SELECT otl.guide_admin_execute('publish',${sqlPayload(published)})`]);
  await psql(["-f", "migrations/039_bot_owned_welcome_guide.sql"]);
  const repoBody = "v0.0.56 repo guide";
  const repoHash = createHash("sha256").update(JSON.stringify({ version: 1, body: repoBody, orderedFileIds: release.orderedFileIds })).digest("hex");
  const repoRelease = { ...release, version: "v0.0.56", body: repoBody, hash: repoHash, origin: "repo" };
  delete repoRelease.sourceTs; delete repoRelease.editedTs;
  await psql(["-Atc", `SELECT otl.guide_admin_execute('publish',${sqlPayload(repoRelease)})`]);
  await psql([
    "-Atc",
    "CREATE ROLE guide_runtime_login LOGIN INHERIT; CREATE ROLE guide_admin_login LOGIN INHERIT; GRANT otl_guide_runtime TO guide_runtime_login; GRANT otl_guide_admin TO guide_admin_login",
  ]);

  const publicExecute = (
    await psql([
      "-Atc",
      `SELECT has_function_privilege('public','otl.guide_execute(text,jsonb)','EXECUTE')`,
    ])
  ).stdout.trim();
  assert.equal(publicExecute, "f");
  assert.equal(
    (
      await psql([
        "-Atc",
        `SELECT has_function_privilege('public','otl.guide_runtime_execute(text,jsonb)','EXECUTE')`,
      ])
    ).stdout.trim(),
    "f",
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        `SELECT has_function_privilege('public','otl.guide_admin_execute(text,jsonb)','EXECUTE')`,
      ])
    ).stdout.trim(),
    "f",
  );

  const runtimeLatest = await psql([
    "-Atc",
    `SET ROLE otl_guide_runtime; SELECT otl.guide_runtime_execute('latest',${sqlPayload({ teamId: "TQA", channelId: "CQA" })})`,
  ]);
  assert.match(runtimeLatest.stdout, /v0\.0\.56/);
  assert.match(
    (
      await psqlAs("guide_runtime_login", [
        "-Atc",
        `SELECT otl.guide_runtime_execute('latest',${sqlPayload({ teamId: "TQA", channelId: "CQA" })})`,
      ])
    ).stdout,
    /v0\.0\.56/,
  );
  assert.match(
    (
      await psqlAs("guide_admin_login", [
        "-Atc",
        `SELECT otl.guide_admin_execute('repair_latest',${sqlPayload({ teamId: "TQA", channelId: "CQA" })})`,
      ])
    ).stdout,
    /v0\.0\.56/,
  );
  await assert.rejects(
    psql([
      "-Atc",
      `SET ROLE otl_guide_runtime; SELECT otl.guide_admin_execute('publish',${sqlPayload(published)})`,
    ]),
    /permission denied/,
  );
  await assert.rejects(
    psql(["-Atc", "SET ROLE otl_guide_runtime; UPDATE otl.guide_versions SET body='tampered'"]),
    /permission denied/,
  );
  await assert.rejects(
    psql([
      "-Atc",
      `SET ROLE otl_guide_admin; SELECT otl.guide_runtime_execute('claim',${sqlPayload({ teamId: "TQA", channelId: "CQA", userId: "UNEW", version: "v0.0.56", hash: repoHash })})`,
    ]),
    /permission denied/,
  );
  await assert.rejects(
    psql(["-Atc", "SET ROLE otl_guide_admin; SELECT count(*) FROM otl.community_days"]),
    /permission denied/,
  );
  await assert.rejects(
    psql([
      "-Atc",
      `SELECT otl.guide_admin_execute('publish',${sqlPayload({ ...repoRelease, hash: "f".repeat(64) })})`,
    ]),
    /Guide canonical hash mismatch/,
  );
  await assert.rejects(
    psql([
      "-Atc",
      `SELECT otl.guide_admin_execute('publish',${sqlPayload({ ...repoRelease, version: "v0.0.57", body: "<!channel> injected", hash: "f".repeat(64) })})`,
    ]),
    /Invalid published guide/,
  );
  console.log(
    "PASS guide DB roles deny PUBLIC/direct-table/cross-role authority and recompute canonical publication hashes",
  );
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
