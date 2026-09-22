import { existsSync } from "node:fs";

function usage() {
  return "Usage: node scripts/reconcile-garden-projections.mjs --team T... --channel C... --through YYYY-MM-DD [--from YYYY-MM-DD] [--user U...] [--limit 1..100] (--dry-run | --apply KEY)";
}
function parse(argv) {
  const values = { limit: 100 };
  let mode = null;
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--dry-run") {
      mode = "dry";
      continue;
    }
    if (item === "--help") return { help: true };
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${item}`);
    if (item === "--apply") {
      mode = "apply";
      values.reconciliationKey = value;
    } else if (item === "--limit") values.limit = Number(value);
    else if (item === "--team") values.teamId = value;
    else if (item === "--channel") values.channelId = value;
    else if (item === "--through") values.through = value;
    else if (item === "--from") values.from = value;
    else if (item === "--user") values.userId = value;
    else throw new Error(`Unknown option ${item}`);
  }
  if (!values.teamId || !values.channelId || !values.through || !mode) throw new Error(usage());
  if (values.userId && !/^[UW][A-Z0-9]+$/.test(values.userId))
    throw new Error("Invalid user filter");
  if (mode === "apply" && !/^[A-Za-z0-9._:-]{3,100}$/.test(values.reconciliationKey))
    throw new Error("Invalid reconciliation key");
  if (!/^[A-Z0-9-]{2,64}$/.test(values.teamId) || !/^[A-Z0-9-]{2,64}$/.test(values.channelId))
    throw new Error("Invalid scope");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(values.through) ||
    (values.from && !/^\d{4}-\d{2}-\d{2}$/.test(values.from))
  )
    throw new Error("Invalid date");
  if (!Number.isSafeInteger(values.limit) || values.limit < 1 || values.limit > 100)
    throw new Error("Invalid limit");
  if (mode === "dry") values.reconciliationKey = `dry-${values.through}`;
  values.dryRun = mode === "dry";
  return values;
}
const options = parse(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}
if (existsSync(".dev.vars")) process.loadEnvFile(".dev.vars");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const connection = new URL(process.env.DATABASE_URL);
if (
  !["postgres:", "postgresql:"].includes(connection.protocol) ||
  !connection.hostname.endsWith(".neon.tech")
)
  throw new Error("Invalid DATABASE_URL");
const response = await fetch(`https://${connection.hostname}/sql`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Neon-Connection-String": process.env.DATABASE_URL,
    "Neon-Raw-Text-Output": "true",
    "Neon-Array-Mode": "true",
  },
  redirect: "manual",
  signal: AbortSignal.timeout(30000),
  body: JSON.stringify({
    query: "SELECT otl.community_execute($1,$2::jsonb)",
    params: ["reconcile_garden_projections", JSON.stringify(options)],
  }),
});
const body = await response.json();
if (
  !response.ok ||
  !Array.isArray(body.rows) ||
  !Array.isArray(body.rows[0]) ||
  typeof body.rows[0][0] !== "string"
)
  throw new Error("Reconciliation request failed");
const result = JSON.parse(body.rows[0][0]);
if (typeof result !== "object" || result === null || Array.isArray(result))
  throw new Error("Invalid reconciliation result");
if (options.userId && result.fallbackRoutes > 0)
  throw new Error(
    "Refusing user-scoped daily prompt fallback; route the garden to the member message thread.",
  );
console.log(JSON.stringify(result, null, 2));
