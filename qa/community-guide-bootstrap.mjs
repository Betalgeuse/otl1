import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const temp = await mkdtemp("/tmp/otl1-guide-bootstrap-");
const command = join(temp, "stdin-sink.mjs");
const psqlCommand = join(temp, "psql.mjs");
const sqlFile = join(temp, "bootstrap.sql");
const runtimeFile = join(temp, "runtime.secret");
const adminFile = join(temp, "admin.secret");
await writeFile(
  command,
  `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let value="";
for await (const chunk of process.stdin) value+=chunk;
writeFileSync(process.argv[2],value,{mode:0o600});
`,
);
await chmod(command, 0o700);
await writeFile(
  psqlCommand,
  `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let value="";
for await (const chunk of process.stdin) value+=chunk;
writeFileSync(process.env.CAPTURE_SQL_FILE,value,{mode:0o600});
`,
);
await chmod(psqlCommand, 0o700);
const env = {
  ...process.env,
  DATABASE_URL:
    "postgresql://owner:owner-secret@ep-qa.neon.tech/db?sslmode=require&channel_binding=require",
  SLACK_TEAM_ID: "TQA",
  COMMUNITY_WELCOME_CHANNEL_ID: "CQA",
  COMMUNITY_ADMIN_ID: "UADMIN",
  PSQL_BIN: psqlCommand,
  CAPTURE_SQL_FILE: sqlFile,
  GUIDE_RUNTIME_SECRET_SINK: command,
  GUIDE_RUNTIME_SECRET_SINK_ARGS: JSON.stringify([runtimeFile]),
  GUIDE_ADMIN_SECRET_SINK: command,
  GUIDE_ADMIN_SECRET_SINK_ARGS: JSON.stringify([adminFile]),
};
try {
  env.GUIDE_RUNTIME_SECRET_SINK_ARGS = JSON.stringify([runtimeFile]);
  env.GUIDE_ADMIN_SECRET_SINK_ARGS = JSON.stringify([adminFile]);
  env.PSQL_BIN = psqlCommand;
  const result = await run("bun", ["scripts/bootstrap-guide-db-roles.mjs"], {
    env: {
      ...env,
      GUIDE_RUNTIME_SECRET_SINK_ARGS: JSON.stringify([runtimeFile]),
      GUIDE_ADMIN_SECRET_SINK_ARGS: JSON.stringify([adminFile]),
    },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(result.stdout), { rolesConfigured: 2, secretsDelivered: 2 });
  assert.doesNotMatch(result.stdout + result.stderr, /owner-secret|otl_guide_.*_login|postgresql:/);
  const sql = await readFile(sqlFile, "utf8");
  assert.match(sql, /GRANT otl_guide_runtime TO otl_guide_runtime_login/);
  assert.match(sql, /GRANT otl_guide_admin TO otl_guide_admin_login/);
  const runtimeUrl = new URL((await readFile(runtimeFile, "utf8")).trim());
  const adminUrl = new URL((await readFile(adminFile, "utf8")).trim());
  assert.equal(runtimeUrl.username, "otl_guide_runtime_login");
  assert.equal(adminUrl.username, "otl_guide_admin_login");
  assert.notEqual(runtimeUrl.password, adminUrl.password);
  assert.ok(runtimeUrl.password.length >= 40);
  assert.ok(adminUrl.password.length >= 40);
  assert.equal((await stat(runtimeFile)).mode & 0o777, 0o600);
  assert.equal((await stat(adminFile)).mode & 0o777, 0o600);
  console.log(
    "PASS guide role bootstrap generates distinct credentials and sends them only through protected stdin sinks",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
