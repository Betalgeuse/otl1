import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const required = [
  "DATABASE_URL",
  "SLACK_TEAM_ID",
  "COMMUNITY_WELCOME_CHANNEL_ID",
  "COMMUNITY_ADMIN_ID",
  "GUIDE_RUNTIME_SECRET_SINK",
  "GUIDE_RUNTIME_SECRET_SINK_ARGS",
  "GUIDE_ADMIN_SECRET_SINK",
  "GUIDE_ADMIN_SECRET_SINK_ARGS",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

function sinkArgs(name) {
  try {
    const value = JSON.parse(process.env[name]);
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string" && item.length > 0)
    )
      throw new TypeError("invalid sink arguments");
    return value;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new Error(`Invalid ${name}`);
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

function deliverSecret(commandName, argsName, value) {
  const result = spawnSync(process.env[commandName], sinkArgs(argsName), {
    input: `${value}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`Secret delivery failed for ${commandName}`);
}

const teamId = process.env.SLACK_TEAM_ID;
const channelId = process.env.COMMUNITY_WELCOME_CHANNEL_ID;
const adminId = process.env.COMMUNITY_ADMIN_ID;
if (
  !/^T[A-Z0-9]+$/.test(teamId) ||
  !/^C[A-Z0-9]+$/.test(channelId) ||
  !/^[UW][A-Z0-9]+$/.test(adminId)
)
  throw new Error("Invalid guide bootstrap identity");

let ownerUrl;
try {
  ownerUrl = new URL(process.env.DATABASE_URL);
} catch (error) {
  if (error instanceof TypeError) throw new Error("Invalid owner database URL");
  throw error;
}
if (
  !["postgres:", "postgresql:"].includes(ownerUrl.protocol) ||
  !ownerUrl.username ||
  !ownerUrl.password
)
  throw new Error("Invalid owner database URL");

const runtimeLogin = "otl_guide_runtime_login";
const adminLogin = "otl_guide_admin_login";
const runtimePassword = randomBytes(32).toString("base64url");
const adminPassword = randomBytes(32).toString("base64url");
const sql = `BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${runtimeLogin}') THEN
  CREATE ROLE ${runtimeLogin} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${adminLogin}') THEN
  CREATE ROLE ${adminLogin} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
 END IF;
END $$;
ALTER ROLE ${runtimeLogin} NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE ${adminLogin} NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
ALTER ROLE ${runtimeLogin} PASSWORD ${sqlLiteral(runtimePassword)};
ALTER ROLE ${adminLogin} PASSWORD ${sqlLiteral(adminPassword)};
DO $$ DECLARE membership record; BEGIN
 FOR membership IN
  SELECT parent.rolname AS parent_name,member.rolname AS member_name
  FROM pg_auth_members am JOIN pg_roles parent ON parent.oid=am.roleid
  JOIN pg_roles member ON member.oid=am.member
  WHERE member.rolname IN ('${runtimeLogin}','${adminLogin}')
  AND NOT ((member.rolname='${runtimeLogin}' AND parent.rolname='otl_guide_runtime')
   OR (member.rolname='${adminLogin}' AND parent.rolname='otl_guide_admin'))
 LOOP
  EXECUTE format('REVOKE %I FROM %I',membership.parent_name,membership.member_name);
 END LOOP;
END $$;
REVOKE ALL ON SCHEMA otl FROM ${runtimeLogin},${adminLogin};
REVOKE ALL ON ALL TABLES IN SCHEMA otl FROM ${runtimeLogin},${adminLogin};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA otl FROM ${runtimeLogin},${adminLogin};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA otl FROM ${runtimeLogin},${adminLogin};
GRANT otl_guide_runtime TO ${runtimeLogin};
GRANT otl_guide_admin TO ${adminLogin};
INSERT INTO otl.workspaces(team_id) VALUES(${sqlLiteral(teamId)}) ON CONFLICT DO NOTHING;
INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES(${sqlLiteral(teamId)},${sqlLiteral(channelId)}) ON CONFLICT DO NOTHING;
INSERT INTO otl.workspace_members(team_id,user_id) VALUES(${sqlLiteral(teamId)},${sqlLiteral(adminId)}) ON CONFLICT DO NOTHING;
INSERT INTO otl.guide_publishers(team_id,channel_id,user_id)
 VALUES(${sqlLiteral(teamId)},${sqlLiteral(channelId)},${sqlLiteral(adminId)}) ON CONFLICT DO NOTHING;
COMMIT;`;
const psql = spawnSync(process.env.PSQL_BIN ?? "psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
  input: sql,
  encoding: "utf8",
  env: databaseEnvironment(ownerUrl),
  stdio: ["pipe", "pipe", "pipe"],
});
if (psql.status !== 0) throw new Error("Guide database role bootstrap failed; details withheld");

const runtimeUrl = new URL(ownerUrl);
runtimeUrl.username = runtimeLogin;
runtimeUrl.password = runtimePassword;
const adminUrl = new URL(ownerUrl);
adminUrl.username = adminLogin;
adminUrl.password = adminPassword;
deliverSecret("GUIDE_RUNTIME_SECRET_SINK", "GUIDE_RUNTIME_SECRET_SINK_ARGS", runtimeUrl.toString());
deliverSecret("GUIDE_ADMIN_SECRET_SINK", "GUIDE_ADMIN_SECRET_SINK_ARGS", adminUrl.toString());
console.log(JSON.stringify({ rolesConfigured: 2, secretsDelivered: 2 }));
