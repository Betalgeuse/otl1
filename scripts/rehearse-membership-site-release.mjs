import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const migrations = (await readdir(join(root, "migrations")))
  .filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
const release = migrations.filter((name) => Number(name.slice(0, 3)) >= 29);
const protectedTables = [
  "profiles", "goals", "community_days", "community_events", "community_preferences",
  "member_introductions", "guide_versions", "guide_deliveries", "bug_reports",
  "bug_report_revisions", "bug_artifacts", "bug_private_objects",
  "workspace_channel_memberships", "community_reminder_audit",
];
const focusedQa = [
  "release-rehearsal-http", "release-rehearsal-leak", "member-lifecycle-pg", "lifecycle-delivery-pg", "lifecycle-admin-security",
  "referral-storage-pg", "referral-retention-pg", "community-runtime-pg",
  "review-thread-topology-pg", "garden-projection-upgrade-pg",
  "membership-reminder-audit-pg", "community-guide-security-pg",
  "membership-invite-security", "site-intake", "site-static", "export-public-structure",
];
const injection = process.argv.find((arg) => arg.startsWith("--inject="))?.slice(9);
const receiptPath = resolve(process.argv.find((arg) => arg.startsWith("--receipt="))?.slice(10)
  ?? join(root, ".omo/evidence/task-14-otl1-membership-invite-site.json"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fakeSecret = `FAKE_RELEASE_SECRET_CANARY_${"Z".repeat(32)}`;
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileProductionSiteKey = "0x4AAAAAAE83tTpMHyLr4nIv";
const productionHostname = "otl1.hyuk.me";
const sensitiveValues = [fakeSecret, ...Object.entries(process.env)
  .filter(([name, value]) => /(?:SECRET|TOKEN|KEY|KEK|PEPPER|DATABASE_URL)/.test(name) && value?.length >= 12)
  .map(([, value]) => value)];
const credentialPattern = /xox[baprs]-[A-Za-z0-9-]{20,}|postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@[^/\s]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
function assertNoLeak(content, checkPatterns = true) {
  if (sensitiveValues.some((value) => content.includes(value)) ||
    (checkPatterns && credentialPattern.test(content)))
    throw new Error("release artifact secret leak detected");
}
async function scanPublicExport(directory) {
  let scanned = 0;
  async function walk(path, relative = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) { await walk(absolute, name); continue; }
      if (!entry.isFile()) continue;
      const contents = await readFile(absolute);
      if (sensitiveValues.some((value) => contents.includes(Buffer.from(value))))
        throw new Error("release artifact secret leak detected");
      if (contents.includes(0)) continue;
      assertNoLeak(contents.toString("utf8"), !name.startsWith("qa/"));
      scanned++;
    }
  }
  await walk(directory);
  return scanned;
}
const receipt = { scenario: "todo14-local-release-rehearsal", sourceSha: "", status: "failed", checks: {}, manifest: {} };
let temp;
let started = false;
let pgEnv;

