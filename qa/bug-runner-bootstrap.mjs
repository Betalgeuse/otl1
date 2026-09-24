import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const temp = await mkdtemp("/tmp/otl1-runner-bootstrap-");
const sink = join(temp, "stdin-sink.mjs");
const psql = join(temp, "psql.mjs");
const sqlFile = join(temp, "bootstrap.sql");
const secretFile = join(temp, "runner.secret");
await writeFile(
  sink,
  `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let value="";
for await (const chunk of process.stdin) value+=chunk;
writeFileSync(process.argv[2],value,{mode:0o600});
`,
);
await chmod(sink, 0o700);
await writeFile(
  psql,
  `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let value="";
for await (const chunk of process.stdin) value+=chunk;
writeFileSync(process.env.CAPTURE_SQL_FILE,value,{mode:0o600});
`,
);
await chmod(psql, 0o700);
try {
  const result = await run("bun", ["scripts/bootstrap-bug-runner-db-role.mjs"], {
    env: {
      ...process.env,
      DATABASE_URL:
        "postgresql://owner:owner-secret@ep-qa.neon.tech/db?sslmode=require&channel_binding=require",
      PSQL_BIN: psql,
      CAPTURE_SQL_FILE: sqlFile,
      BUG_RUNNER_SECRET_SINK: sink,
      BUG_RUNNER_SECRET_SINK_ARGS: JSON.stringify([secretFile]),
    },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(result.stdout), { rolesConfigured: 1, secretsDelivered: 1 });
  assert.doesNotMatch(result.stdout + result.stderr, /owner-secret|otl_bug_runner_login|postgresql:/);
  const sql = await readFile(sqlFile, "utf8");
  assert.match(sql, /GRANT otl_bug_runner TO otl_bug_runner_login/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM otl_bug_runner_login/);
  const url = new URL((await readFile(secretFile, "utf8")).trim());
  assert.equal(url.username, "otl_bug_runner_login");
  assert.ok(url.password.length >= 40);
  assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
  console.log("PASS bug runner bootstrap sends one least-privilege database URL through stdin");
} finally {
  await rm(temp, { recursive: true, force: true });
}
