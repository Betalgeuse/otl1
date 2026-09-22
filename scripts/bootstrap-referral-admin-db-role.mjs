import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

for (const name of ["DATABASE_URL", "REFERRAL_ADMIN_SECRET_SINK", "REFERRAL_ADMIN_SECRET_SINK_ARGS"])
  if (!process.env[name]) throw new Error(`Missing ${name}`);

let sinkArgs;
try {
  sinkArgs = JSON.parse(process.env.REFERRAL_ADMIN_SECRET_SINK_ARGS);
  if (!Array.isArray(sinkArgs) || !sinkArgs.every((item) => typeof item === "string" && item.length > 0))
    throw new TypeError("invalid sink arguments");
} catch (error) {
  if (error instanceof SyntaxError || error instanceof TypeError) throw new Error("Invalid referral admin sink arguments");
  throw error;
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

const password = randomBytes(32).toString("base64url");
const escaped = password.replaceAll("'", "''");
const sql = `BEGIN;
ALTER ROLE otl_referral_admin_login PASSWORD '${escaped}';
COMMIT;`;
const dbEnv = {
  ...process.env,
  PGHOST: ownerUrl.hostname,
  PGPORT: ownerUrl.port || "5432",
  PGDATABASE: ownerUrl.pathname.slice(1),
  PGUSER: decodeURIComponent(ownerUrl.username),
  PGPASSWORD: decodeURIComponent(ownerUrl.password),
  PGSSLMODE: ownerUrl.searchParams.get("sslmode") ?? "require",
  PGCHANNELBINDING: ownerUrl.searchParams.get("channel_binding") ?? "require",
  PGCONNECT_TIMEOUT: "10",
};
const applied = spawnSync(process.env.PSQL_BIN ?? "psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
  input: sql, encoding: "utf8", env: dbEnv, stdio: ["pipe", "pipe", "pipe"],
});
if (applied.status !== 0) throw new Error("Referral admin database role bootstrap failed; details withheld");

const adminUrl = new URL(ownerUrl);
adminUrl.username = "otl_referral_admin_login";
adminUrl.password = password;
const delivered = spawnSync(process.env.REFERRAL_ADMIN_SECRET_SINK, sinkArgs, {
  input: `${adminUrl.toString()}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
});
if (delivered.status !== 0) throw new Error("Referral admin secret delivery failed; details withheld");
console.log(JSON.stringify({ rolesConfigured: 1, secretsDelivered: 1 }));