async function run(binary, args, options = {}) {
  return exec(binary, args, { cwd: root, env: pgEnv ?? process.env, encoding: "utf8",
    timeout: 300_000, maxBuffer: 16 * 1024 * 1024, ...options });
}
async function check(name, binary, args, options) {
  const result = await run(binary, args, options);
  assertNoLeak(result.stdout + result.stderr);
  receipt.checks[name] = { exit: 0, outputSha256: sha256(result.stdout + result.stderr) };
  return result;
}
async function psql(database, args) {
  return run(join(pgBin, "psql"), ["-X", "-d", database, "-v", "ON_ERROR_STOP=1", ...args]);
}
async function scalar(database, query) {
  return (await psql(database, ["-Atq", "-c", query])).stdout.trim();
}
async function apply(database, names) {
  for (const name of names) {
    if (name.startsWith("007_")) continue;
    const args = name.startsWith("006_")
      ? ["--single-transaction", "-f", `migrations/${name}`, "-f", "migrations/007_normalized_legacy.sql"]
      : ["-f", `migrations/${name}`];
    await psql(database, args);
  }
}
async function digest(database) {
  const result = {};
  for (const name of protectedTables) {
    if (await scalar(database, `SELECT to_regclass('otl.${name}') IS NULL`) === "t") continue;
    const value = await scalar(database, `SELECT count(*)||':'||md5(coalesce(string_agg(md5(to_jsonb(t)::text),',' ORDER BY md5(to_jsonb(t)::text)),'') ) FROM otl.${name} t`);
    result[name] = value;
  }
  return result;
}
async function expectFailure(name, action) {
  let failed = false;
  try { await action(); } catch { failed = true; }
  assert.equal(failed, true, `${name} must fail closed`);
  receipt.checks[name] = { exit: 0, observed: "rejected" };
}
function preflight(config, site, vars, siteWorker) {
  assert.equal(migrations.length, 35, "schema head must be 035");
  assert.deepEqual(release.map((name) => name.slice(0, 3)), ["029", "030", "031", "032", "033", "034", "035"]);
  assert.equal(site.services?.find((item) => item.binding === "CORE")?.service, config.name, "CORE service binding missing");
  assert.equal(site.assets?.binding, "ASSETS", "ASSETS binding missing");
  assert.ok(config.r2_buckets?.some((item) => item.binding === "INVITE_PRIVATE_OBJECTS"), "invite R2 binding missing");
  for (const name of ["SITE_CORE_HMAC_SECRET", "INVITE_EMAIL_PEPPER", "INVITE_PRIVATE_KEK",
    "INVITE_PRIVATE_KEK_VERSION", "LIFECYCLE_ADMIN_DATABASE_URL"])
    assert.ok(vars.includes(`${name}=`), `${name} declaration missing`);
  assert.equal(config.vars.LIFECYCLE_MODE, "disabled");
  for (const name of ["REVIEW_THREAD_V2", "GARDEN_RECONCILIATION", "REFERRALS_ENABLED", "PUBLIC_APPLICATIONS_ENABLED"])
    assert.equal(config.vars[name], "false", `${name} must default off`);
  assert.notEqual(site.vars.TURNSTILE_SITE_KEY, turnstileTestSiteKey, `${productionHostname} must not use the Cloudflare Turnstile test sitekey`);
  assert.equal(site.vars.TURNSTILE_SITE_KEY, turnstileProductionSiteKey, `${productionHostname} must use its verified hostname-scoped Turnstile sitekey`);
  assert.equal(site.vars.TURNSTILE_SECRET, undefined, "TURNSTILE_SECRET must be a Worker secret, never a public var");
  assert.match(siteWorker, /if \(!env\.TURNSTILE_SECRET \|\| !token \|\| token\.length > 2048\) return "invalid";/, "TURNSTILE_SECRET must fail closed when absent");
  assert.match(siteWorker, /secret: env\.TURNSTILE_SECRET/, "TURNSTILE_SECRET must be sent only to Siteverify");
  assert.equal(config.vars.PUBLIC_APPLICATION_ORIGIN, `https://${productionHostname}`);
}

