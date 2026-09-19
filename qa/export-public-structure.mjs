import assert from "node:assert/strict";
import {
  assertSanitizedCoreConfig,
  sanitizePackageMetadata,
  sanitizeSiteWranglerConfig,
  sanitizeWranglerConfig,
} from "../scripts/export-public-config.mjs";
import {
  assertPublicExportPaths,
  assertRequiredPublicExportSources,
  PUBLIC_COPY_PATHS,
  PUBLIC_DOC_NAMES,
  PUBLIC_QA_NAMES,
  PUBLIC_RUNTIME_MIGRATION_PATHS,
} from "../scripts/export-public-manifest.mjs";

assert.equal(new Set(PUBLIC_COPY_PATHS).size, PUBLIC_COPY_PATHS.length);
assert.equal(new Set(PUBLIC_QA_NAMES).size, PUBLIC_QA_NAMES.length);
assert.equal(new Set(PUBLIC_DOC_NAMES).size, PUBLIC_DOC_NAMES.length);
assert.equal(PUBLIC_COPY_PATHS.includes("migrations/028_welcome_guide_roles.sql"), true);
assert.equal(PUBLIC_COPY_PATHS.includes("site"), true);
assert.equal(PUBLIC_COPY_PATHS.includes("migrations/029_member_lifecycle.sql"), true);
assert.equal(PUBLIC_COPY_PATHS.includes("migrations/033_dormant_return.sql"), true);
assert.deepEqual(PUBLIC_RUNTIME_MIGRATION_PATHS, ["migrations/034_referral_runtime_retention.sql"]);
assert.doesNotThrow(() => assertRequiredPublicExportSources(PUBLIC_RUNTIME_MIGRATION_PATHS, () => true));
assert.throws(
  () => assertRequiredPublicExportSources(PUBLIC_RUNTIME_MIGRATION_PATHS, () => false),
  /Missing required public export source: migrations\/034_referral_runtime_retention\.sql/,
);
assert.equal(PUBLIC_QA_NAMES.includes("community-guide-security-pg.mjs"), true);
assert.equal(PUBLIC_QA_NAMES.includes("version-map.mjs"), true);
assert.equal(PUBLIC_DOC_NAMES.includes("GUIDE_DATABASE_SECURITY.md"), true);
assert.throws(() => assertPublicExportPaths(["site/dist/index.html", "site/dist/app.js", "src/index.ts"]));
assert.throws(() => assertPublicExportPaths(["site/dist/index.html", "site/dist/app.js", "site/dist/styles.css", "src/index.ts", ".github/workflows/publish.yml"]));
assert.doesNotThrow(() => assertPublicExportPaths(["site/dist/index.html", "site/dist/app.js", "site/dist/styles.css", "src/index.ts"]));

const sourceConfig = {
  account_id: "private-account",
  name: "private-name",
  vars: { COMMUNITY_ADMIN_ID: "private-user" },
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
assert.deepEqual(publicSiteConfig.vars, { TURNSTILE_SITE_KEY: "replace-with-turnstile-site-key" });

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
