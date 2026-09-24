import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const required = [
  "DATABASE_URL",
  "BUG_RUNNER_SECRET_SINK",
  "BUG_RUNNER_SECRET_SINK_ARGS",
];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);

function sinkArgs() {
  try {
    const value = JSON.parse(process.env.BUG_RUNNER_SECRET_SINK_ARGS);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0))
      throw new TypeError("invalid sink arguments");
    return value;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new Error("Invalid BUG_RUNNER_SECRET_SINK_ARGS");
    throw error;
  }
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseEnvironment(url) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
    PGCHANNELBINDING: url.searchParams.get("channel_binding") ?? "require",
    PGCONNECT_TIMEOUT: "10",
  };
}

let ownerUrl;
try {
  ownerUrl = new URL(process.env.DATABASE_URL);
} catch (error) {
  if (error instanceof TypeError) throw new Error("Invalid owner database URL");
  throw error;
}
if (!["postgres:", "postgresql:"].includes(ownerUrl.protocol) || !ownerUrl.username || !ownerUrl.password)
  throw new Error("Invalid owner database URL");

const login = "otl_bug_runner_login";
const password = randomBytes(32).toString("base64url");
const sql = `BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${login}') THEN
  CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
 END IF;
END $$;
ALTER ROLE ${login} NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE ${login} PASSWORD ${sqlLiteral(password)};
DO $$ DECLARE membership record; BEGIN
 FOR membership IN
  SELECT parent.rolname AS parent_name,member.rolname AS member_name
  FROM pg_auth_members am JOIN pg_roles parent ON parent.oid=am.roleid
  JOIN pg_roles member ON member.oid=am.member
  WHERE member.rolname='${login}' AND parent.rolname<>'otl_bug_runner'
 LOOP EXECUTE format('REVOKE %I FROM %I',membership.parent_name,membership.member_name); END LOOP;
END $$;
REVOKE ALL ON SCHEMA otl FROM ${login};
REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM ${login};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM ${login};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA otl FROM ${login};
GRANT otl_bug_runner TO ${login};
COMMIT;`;
const psql = spawnSync(process.env.PSQL_BIN ?? "psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
  input: sql,
  encoding: "utf8",
  env: databaseEnvironment(ownerUrl),
  stdio: ["pipe", "pipe", "pipe"],
});
if (psql.status !== 0) throw new Error("Bug runner database role bootstrap failed; details withheld");

const runnerUrl = new URL(ownerUrl);
runnerUrl.username = login;
runnerUrl.password = password;
const sink = spawnSync(process.env.BUG_RUNNER_SECRET_SINK, sinkArgs(), {
  input: `${runnerUrl.toString()}\n`,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
});
if (sink.status !== 0) throw new Error("Bug runner secret delivery failed");
console.log(JSON.stringify({ rolesConfigured: 1, secretsDelivered: 1 }));
