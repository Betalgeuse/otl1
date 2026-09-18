import assert from "node:assert/strict";
import {
  sanitizePackageMetadata,
  sanitizeWranglerConfig,
} from "../scripts/export-public-config.mjs";
import {
  PUBLIC_COPY_PATHS,
  PUBLIC_DOC_NAMES,
  PUBLIC_QA_NAMES,
} from "../scripts/export-public-manifest.mjs";

assert.equal(new Set(PUBLIC_COPY_PATHS).size, PUBLIC_COPY_PATHS.length);
assert.equal(new Set(PUBLIC_QA_NAMES).size, PUBLIC_QA_NAMES.length);
assert.equal(new Set(PUBLIC_DOC_NAMES).size, PUBLIC_DOC_NAMES.length);
assert.equal(PUBLIC_COPY_PATHS.includes("migrations/028_welcome_guide_roles.sql"), true);
assert.equal(PUBLIC_QA_NAMES.includes("community-guide-security-pg.mjs"), true);
assert.equal(PUBLIC_DOC_NAMES.includes("GUIDE_DATABASE_SECURITY.md"), true);

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
assert.deepEqual(publicConfig.r2_buckets, [
  { binding: "BUG_PRIVATE_OBJECTS", bucket_name: "replace-with-private-bucket" },
]);
assert.equal(publicConfig.compatibility_date, "2026-08-14");

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
});
assert.deepEqual(publicPackage.scripts, {
  typecheck: "tsc --noEmit",
  keep: "node keep.mjs",
});

console.log("PASS public export manifests and sanitizers preserve the curated boundary");
