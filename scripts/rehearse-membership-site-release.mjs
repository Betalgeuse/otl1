import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  "bug_report_revisions", "bug_artifacts", "community_garden_projections",
  "workspace_channel_memberships",
];
const additiveTables = [
  "referral_capacity_defaults", "referral_capacity_members", "referral_capacity_events",
  "interest_requests", "interest_consents", "interest_attachment_consents",
  "interest_private_payloads", "interest_submission_receipts", "interest_introduction_evidence",
  "interest_referral_bridges", "interest_events", "interest_outbox", "interest_service_nonces",
  "interest_introduction_prompts",
];
const focusedQa = [
  "release-rehearsal-http", "release-rehearsal-leak", "member-lifecycle-pg", "lifecycle-delivery-pg", "lifecycle-admin-security",
  "referral-storage-pg", "referral-retention-pg", "community-runtime-pg",
  "review-thread-topology-pg", "garden-projection-upgrade-pg",
  "membership-reminder-audit-pg", "community-guide-security-pg",
  "membership-invite-security", "site-intake", "site-static", "export-public-structure",
  "referral-capacity-slack", "community-interest-intake", "community-interest-admin",
  "community-interest-local-e2e", "interest-private", "interest-storage-pg",
  "referral-capacity-pg", "real-name-pg", "community-membership-store-error-code", "version-map",
];
const injection = process.argv.find((arg) => arg.startsWith("--inject="))?.slice(9);
const existingPgOnly = process.argv.includes("--existing-pg-only");
const initdbQa = new Set([
  "member-lifecycle-pg", "lifecycle-delivery-pg", "lifecycle-admin-security",
  "referral-storage-pg", "referral-retention-pg", "community-runtime-pg",
  "review-thread-topology-pg", "garden-projection-upgrade-pg",
  "membership-reminder-audit-pg", "community-guide-security-pg", "referral-capacity-pg", "real-name-pg",
]);
const injections = new Set([
  "build-failure", "direct-table-grant", "missing-036", "missing-037", "missing-038", "missing-039", "missing-040", "missing-binding",
  "missing-bootstrap", "missing-interest-admin-credential", "missing-interest-flag",
  "missing-interest-secret", "missing-role", "missing-secret", "pii-leak", "rollback-mismatch",
  "schema-head", "secret-leak", "turnstile-secret-in-vars", "turnstile-secret-leak", "turnstile-test-key",
]);
const rollbackReadbackPath = process.argv.find((arg) => arg.startsWith("--rollback-readback="))?.slice(20);
const receiptPath = resolve(process.argv.find((arg) => arg.startsWith("--receipt="))?.slice(10)
  ?? join(root, ".omo/evidence/task-14-otl1-membership-invite-site.json"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fakeSecret = `FAKE_RELEASE_SECRET_CANARY_${"Z".repeat(32)}`;
const fakePii = "PRIVATE_APPLICANT_CANARY_person@example.invalid";
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileProductionSiteKey = "0x4AAAAAAE83tTpMHyLr4nIv";
const productionHostname = "otl1.hyuk.me";
const sensitiveValues = [fakeSecret, fakePii, ...Object.entries(process.env)
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
const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const ownerRole = `otl_r_${tag}_owner`;
const primaryDb = `otl_r_${tag}_main`;
const rollbackDb = `otl_r_${tag}_rollback`;
const freshDb = `otl_r_${tag}_fresh`;
const serviceEnv = { ...process.env, PGHOST: process.env.OTL_REHEARSAL_PGHOST ?? "127.0.0.1",
  PGPORT: process.env.OTL_REHEARSAL_PGPORT ?? "5432", PGDATABASE: "postgres" };
let created = false;
let pgEnv;

async function run(binary, args, options = {}) {
  return exec(binary, args, { cwd: root, env: process.env, encoding: "utf8",
    timeout: 300_000, maxBuffer: 16 * 1024 * 1024, ...options });
}
async function check(name, binary, args, options) {
  const result = await run(binary, args, options);
  assertNoLeak(result.stdout + result.stderr);
  receipt.checks[name] = { exit: 0, outputSha256: sha256(result.stdout + result.stderr) };
  return result;
}
async function psql(database, args) {
  return run(join(pgBin, "psql"), ["-X", "-d", database, "-v", "ON_ERROR_STOP=1", ...args], { env: pgEnv });
}
async function scalar(database, query) {
  return (await psql(database, ["-Atq", "-c", query])).stdout.trim();
}
async function scalarAs(database, role, query) {
  return (await run(join(pgBin, "psql"), ["-X", "-Atq", "-d", database, "-v", "ON_ERROR_STOP=1", "-c", query],
    { env: { ...pgEnv, PGUSER: role } })).stdout.trim();
}
async function assertSchemaHead(database, expected) {
  const actual = await scalar(database, "SELECT version FROM otl.schema_migrations ORDER BY regexp_replace(version, '-.*$', '')::integer DESC LIMIT 1");
  assert.equal(actual, expected, "schema head mismatch");
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
async function digest(database, tables = protectedTables) {
  const result = {};
  for (const name of tables) {
    assert.equal(await scalar(database, `SELECT to_regclass('otl.${name}') IS NOT NULL`), "t", `${name} table missing`);
    const row = name === "guide_versions" ? "to_jsonb(t)-'source_origin'" : name === "member_introductions" ? "to_jsonb(t)-'confirmed_name'-'name_prefill'-'pending_confirmed_name'" : "to_jsonb(t)";
    const value = await scalar(database, `SELECT count(*)||':'||md5(coalesce(string_agg(md5((${row})::text),',' ORDER BY md5((${row})::text)),'') ) FROM otl.${name} t`);
    result[name] = value;
  }
  return result;
}
async function seedAdditive(database) {
  await psql(database, ["-c", "INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TLIFE','UACTIVE') ON CONFLICT DO NOTHING"]);
  const capacity = { teamId: "TLIFE", adminId: "UACTIVE", maximum: 2, expectedRevision: 0,
    key: "rehearsal_default", now: "2026-09-20T00:00:00Z" };
  const interest = { teamId: "TLIFE", interestId: "IREQ-REHEARSAL1", receiptId: "INT-REHEARSAL1",
    emailDigest: "a".repeat(64), contentDigest: "b".repeat(64), withdrawalDigest: "c".repeat(64),
    consentVersion: "interest-consent-v1", consentedAt: "2026-09-20T00:00:00Z",
    inviteConsentAccepted: true, inviteConsentedAt: "2026-09-20T00:00:00Z",
    shareNameEmailWithIntroducer: false, key: "rehearsal_interest", now: "2026-09-20T00:00:00Z",
    opaqueRef: "interest-private/IREQ-REHEARSAL1/revision-0-12345678-1234-1234-1234-123456789abc.enc",
    objectDigest: "d".repeat(64), envelopeDek: "synthetic.envelope", nonce: "synthetic-nonce",
    keyVersion: "synthetic-kek", schemaVersion: "interest-application.v1" };
  await scalar(database, `SELECT otl.referral_capacity_admin_execute('set_default','${JSON.stringify(capacity)}'::jsonb)`);
  await scalar(database, `SELECT otl.interest_runtime_execute('submit','${JSON.stringify(interest)}'::jsonb)`);
  assert.equal(await scalar(database, "SELECT count(*) FROM otl.interest_requests"), "1");
  assert.equal(await scalar(database, "SELECT count(*) FROM otl.interest_consents"), "1");
  assert.equal(await scalar(database, "SELECT count(*) FROM otl.interest_attachment_consents"), "1");
  assert.equal(await scalar(database, "SELECT count(*) FROM otl.referral_capacity_events"), "1");
  return digest(database, additiveTables);
}
async function expectFailure(name, action) {
  let failed = false;
  try { await action(); } catch { failed = true; }
  assert.equal(failed, true, `${name} must fail closed`);
  receipt.checks[name] = { exit: 0, observed: "rejected" };
}
async function cleanupDatabases() {
  if (!created) return;
  pgEnv = serviceEnv;
  for (const database of [primaryDb, rollbackDb, freshDb])
    await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  for (const role of ["otl_interest_member_login", "otl_interest_member", "otl_referral_admin_login",
    "otl_referral_admin", "otl_referral_runtime", "otl_lifecycle_admin_login", "otl_lifecycle_admin",
    "otl_lifecycle_runtime", "otl_guide_admin", "otl_guide_runtime", "legacy_invitation_runtime", ownerRole])
    await psql("postgres", ["-c", `DROP ROLE IF EXISTS ${role}`]);
  created = false;
  receipt.checks.localCleanup = { exit: 0, observed: "disposable databases and roles removed" };
}
function preflight(config, site, vars, siteWorker, releaseNames = release) {
  assert.equal(migrations.length, 40, "schema head must be 040");
  assert.deepEqual(releaseNames.map((name) => name.slice(0, 3)), ["029", "030", "031", "032", "033", "034", "035", "036", "037", "038", "039", "040"]);
  assert.equal(site.services?.find((item) => item.binding === "CORE")?.service, config.name, "CORE service binding missing");
  assert.equal(site.assets?.binding, "ASSETS", "ASSETS binding missing");
  assert.ok(config.r2_buckets?.some((item) => item.binding === "INVITE_PRIVATE_OBJECTS"), "invite R2 binding missing");
  for (const name of ["SITE_CORE_HMAC_SECRET", "INVITE_EMAIL_PEPPER", "INVITE_PRIVATE_KEK",
    "INVITE_PRIVATE_KEK_VERSION", "LIFECYCLE_ADMIN_DATABASE_URL", "REFERRAL_ADMIN_DATABASE_URL",
    "INTEREST_RUNTIME_DATABASE_URL", "INTEREST_ADMIN_DATABASE_URL", "INTEREST_MEMBER_DATABASE_URL",
    "INTEREST_ADMIN_CHANNEL_ID", "INTEREST_ACTION_SECRET"])
    assert.ok(vars.includes(`${name}=`), `${name} declaration missing`);
  assert.equal(config.vars.LIFECYCLE_MODE, "disabled");
  for (const name of ["REVIEW_THREAD_V2", "GARDEN_RECONCILIATION", "REFERRALS_ENABLED", "PUBLIC_APPLICATIONS_ENABLED", "PUBLIC_INTEREST_ENABLED"])
    assert.equal(config.vars[name], "false", `${name} must default off`);
  assert.equal(site.vars.PUBLIC_INTEREST_ENABLED, "false", "site interest must default off");
  assert.notEqual(site.vars.TURNSTILE_SITE_KEY, turnstileTestSiteKey, `${productionHostname} must not use the Cloudflare Turnstile test sitekey`);
  assert.equal(site.vars.TURNSTILE_SITE_KEY, turnstileProductionSiteKey, `${productionHostname} must use its verified hostname-scoped Turnstile sitekey`);
  assert.equal(site.vars.TURNSTILE_SECRET, undefined, "TURNSTILE_SECRET must be a Worker secret, never a public var");
  assert.match(siteWorker, /if \(!env\.TURNSTILE_SECRET \|\| !token \|\| token\.length > 2048\) return "invalid";/, "TURNSTILE_SECRET must fail closed when absent");
  assert.match(siteWorker, /secret: env\.TURNSTILE_SECRET/, "TURNSTILE_SECRET must be sent only to Siteverify");
  assert.equal(config.vars.PUBLIC_APPLICATION_ORIGIN, `https://${productionHostname}`);
  assert.ok(config.r2_buckets?.some((item) => item.binding === "BUG_PRIVATE_OBJECTS"), "private R2 binding missing");
}

try {
  receipt.sourceSha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  assert.ok(injection === undefined || injections.has(injection), "unknown release injection");
  const config = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
  const site = JSON.parse(await readFile(join(root, "site/wrangler.jsonc"), "utf8"));
  const vars = await readFile(join(root, ".dev.vars.example"), "utf8");
  const siteWorker = await readFile(join(root, "site/src/index.ts"), "utf8");
  const bootstrapPath = join(root, "scripts", injection === "missing-bootstrap" ? "missing-referral-bootstrap.mjs" : "bootstrap-referral-admin-db-role.mjs");
  assert.ok((await readFile(bootstrapPath)).length > 0, "referral admin bootstrap missing");
  if (injection === "secret-leak" || injection === "turnstile-secret-leak" || injection === "pii-leak") {
    const leakedConfig = structuredClone(site);
    leakedConfig.vars.TURNSTILE_SECRET = injection === "pii-leak" ? fakePii : fakeSecret;
    assertNoLeak(JSON.stringify(leakedConfig));
  }
  const alternate = structuredClone(site);
  alternate.services = [];
  const testKeySite = structuredClone(site);
  testKeySite.vars.TURNSTILE_SITE_KEY = turnstileTestSiteKey;
  const secretVarSite = structuredClone(site);
  secretVarSite.vars.TURNSTILE_SECRET = fakeSecret;
  const missingInterestFlag = structuredClone(config);
  delete missingInterestFlag.vars.PUBLIC_INTEREST_ENABLED;
  const missingInterestAdminCredential = vars.replace("INTEREST_ADMIN_DATABASE_URL=", "");
  await expectFailure("missing-binding", async () => preflight(config, alternate, vars, siteWorker));
  await expectFailure("missing-secret", async () => preflight(config, site, vars.replace("INVITE_PRIVATE_KEK=", ""), siteWorker));
  await expectFailure("missing-interest-secret", async () => preflight(config, site, vars.replace("INTEREST_RUNTIME_DATABASE_URL=", ""), siteWorker));
  await expectFailure("missing-interest-flag", async () => preflight(missingInterestFlag, site, vars, siteWorker));
  await expectFailure("missing-interest-admin-credential", async () => preflight(config, site, missingInterestAdminCredential, siteWorker));
  await expectFailure("missing-036", async () => preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("036_"))));
  await expectFailure("missing-037", async () => preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("037_"))));
  await expectFailure("missing-038", async () => preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("038_"))));
  await expectFailure("missing-039", async () => preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("039_"))));
  await expectFailure("missing-040", async () => preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("040_"))));
  await expectFailure("turnstile-test-key", async () => preflight(config, testKeySite, vars, siteWorker));
  await expectFailure("turnstile-secret-in-vars", async () => preflight(config, secretVarSite, vars, siteWorker));
  if (injection === "missing-binding") preflight(config, alternate, vars, siteWorker);
  if (injection === "missing-secret") preflight(config, site, vars.replace("INVITE_PRIVATE_KEK=", ""), siteWorker);
  if (injection === "missing-interest-secret") preflight(config, site, vars.replace("INTEREST_RUNTIME_DATABASE_URL=", ""), siteWorker);
  if (injection === "missing-interest-flag") preflight(missingInterestFlag, site, vars, siteWorker);
  if (injection === "missing-interest-admin-credential") preflight(config, site, missingInterestAdminCredential, siteWorker);
  if (injection === "missing-036") preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("036_")));
  if (injection === "missing-037") preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("037_")));
  if (injection === "missing-038") preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("038_")));
  if (injection === "missing-039") preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("039_")));
  if (injection === "missing-040") preflight(config, site, vars, siteWorker, release.filter((name) => !name.startsWith("040_")));
  if (injection === "turnstile-test-key") preflight(config, testKeySite, vars, siteWorker);
  if (injection === "turnstile-secret-in-vars") preflight(config, secretVarSite, vars, siteWorker);
  preflight(config, site, vars, siteWorker);
  receipt.manifest = {
    migrations: release, coreWorker: config.name, siteWorker: site.name,
    bindings: ["AI", "COMMUNITY_CLOCK", "INTENT_RATE_LIMITER", "BUG_PRIVATE_OBJECTS", "INVITE_PRIVATE_OBJECTS", "CORE", "ASSETS", "RATE_LIMITER"],
    coreSecrets: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "DATABASE_URL", "GUIDE_DATABASE_URL",
      "BOARD_SIGNING_SECRET", "BUG_PRIVATE_KEK", "BUG_PRIVATE_KEK_VERSION", "SITE_CORE_HMAC_SECRET",
      "INVITE_EMAIL_PEPPER", "INVITE_PRIVATE_KEK", "INVITE_PRIVATE_KEK_VERSION",
      "REFERRAL_TOKEN_SECRET", "LIFECYCLE_ACTION_SECRET", "LIFECYCLE_ADMIN_DATABASE_URL",
      "REFERRAL_ADMIN_DATABASE_URL", "INTEREST_RUNTIME_DATABASE_URL", "INTEREST_ADMIN_DATABASE_URL",
      "INTEREST_MEMBER_DATABASE_URL", "INTEREST_ADMIN_CHANNEL_ID", "INTEREST_ACTION_SECRET"],
    siteSecrets: ["TURNSTILE_SECRET", "SITE_CORE_HMAC_SECRET"],
    operatorOnlySecrets: ["GUIDE_ADMIN_DATABASE_URL"],
    slackScopes: ["im:write", "users:read.email"], slackEvents: ["team_join"],
    domain: productionHostname, turnstileProductionSiteKey, turnstileSecret: "required by name before enablement",
    flagsDefaultOff: ["LIFECYCLE_MODE", "REVIEW_THREAD_V2", "GARDEN_RECONCILIATION", "REFERRALS_ENABLED", "PUBLIC_APPLICATIONS_ENABLED", "PUBLIC_INTEREST_ENABLED"],
    previousProductionSha: "unavailable",
    previousWorkerVersions: { core: "unavailable", site: "undeployed or unavailable" },
    rollback: "disable flags; select prior core/site Worker versions; retain schema and forward-repair DB; restore prior garden payload if retired",
    dns: "read-only DNS and custom-domain conflict check required before binding",
  };
  if (!rollbackReadbackPath) throw new Error("read-only rollback version readback missing");
  const rollbackReadback = JSON.parse(await readFile(resolve(rollbackReadbackPath), "utf8"));
  assert.equal(rollbackReadback.scenario, "read-only-current-rollback-version-readback");
  assert.ok(Date.now() - Date.parse(rollbackReadback.checkedAt) < 86_400_000, "rollback readback stale");
  for (const [name, worker, target] of [["core", config.name, "core"], ["site", site.name, "site"]]) {
    const observed = rollbackReadback[name];
    assert.equal(observed.worker, worker, `${name} rollback Worker mismatch`);
    assert.equal(observed.versions.length, 1, `${name} rollback version ambiguous`);
    assert.equal(observed.versions[0].percentage, 100, `${name} rollback version not fully active`);
    assert.match(observed.versions[0].versionId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    receipt.manifest.previousWorkerVersions[target] = observed.versions[0].versionId;
  }
  receipt.manifest.rollbackReadbackAt = rollbackReadback.checkedAt;
  receipt.checks.rollbackVersionReadback = { exit: 0, observed: "one 100-percent version per Worker" };
  temp = await mkdtemp(join(tmpdir(), "otl-release-rehearsal-"));
  pgEnv = serviceEnv;
  assert.equal(await scalar("postgres", "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'otl_%' OR rolname='legacy_invitation_runtime'"), "0", "local service has OTL roles");
  await psql("postgres", ["-c", `CREATE ROLE ${ownerRole} LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION`]);
  created = true;
  for (const database of [primaryDb, rollbackDb, freshDb])
    await psql("postgres", ["-c", `CREATE DATABASE ${database} OWNER ${ownerRole}`]);
  pgEnv = { ...serviceEnv, PGUSER: ownerRole };
  await apply(primaryDb, migrations.filter((name) => Number(name.slice(0, 3)) <= 28));
  assert.equal(await scalar(primaryDb, "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '028-%'"), "1");
  await psql(primaryDb, ["-f", "qa/member-lifecycle-upgrade-fixture.sql"]);
  await psql(primaryDb, ["-f", "qa/release-rehearsal-fixture.sql"]);
  await apply(primaryDb, release.filter((name) => Number(name.slice(0, 3)) <= 35));
  await assertSchemaHead(primaryDb, "035-lifecycle-admin-login");
  const before = await digest(primaryDb);
  await check("snapshot-035", join(pgBin, "pg_dump"), ["-Fc", "--no-owner", "--no-acl", "-f", join(temp, "snapshot.dump"), primaryDb], { env: pgEnv });
  await apply(primaryDb, release.filter((name) => Number(name.slice(0, 3)) >= 36));
  if (injection === "schema-head")
    await psql(primaryDb, ["-c", "DELETE FROM otl.schema_migrations WHERE version='040-real-name-introductions'"]);
  await assertSchemaHead(primaryDb, "040-real-name-introductions");
  assert.equal(await scalar(primaryDb, "SELECT count(*) FROM otl.schema_migrations WHERE version ~ '^0(29|3[0-9]|40)-'"), "12");
  const after = await digest(primaryDb);
  assert.deepEqual(after, before, "protected rows changed during upgrade");
  receipt.checks.upgrade = { exit: 0, fromHead: "035", schemaHead: "040", protected: before };
  if (injection === "missing-role")
    await psql(primaryDb, ["-c", "REVOKE otl_interest_member FROM otl_interest_member_login"]);
  await expectFailure("migration-conflict", () => psql(primaryDb, ["-f", "migrations/037_interest_requests.sql"]));
  await expectFailure("wrong-role", () => scalarAs(primaryDb, "otl_interest_member_login", "SELECT otl.interest_admin_execute('context','{}'::jsonb)"));
  assert.equal(await scalar(primaryDb, "SELECT has_function_privilege('otl_referral_runtime','otl.issue_invite(text,text,text,text,text)','EXECUTE')"), "f");
  receipt.checks["legacy-quota"] = { exit: 0, observed: "execute privilege revoked" };
  assert.equal(await scalar(primaryDb, "SELECT has_table_privilege('otl_interest_member_login','otl.interest_requests','SELECT')"), "f");
  assert.equal(await scalar(primaryDb, "SELECT has_table_privilege('otl_referral_admin_login','otl.referral_capacity_members','UPDATE')"), "f");
  assert.equal(await scalar(primaryDb, "SELECT has_function_privilege('otl_interest_member_login','otl.interest_admin_execute(text,jsonb)','EXECUTE')"), "f");
  assert.equal(await scalar(primaryDb, "SELECT has_function_privilege('otl_referral_runtime','otl.interest_admin_execute(text,jsonb)','EXECUTE')"), "f");
  assert.equal(await scalar(primaryDb, "SELECT has_function_privilege('otl_interest_member_login','otl.interest_member_confirm(jsonb)','EXECUTE')"), "t", "interest member role binding missing");
  assert.equal(await scalar(primaryDb, "SELECT has_function_privilege('otl_referral_admin_login','otl.referral_capacity_admin_execute(text,jsonb)','EXECUTE')"), "t", "referral admin role binding missing");
  assert.equal(await scalar(primaryDb, "SELECT has_function_privilege('otl_referral_runtime','otl.referral_resolve_named(jsonb)','EXECUTE')"), "t", "named referral runtime role binding missing");
  assert.equal(await scalar(primaryDb, "SELECT has_function_privilege('otl_interest_member_login','otl.referral_resolve_named(jsonb)','EXECUTE')"), "f", "named referral lookup leaked to interest member");
  receipt.checks.roleMatrix = { exit: 0, observed: "direct interest/quota table grants and admin execute denied" };
  assert.equal(await scalarAs(primaryDb, "otl_interest_member_login", "SELECT current_user"), "otl_interest_member_login");
  assert.equal(await scalarAs(primaryDb, "otl_referral_admin_login", "SELECT current_user"), "otl_referral_admin_login");
  await psql(primaryDb, ["-c", "INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TLIFE','UACTIVE')"]);
  assert.equal(JSON.parse(await scalarAs(primaryDb, "otl_referral_admin_login",
    "SELECT otl.referral_capacity_admin_execute('status_default','{\"teamId\":\"TLIFE\",\"adminId\":\"UACTIVE\"}'::jsonb)")).maximum, 2);
  receipt.checks.quotaDefault = { exit: 0, maximum: 2 };
  await expectFailure("direct-table-access", () => scalarAs(primaryDb, "otl_interest_member_login", "SELECT count(*) FROM otl.interest_requests"));
  await expectFailure("forged-admin", () => scalarAs(primaryDb, "otl_referral_admin_login",
    "SELECT otl.referral_capacity_admin_execute('status_default','{\"teamId\":\"TLIFE\",\"adminId\":\"UFAKE\"}'::jsonb)"));
  if (injection === "direct-table-grant") {
    await psql(primaryDb, ["-c", "GRANT SELECT ON otl.interest_requests TO otl_interest_member_login"]);
    assert.equal(await scalar(primaryDb, "SELECT has_table_privilege('otl_interest_member_login','otl.interest_requests','SELECT')"), "f", "direct interest table grant detected");
  }
  const additiveBefore = await seedAdditive(primaryDb);
  receipt.checks.additiveRows = { exit: 0, tables: additiveBefore };
  await check("restore-035", join(pgBin, "pg_restore"), ["--no-owner", "--no-acl", "--exit-on-error", "-d", rollbackDb, join(temp, "snapshot.dump")], { env: pgEnv });
  assert.equal(await scalar(rollbackDb, "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '035-%'"), "1");
  if (injection === "rollback-mismatch") await psql(rollbackDb, ["-c", "UPDATE otl.community_days SET reflection='changed' WHERE user_id='UACTIVE'"]);
  assert.deepEqual(await digest(rollbackDb), before, "rollback clone mismatch");
  await psql(rollbackDb, ["-c", "CREATE TABLE otl.referral_capacity_defaults(team_id text)"]);
  await expectFailure("partial-transaction", () => psql(rollbackDb, ["-f", "migrations/036_referral_capacity.sql"]));
  assert.equal(await scalar(rollbackDb, "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '036-%'"), "0");
  await psql(rollbackDb, ["-c", "DROP TABLE otl.referral_capacity_defaults"]);
  await apply(rollbackDb, release.filter((name) => Number(name.slice(0, 3)) >= 36));
  await assertSchemaHead(rollbackDb, "040-real-name-introductions");
  assert.deepEqual(await digest(rollbackDb), before, "forward repair changed protected rows");
  assert.deepEqual(await seedAdditive(rollbackDb), additiveBefore, "forward repair changed additive row contract");
  receipt.checks.rollbackForwardRepair = { exit: 0, restoredHead: "035", repairedHead: "040" };
  await apply(freshDb, migrations);
  await assertSchemaHead(freshDb, "040-real-name-introductions");
  assert.equal(await scalar(freshDb, "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '037-%'"), "1");
  assert.equal(await scalar(freshDb, "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '038-%'"), "1");
  assert.equal(await scalar(freshDb, "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '039-%'"), "1");
  assert.equal(await scalar(freshDb, "SELECT count(*) FROM otl.schema_migrations WHERE version LIKE '040-%'"), "1");
  receipt.checks.freshInstall = { exit: 0, schemaHead: "040" };
  await cleanupDatabases();
  await check("full-check", "bun", ["run", "check"]);
  if (injection === "build-failure") await check("site-build", "bunx", ["wrangler", "deploy", "--dry-run", "-c", "missing-site-config.jsonc"]);
  await check("site-build", "bunx", ["wrangler", "deploy", "--dry-run", "-c", "site/wrangler.jsonc"]);
  for (const name of focusedQa) {
    if (existingPgOnly && initdbQa.has(name)) continue;
    await check(`qa/${name}`, "bun", [`qa/${name}.mjs`]);
  }
  receipt.checks.qaScope = { existingPgOnly, omittedInitdbQa: existingPgOnly ? [...initdbQa] : [] };
  const exportDir = join(temp, "public");
  await check("public-export", "node", ["scripts/export-public.mjs", exportDir]);
  for (const name of ["migrations/036_referral_capacity.sql", "migrations/037_interest_requests.sql",
    "migrations/038_interest_retention_due.sql", "migrations/039_bot_owned_welcome_guide.sql", "migrations/040_real_name_introductions.sql", "qa/real-name-pg.mjs", "qa/real-name-storage.sql", "scripts/bootstrap-referral-admin-db-role.mjs", "site/dist/interest.html", "site/dist/receipt.html",
    "site/dist/assets/otl1-emoji/blob_smiley.png"])
    assert.ok((await readFile(join(exportDir, name))).length > 0, `${name} missing from public export`);
  receipt.checks.publicRequiredFiles = { exit: 0, observed: "036–040,real-name QA,bootstrap,interest,receipt,emoji present" };
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
  try { await cleanupDatabases(); }
  catch {
    receipt.status = "failed";
    receipt.failure = "local PostgreSQL cleanup failed";
    process.exitCode = 1;
  }
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
