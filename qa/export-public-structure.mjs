import assert from "node:assert/strict";
import {
  assertSanitizedCoreConfig,
  sanitizePackageMetadata,
  sanitizeSiteQaCoreConfig,
  sanitizeSiteWranglerConfig,
  sanitizeWranglerConfig,
} from "../scripts/export-public-config.mjs";
import {
  assertPublicExportPaths,
  assertRequiredPublicExportSources,
  PUBLIC_COPY_PATHS,
  PUBLIC_DOC_NAMES,
  PUBLIC_MEMBERSHIP_SOURCE_PATHS,
  PUBLIC_QA_NAMES,
  PUBLIC_REQUIRED_EXPORT_SOURCES,
  PUBLIC_RUNTIME_MIGRATION_PATHS,
} from "../scripts/export-public-manifest.mjs";

assert.equal(new Set(PUBLIC_COPY_PATHS).size, PUBLIC_COPY_PATHS.length);
assert.equal(new Set(PUBLIC_QA_NAMES).size, PUBLIC_QA_NAMES.length);
assert.equal(new Set(PUBLIC_DOC_NAMES).size, PUBLIC_DOC_NAMES.length);
assert.equal(new Set(PUBLIC_MEMBERSHIP_SOURCE_PATHS).size, PUBLIC_MEMBERSHIP_SOURCE_PATHS.length);
assert.equal(PUBLIC_COPY_PATHS.includes("migrations/028_welcome_guide_roles.sql"), true);
assert.equal(PUBLIC_COPY_PATHS.includes("site"), true);
assert.equal(PUBLIC_COPY_PATHS.includes("migrations/029_member_lifecycle.sql"), true);
assert.equal(PUBLIC_COPY_PATHS.includes("migrations/033_dormant_return.sql"), true);
assert.deepEqual(PUBLIC_RUNTIME_MIGRATION_PATHS, [
  "migrations/034_referral_runtime_retention.sql",
  "migrations/035_lifecycle_admin_login.sql",
  "migrations/036_referral_capacity.sql",
  "migrations/037_interest_requests.sql",
  "migrations/038_interest_retention_due.sql",
  "migrations/039_bot_owned_welcome_guide.sql",
  "migrations/040_real_name_introductions.sql",
  "migrations/041_interest_retention_runtime_grants.sql",
]);
assert.equal(PUBLIC_COPY_PATHS.includes("scripts/bootstrap-lifecycle-admin-db-role.mjs"), true);
assert.equal(PUBLIC_COPY_PATHS.includes("scripts/bootstrap-referral-admin-db-role.mjs"), true);
assert.equal(PUBLIC_MEMBERSHIP_SOURCE_PATHS.includes("site/dist/interest.html"), true);
assert.equal(PUBLIC_MEMBERSHIP_SOURCE_PATHS.includes("site/dist/assets/otl1-avatar.jpg"), true);
assert.equal(PUBLIC_MEMBERSHIP_SOURCE_PATHS.includes("site/dist/assets/one-thing-korean-black.jpg"), true);
assert.equal(PUBLIC_MEMBERSHIP_SOURCE_PATHS.includes("site/qa/interest-check.mjs"), true);
assert.equal(PUBLIC_MEMBERSHIP_SOURCE_PATHS.includes("src/community-interest-intake.ts"), true);
assert.equal(PUBLIC_QA_NAMES.includes("referral-capacity-pg.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("referral-empty-queue-null.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("interest-storage-pg.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("interest-dead-alert.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("real-name-pg.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("interest-retention-runtime-grants-pg.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("community-membership-store-error-code.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("welcome-invite-button.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("community-guide-export.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("real-name-storage.sql"), true);
assert.throws(
  () =>
    assertRequiredPublicExportSources(
      PUBLIC_REQUIRED_EXPORT_SOURCES,
      (path) => path !== "qa/interest-dead-alert.mjs",
    ),
  /Missing required public export source: qa\/interest-dead-alert\.mjs/,
);
assert.doesNotThrow(() => assertRequiredPublicExportSources(PUBLIC_REQUIRED_EXPORT_SOURCES, () => true));
assert.throws(
  () => assertRequiredPublicExportSources(PUBLIC_REQUIRED_EXPORT_SOURCES, (path) => path !== "migrations/036_referral_capacity.sql"),
  /Missing required public export source: migrations\/036_referral_capacity\.sql/,
);
assert.throws(
  () => assertRequiredPublicExportSources(PUBLIC_REQUIRED_EXPORT_SOURCES, (path) => path !== "migrations/038_interest_retention_due.sql"),
  /Missing required public export source: migrations\/038_interest_retention_due\.sql/,
);
assert.throws(
  () =>
    assertRequiredPublicExportSources(
      PUBLIC_REQUIRED_EXPORT_SOURCES,
      (path) => path !== "site/dist/interest.html",
    ),
  /Missing required public export source: site\/dist\/interest\.html/,
);
assert.throws(
  () =>
    assertRequiredPublicExportSources(
      PUBLIC_REQUIRED_EXPORT_SOURCES,
      (path) => path !== "site/dist/assets/otl1-avatar.jpg",
    ),
  /Missing required public export source: site\/dist\/assets\/otl1-avatar\.jpg/,
);
assert.throws(
  () =>
    assertRequiredPublicExportSources(
      PUBLIC_REQUIRED_EXPORT_SOURCES,
      (path) => path !== "site/dist/assets/one-thing-korean-black.jpg",
    ),
  /Missing required public export source: site\/dist\/assets\/one-thing-korean-black\.jpg/,
);
assert.throws(
  () =>
    assertRequiredPublicExportSources(
      PUBLIC_REQUIRED_EXPORT_SOURCES,
      (path) => path !== "scripts/bootstrap-referral-admin-db-role.mjs",
    ),
  /Missing required public export source: scripts\/bootstrap-referral-admin-db-role\.mjs/,
);
assert.equal(PUBLIC_QA_NAMES.includes("community-guide-security-pg.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("version-map.mjs"), true);
assert.throws(() => assertRequiredPublicExportSources(PUBLIC_REQUIRED_EXPORT_SOURCES, (path) => path !== "migrations/040_real_name_introductions.sql"), /Missing required public export source: migrations\/040_real_name_introductions\.sql/);
assert.throws(() => assertRequiredPublicExportSources(PUBLIC_REQUIRED_EXPORT_SOURCES, (path) => path !== "migrations/041_interest_retention_runtime_grants.sql"), /Missing required public export source: migrations\/041_interest_retention_runtime_grants\.sql/);
assert.equal(PUBLIC_DOC_NAMES.includes("GUIDE_DATABASE_SECURITY.md"), true);
assert.throws(() => assertPublicExportPaths(["site/dist/index.html", "site/dist/app.js", "src/index.ts"]));
assert.throws(() => assertPublicExportPaths(["site/dist/index.html", "site/dist/app.js", "site/dist/styles.css", "src/index.ts", ".github/workflows/publish.yml"]));
assert.doesNotThrow(() => assertPublicExportPaths(["site/dist/index.html", "site/dist/app.js", "site/dist/styles.css", "src/index.ts"]));

const sourceConfig = {
  account_id: "private-account",
  name: "private-name",
  vars: {
    COMMUNITY_ADMIN_ID: "private-user",
    LIFECYCLE_ADMIN_DATABASE_URL: "postgresql://private-lifecycle-admin",
  },
  r2_buckets: [{ binding: "BUG_PRIVATE_OBJECTS", bucket_name: "private-bucket" }],
  compatibility_date: "2026-08-14",
};
const publicConfig = sanitizeWranglerConfig(sourceConfig);
assert.equal(sourceConfig.account_id, "private-account");
assert.equal(publicConfig.account_id, undefined);
assert.equal(publicConfig.name, "onething-community");
assert.equal(publicConfig.vars.COMMUNITY_ADMIN_ID, "U_REPLACE_ADMIN");
assert.equal(publicConfig.vars.LIFECYCLE_MODE, "disabled");
assert.equal(publicConfig.vars.REVIEW_THREAD_V2, "false");
assert.equal(publicConfig.vars.GARDEN_RECONCILIATION, "false");
assert.equal(publicConfig.vars.REFERRALS_ENABLED, "false");
assert.equal(publicConfig.vars.PUBLIC_APPLICATIONS_ENABLED, "false");
assert.equal(publicConfig.vars.PUBLIC_INTEREST_ENABLED, "false");
assert.equal(publicConfig.vars.REFERRAL_ADMIN_DATABASE_URL, undefined);
assert.equal(publicConfig.vars.INTEREST_RUNTIME_DATABASE_URL, undefined);
assert.equal(publicConfig.vars.LIFECYCLE_ADMIN_DATABASE_URL, undefined);
assert.deepEqual(publicConfig.r2_buckets, [
  { binding: "BUG_PRIVATE_OBJECTS", bucket_name: "replace-with-private-bucket" },
  { binding: "INVITE_PRIVATE_OBJECTS", bucket_name: "replace-with-invite-private-bucket" },
]);
assert.equal(publicConfig.compatibility_date, "2026-08-14");
assert.throws(() => assertSanitizedCoreConfig({ ...publicConfig, vars: { ...publicConfig.vars, REFERRALS_ENABLED: "true" } }));

const sourceSiteConfig = {
  account_id: "private-account",
  name: "private-site",
  services: [{ binding: "CORE", service: "private-core" }],
  vars: { TURNSTILE_SITE_KEY: "private-site-key" },
  ratelimits: [{ name: "RATE_LIMITER", namespace_id: "private-namespace", simple: { limit: 1, period: 1 } }],
};
const publicSiteConfig = sanitizeSiteWranglerConfig(sourceSiteConfig);
assert.equal(publicSiteConfig.account_id, undefined);
assert.deepEqual(publicSiteConfig.services, [{ binding: "CORE", service: "replace-with-core-worker" }]);
assert.deepEqual(publicSiteConfig.vars, {
  TURNSTILE_SITE_KEY: "replace-with-turnstile-site-key",
  PUBLIC_INTEREST_ENABLED: "false",
});
assert.equal(publicSiteConfig.vars.PUBLIC_INTEREST_ENABLED, "false");

const publicSiteQaCoreConfig = sanitizeSiteQaCoreConfig({
  name: "otl1-onething-garden",
  main: "fake-core.ts",
  compatibility_date: "2026-09-19",
});
assert.equal(publicSiteQaCoreConfig.name, "onething-core-fixture");
assert.equal(publicSiteQaCoreConfig.main, "fake-core.ts");

const sourcePackage = {
  name: "fixture",
  scripts: { typecheck: "private-typecheck", keep: "node keep.mjs" },
  devDependencies: { private: "1.0.0" },
};
const publicPackage = sanitizePackageMetadata(sourcePackage);
assert.equal(sourcePackage.scripts.typecheck, "private-typecheck");
assert.deepEqual(publicPackage.devDependencies, {
  "@biomejs/biome": "2.5.6",
  typescript: "7.1.0-dev.20260809.1",
  wrangler: "4.62.0",
  zod: "4.4.3",
});
assert.deepEqual(publicPackage.scripts, {
  typecheck: "tsc --noEmit",
  keep: "node keep.mjs",
});

console.log("PASS public export manifests and sanitizers preserve the curated boundary");