try {
  receipt.sourceSha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const config = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  const site = JSON.parse(await readFile(join(root, "site/wrangler.jsonc"), "utf8"));
  const vars = await readFile(join(root, ".dev.vars.example"), "utf8");
  const siteWorker = await readFile(join(root, "site/src/index.ts"), "utf8");
  if (injection === "secret-leak" || injection === "turnstile-secret-leak") {
    const leakedConfig = structuredClone(site);
    leakedConfig.vars.TURNSTILE_SECRET = fakeSecret;
    assertNoLeak(JSON.stringify(leakedConfig));
  }
  const alternate = structuredClone(site);
  alternate.services = [];
  const testKeySite = structuredClone(site);
  testKeySite.vars.TURNSTILE_SITE_KEY = turnstileTestSiteKey;
  const secretVarSite = structuredClone(site);
  secretVarSite.vars.TURNSTILE_SECRET = fakeSecret;
  await expectFailure("missing-binding", async () => preflight(config, alternate, vars, siteWorker));
  await expectFailure("missing-secret", async () => preflight(config, site, vars.replace("INVITE_PRIVATE_KEK=", ""), siteWorker));
  await expectFailure("turnstile-test-key", async () => preflight(config, testKeySite, vars, siteWorker));
  await expectFailure("turnstile-secret-in-vars", async () => preflight(config, secretVarSite, vars, siteWorker));
  if (injection === "missing-binding") preflight(config, alternate, vars, siteWorker);
  if (injection === "missing-secret") preflight(config, site, vars.replace("INVITE_PRIVATE_KEK=", ""), siteWorker);
  if (injection === "turnstile-test-key") preflight(config, testKeySite, vars, siteWorker);
  if (injection === "turnstile-secret-in-vars") preflight(config, secretVarSite, vars, siteWorker);
  if (injection === "schema-head") throw new Error("injected schema head mismatch");
  preflight(config, site, vars, siteWorker);
  receipt.manifest = {
    migrations: release, coreWorker: config.name, siteWorker: site.name,
    bindings: ["AI", "COMMUNITY_CLOCK", "INTENT_RATE_LIMITER", "BUG_PRIVATE_OBJECTS", "INVITE_PRIVATE_OBJECTS", "CORE", "ASSETS", "RATE_LIMITER"],
    coreSecrets: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "DATABASE_URL", "GUIDE_DATABASE_URL",
      "BOARD_SIGNING_SECRET", "BUG_PRIVATE_KEK", "BUG_PRIVATE_KEK_VERSION", "SITE_CORE_HMAC_SECRET",
      "INVITE_EMAIL_PEPPER", "INVITE_PRIVATE_KEK", "INVITE_PRIVATE_KEK_VERSION",
      "REFERRAL_TOKEN_SECRET", "LIFECYCLE_ACTION_SECRET", "LIFECYCLE_ADMIN_DATABASE_URL"],
    siteSecrets: ["TURNSTILE_SECRET", "SITE_CORE_HMAC_SECRET"],
    operatorOnlySecrets: ["GUIDE_ADMIN_DATABASE_URL"],
    slackScopes: ["im:write", "users:read.email"], slackEvents: ["team_join"],
    domain: productionHostname, turnstileProductionSiteKey, turnstileSecret: "required by name before enablement",
    flagsDefaultOff: ["LIFECYCLE_MODE", "REVIEW_THREAD_V2", "GARDEN_RECONCILIATION", "REFERRALS_ENABLED", "PUBLIC_APPLICATIONS_ENABLED"],
    previousProductionSha: "unavailable",
    previousWorkerVersions: { core: "unavailable", site: "undeployed or unavailable" },
    rollback: "disable flags; select prior core/site Worker versions; retain schema and forward-repair DB; restore prior garden payload if retired",
    dns: "read-only DNS and custom-domain conflict check required before binding",
  };
  const coreDeployments = JSON.parse((await run(join(root, "node_modules/.bin/wrangler"),
    ["deployments", "list", "--name", config.name, "--json"])).stdout);
  const active = coreDeployments.at(-1);
  assert.equal(active?.versions?.length, 1, "core rollback target is ambiguous");
  assert.equal(active.versions[0].percentage, 100, "core rollback target is not at 100 percent");
  const priorSha = active.annotations?.["workers/message"]?.match(/[0-9a-f]{40}/)?.[0];
  assert.ok(priorSha, "core production SHA annotation missing");
  receipt.manifest.previousProductionSha = priorSha;
  receipt.manifest.previousWorkerVersions.core = active.versions[0].version_id;
  try {
    const siteDeployments = JSON.parse((await run(join(root, "node_modules/.bin/wrangler"),
      ["deployments", "list", "--name", site.name, "--json"])).stdout);
    receipt.manifest.previousWorkerVersions.site = siteDeployments.at(-1)?.versions?.[0]?.version_id ?? "undeployed";
  } catch { receipt.manifest.previousWorkerVersions.site = "undeployed or unavailable"; }
  temp = await mkdtemp(join(tmpdir(), "otl-release-rehearsal-"));
  await mkdir(join(temp, "socket"));
  pgEnv = { ...process.env, PGHOST: join(temp, "socket"), PGPORT: String(40000 + Math.floor(Math.random() * 20000)), PGDATABASE: "postgres" };
  await check("pg-init", join(pgBin, "initdb"), ["-D", join(temp, "data"), "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await check("pg-start", join(pgBin, "pg_ctl"), ["-D", join(temp, "data"), "-o", `-F -k ${pgEnv.PGHOST} -p ${pgEnv.PGPORT}`,
    "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  await apply("postgres", migrations.filter((name) => Number(name.slice(0, 3)) <= 28));
  assert.equal(await scalar("postgres", "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '028-%'"), "1");
  await psql("postgres", ["-f", "qa/member-lifecycle-upgrade-fixture.sql"]);
  await psql("postgres", ["-f", "qa/release-rehearsal-fixture.sql"]);
  const before = await digest("postgres");
  await check("snapshot-028", join(pgBin, "pg_dump"), ["-Fc", "-f", join(temp, "snapshot.dump"), "postgres"]);
  await apply("postgres", release);
  assert.equal(await scalar("postgres", "SELECT count(*) FROM otl.schema_migrations WHERE version ~ '^0(29|3[0-5])-'"), "7");
  const after = await digest("postgres");
  assert.deepEqual(after, before, "protected rows changed during upgrade");
  receipt.checks.upgrade = { exit: 0, schemaHead: "035", protected: before };
  await expectFailure("migration-conflict", () => psql("postgres", ["-f", "migrations/035_lifecycle_admin_login.sql"]));
  await expectFailure("wrong-role", () => scalar("postgres", "SET ROLE otl_referral_runtime; SELECT otl.lifecycle_admin_candidate('{}'::jsonb)"));
  assert.equal(await scalar("postgres", "SELECT has_function_privilege('otl_referral_runtime','otl.issue_invite(text,text,text,text,text)','EXECUTE')"), "f");
  receipt.checks["legacy-quota"] = { exit: 0, observed: "execute privilege revoked" };
  await psql("postgres", ["-c", "CREATE DATABASE rollback_clone"]);
  await check("restore-028", join(pgBin, "pg_restore"), ["--no-owner", "--no-acl", "--exit-on-error", "-d", "rollback_clone", join(temp, "snapshot.dump")]);
  assert.equal(await scalar("rollback_clone", "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '028-%'"), "1");
  if (injection === "rollback-mismatch") await psql("rollback_clone", ["-c", "UPDATE otl.community_days SET reflection='changed' WHERE user_id='UACTIVE'"]);
  assert.deepEqual(await digest("rollback_clone"), before, "rollback clone mismatch");
  await psql("rollback_clone", ["-c", "ALTER TABLE otl.workspace_channels ADD COLUMN complete_membership_observed_at timestamptz"]);
  await expectFailure("partial-transaction", () => psql("rollback_clone", ["-f", "migrations/029_member_lifecycle.sql"]));
  assert.equal(await scalar("rollback_clone", "SELECT to_regclass('otl.member_lifecycles') IS NULL"), "t");
  await psql("rollback_clone", ["-c", "ALTER TABLE otl.workspace_channels DROP COLUMN complete_membership_observed_at"]);
  await apply("rollback_clone", release);
  assert.deepEqual(await digest("rollback_clone"), before, "forward repair changed protected rows");
  receipt.checks.rollbackForwardRepair = { exit: 0, restoredHead: "028", repairedHead: "035" };
  await psql("postgres", ["-c", "CREATE DATABASE fresh_clone"]);
  await apply("fresh_clone", migrations);
  assert.equal(await scalar("fresh_clone", "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '035-%'"), "1");
  receipt.checks.freshInstall = { exit: 0, schemaHead: "035" };
  await check("full-check", "bun", ["run", "check"]);
  if (injection === "build-failure") await check("site-build", join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "-c", "missing-site-config.jsonc"]);
  await check("site-build", join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "-c", "site/wrangler.jsonc"]);
  for (const name of focusedQa) await check(`qa/${name}`, "bun", [`qa/${name}.mjs`]);
  const exportDir = join(temp, "public");
  await check("public-export", "node", ["scripts/export-public.mjs", exportDir]);
  receipt.checks.publicLeakScan = { exit: 0, scannedFiles: await scanPublicExport(exportDir) };
  await check("public-check", "bun", ["run", "check"], { cwd: exportDir });
  await check("public-site-build", join(exportDir, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "-c", "site/wrangler.jsonc"], { cwd: exportDir });
  receipt.checks.publicBuiltLeakScan = { exit: 0, scannedFiles: await scanPublicExport(exportDir) };
  await check("git-diff-check", "git", ["diff", "--check"]);
  const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
  assert.equal(dirty, "", "release source worktree is dirty");
  receipt.checks.cleanWorktree = { exit: 0, observed: "clean" };
  receipt.status = "passed";
} catch (error) {
  receipt.failure = error instanceof Error ? error.message.split("\n")[0].replace(/(?:postgres(?:ql)?:\/\/|file:\/\/)[^\s]+/g, "[redacted]") : "unknown";
  process.exitCode = 1;
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", join(temp, "data"), "-m", "immediate", "-w", "stop"]).catch(() => {});
  if (temp) await rm(temp, { recursive: true, force: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  let receiptText = JSON.stringify(receipt, null, 2) + "\n";
  try { assertNoLeak(receiptText); }
  catch {
    receipt.status = "failed";
    receipt.failure = "release receipt secret leak detected";
    receipt.checks = {};
    process.exitCode = 1;
    receiptText = JSON.stringify(receipt, null, 2) + "\n";
  }
  await writeFile(receiptPath, receiptText);
  console.log(`${receipt.status.toUpperCase()} release rehearsal: ${receiptPath}`);
}
