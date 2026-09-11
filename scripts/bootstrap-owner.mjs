import cp from "node:child_process";
process.loadEnvFile(".dev.vars");
const workspace = process.env.SLACK_TEAM_ID;
const owner = process.env.COMMUNITY_OWNER_ID;
if (!/^T[A-Z0-9]+$/.test(workspace ?? "") || !/^[UW][A-Z0-9]+$/.test(owner ?? "")) {
  console.error("Set SLACK_TEAM_ID and COMMUNITY_OWNER_ID before initial owner registration.");
  process.exit(1);
}
try {
  const api = new URL("https://slack.com/api/users.info");
  api.searchParams.set("user", owner);
  const response = await fetch(api, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
  const payload = await response.json();
  const user = payload.user;
  if (!response.ok || payload.ok !== true || user?.id !== owner || user?.team_id !== workspace || user?.is_bot !== false || user?.deleted !== false || !(user?.is_admin || user?.is_owner)) {
    console.error("Could not verify the initial owner as an active workspace administrator. Check users:read permission and member ID.");
    process.exit(1);
  }
  const url = new URL(process.env.DATABASE_URL);
  const input = `BEGIN;
DO $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bootstrap:${workspace}',0));
  IF EXISTS (SELECT 1 FROM otl.memberships WHERE workspace_id='${workspace}')
    AND NOT EXISTS (SELECT 1 FROM otl.memberships WHERE workspace_id='${workspace}' AND user_id='${owner}' AND invited_by IS NULL) THEN
    RAISE EXCEPTION 'Workspace is already bootstrapped';
  END IF;
  INSERT INTO otl.memberships(workspace_id,user_id) VALUES('${workspace}','${owner}') ON CONFLICT DO NOTHING;
END $$;
COMMIT;`;
  const result = cp.spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    input, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: "require", PGCHANNELBINDING: "require", PGCONNECT_TIMEOUT: "10" },
  });
  if (result.status !== 0) { console.error("Owner registration failed; no permission change committed."); process.exit(1); }
  console.log("Initial owner registration complete.");
} catch {
  console.error("Owner registration failed; credential details withheld.");
  process.exitCode = 1;
}
