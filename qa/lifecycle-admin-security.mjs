import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otla-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(40000 + Math.floor(Math.random() * 20000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const run = (binary, args) => exec(binary, args, { cwd: root, env, encoding: "utf8" });
const sql = async (statement) => (await run(join(pgBin, "psql"), ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement])).stdout.trim();
let started = false;
try {
  await mkdir(socket);
  await run(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pgBin, "pg_ctl"), ["-D", data, "-o", `-F -k ${socket} -p ${port}`, "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  const migrations = (await readdir(join(root, "migrations"))).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
  for (const name of migrations) {
    if (name.startsWith("006_")) await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", `migrations/${name}`, "-f", "migrations/007_normalized_legacy.sql"]);
    else if (!name.startsWith("007_")) await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${name}`]);
  }
  assert.equal(await sql("SELECT rolcanlogin::text FROM pg_roles WHERE rolname='otl_lifecycle_admin_login'"), "true");
  const accessible = await sql("SELECT string_agg(p.proname,',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='otl' AND has_function_privilege('otl_lifecycle_admin_login',p.oid,'EXECUTE')");
  assert.equal(accessible, "lifecycle_admin_candidate,lifecycle_admin_execute");
  const matrix = await sql(`SELECT concat_ws(':',
    has_function_privilege('otl_lifecycle_admin_login','otl.lifecycle_admin_execute(text,jsonb)','EXECUTE'),
    has_function_privilege('otl_lifecycle_admin_login','otl.lifecycle_runtime_execute(text,jsonb)','EXECUTE'),
    has_function_privilege('otl_lifecycle_admin_login','otl.referral_runtime_execute(text,jsonb)','EXECUTE'),
    has_function_privilege('otl_lifecycle_admin_login','otl.guide_admin_execute(text,jsonb)','EXECUTE'),
    has_table_privilege('otl_lifecycle_admin_login','otl.member_lifecycles','UPDATE'),
    has_table_privilege('otl_lifecycle_admin_login','otl.lifecycle_runtime_evaluations','SELECT'))`);
  assert.equal(matrix, "t:f:f:f:f:f");
  assert.equal(await sql("SET ROLE otl_lifecycle_admin_login; SELECT otl.lifecycle_admin_candidate('{\"teamId\":\"TVOID\",\"channelId\":\"CVOID\",\"userId\":\"UVOID\"}'::jsonb) IS NULL"), "t");
  await sql(`INSERT INTO otl.workspaces(team_id) VALUES('TSEC'),('TOTHER');
    INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('TSEC','CSEC'),('TOTHER','COTHER');
    INSERT INTO otl.workspace_members(team_id,user_id) VALUES('TSEC','UOWNER'),('TSEC','UOTHER'),('TOTHER','UOWNER');
    INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,revision)
      VALUES('TSEC','CSEC','UOWNER','dormant',2),('TSEC','CSEC','UOTHER','dormant',2),('TOTHER','COTHER','UOWNER','dormant',2);
    INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason,closed_at,closed_on,closed_reason)
      VALUES('TSEC','CSEC','UOWNER','2026-09-01','2026-09-01','rollout','2026-09-18','2026-09-18','grace_expired'),
      ('TSEC','CSEC','UOTHER','2026-09-01','2026-09-01','rollout','2026-09-18','2026-09-18','grace_expired'),
      ('TOTHER','COTHER','UOWNER','2026-09-01','2026-09-01','rollout','2026-09-18','2026-09-18','grace_expired');
    INSERT INTO otl.lifecycle_runtime_evaluations(team_id,channel_id,user_id,service_date,mode,eligible,signal_kind,candidate,explanation,evaluated_at)
      VALUES('TSEC','CSEC','UOWNER','2026-09-18','enforce',true,NULL,true,'{"code":"seven_inactive_service_days"}','2026-09-18');`);
  const read = JSON.parse(await sql("SET ROLE otl_lifecycle_admin_login; SELECT otl.lifecycle_admin_candidate('{\"teamId\":\"TSEC\",\"channelId\":\"CSEC\",\"userId\":\"UOWNER\"}'::jsonb)"));
  assert.equal(read.revision, 2);
  assert.equal(read.evaluations[0].explanation.code, "seven_inactive_service_days");
  assert.equal(await sql("SET ROLE otl_lifecycle_admin_login; SELECT otl.lifecycle_admin_candidate('{\"teamId\":\"TSEC\",\"channelId\":\"COTHER\",\"userId\":\"UOWNER\"}'::jsonb) IS NULL"), "t");
  const payload = (teamId, channelId, userId, revision, key) => JSON.stringify({ teamId, channelId, userId, expectedRevision: revision, key, evidenceKey: "EVIDENCE-1234", now: "2026-09-19T00:00:00Z" });
  const correct = (value) => sql(`SET ROLE otl_lifecycle_admin_login; SELECT otl.lifecycle_admin_execute('restore_error','${value}'::jsonb)`);
  await assert.rejects(() => correct(payload("TSEC", "CSEC", "UOWNER", 1, "stale")));
  await assert.rejects(() => correct(payload("TSEC", "COTHER", "UOWNER", 2, "cross-channel")));
  assert.equal(await sql("SELECT count(*) FROM otl.lifecycle_runtime_actions"), "0");
  const restored = JSON.parse(await correct(payload("TSEC", "CSEC", "UOWNER", 2, "admin:Ev1")));
  assert.equal(restored.state, "active");
  assert.equal(await sql("SELECT actor_class||':'||action_type||':'||evidence_key FROM otl.lifecycle_runtime_actions WHERE team_id='TSEC' AND user_id='UOWNER'"), "admin:lifecycle_restore_error:EVIDENCE-1234");
  assert.equal(await sql("SELECT state||':'||revision FROM otl.member_lifecycles WHERE team_id='TSEC' AND user_id='UOTHER'"), "dormant:2");
  assert.equal(await sql("SELECT state||':'||revision FROM otl.member_lifecycles WHERE team_id='TOTHER' AND user_id='UOWNER'"), "dormant:2");
  assert.equal(JSON.parse(await correct(payload("TSEC", "CSEC", "UOWNER", 2, "admin:Ev1"))).state, "active");
  assert.equal(await sql("SELECT count(*) FROM otl.lifecycle_runtime_actions"), "1");
  const sink = join(temp, "admin-url");
  const bootstrap = await exec("bun", ["scripts/bootstrap-lifecycle-admin-db-role.mjs"], {
    cwd: root,
    env: {
      ...env,
      DATABASE_URL: `postgresql://${process.env.USER}:placeholder@localhost:${port}/postgres?sslmode=disable&channel_binding=disable`,
      LIFECYCLE_ADMIN_SECRET_SINK: "tee",
      LIFECYCLE_ADMIN_SECRET_SINK_ARGS: JSON.stringify([sink]),
      PSQL_BIN: join(pgBin, "psql"),
    },
  });
  assert.deepEqual(JSON.parse(bootstrap.stdout), { rolesConfigured: 1, secretsDelivered: 1 });
  const delivered = new URL((await readFile(sink, "utf8")).trim());
  assert.equal(delivered.username, "otl_lifecycle_admin_login");
  assert.ok(delivered.password.length >= 40);
  const login = await exec(join(pgBin, "psql"), ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", "SELECT current_user"], {
    cwd: root,
    env: { ...env, PGUSER: delivered.username, PGPASSWORD: delivered.password },
  });
  assert.equal(login.stdout.trim(), "otl_lifecycle_admin_login");
  console.log(JSON.stringify({ scenario: "lifecycle_admin_pg", status: "pass", executableFunctions: 2, forbiddenCapabilities: 5, candidateRead: true, correctionAuditEvents: 1, otherMembersUnchanged: 2, credentialDelivered: true }));
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
