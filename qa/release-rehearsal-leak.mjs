import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "otl-release-leak-"));
try {
  const path = join(temp, "receipt.json");
  const result = spawnSync(process.execPath, [
    "scripts/rehearse-membership-site-release.mjs", "--inject=secret-leak", `--receipt=${path}`,
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1, "synthetic leaked config must stop before long-running work");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.failure, "release artifact secret leak detected");
  assert.deepEqual(receipt.checks, {});
  assert.deepEqual(receipt.manifest, {});
  assert.deepEqual(readdirSync(temp), ["receipt.json"]);
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(receipt), /FAKE_RELEASE_SECRET_CANARY_/);
  const interest = spawnSync(process.execPath, [
    "scripts/rehearse-membership-site-release.mjs", "--inject=missing-interest-admin-credential", `--receipt=${path}`,
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const interestReceipt = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(interest.status, 1);
  assert.equal(interestReceipt.failure, "INTEREST_ADMIN_DATABASE_URL declaration missing");
  assert.equal(interestReceipt.checks["missing-interest-admin-credential"].observed, "rejected");
  assert.equal(interestReceipt.checks["missing-binding"].observed, "rejected");
  assert.equal(interestReceipt.checks.localCleanup, undefined);

  const readbackPath = join(temp, "rollback.json");
  writeFileSync(readbackPath, JSON.stringify({
    scenario: "read-only-current-rollback-version-readback", checkedAt: new Date().toISOString(),
    core: { worker: "otl1-onething-garden", versions: [{ versionId: "00000000-0000-4000-8000-000000000001", percentage: 100 }] },
    site: { worker: "otl1-site", versions: [{ versionId: "00000000-0000-4000-8000-000000000002", percentage: 100 }] },
  }));
  const schema = spawnSync(process.execPath, [
    "scripts/rehearse-membership-site-release.mjs", "--inject=schema-head", `--rollback-readback=${readbackPath}`, `--receipt=${path}`,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const schemaReceipt = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(schema.status, 1);
  assert.equal(schemaReceipt.failure, "schema head mismatch");
  assert.equal(schemaReceipt.checks["snapshot-035"].exit, 0);
  assert.equal(schemaReceipt.checks.localCleanup.exit, 0);
  assert.equal(schemaReceipt.checks.upgrade, undefined);
  assert.equal(schemaReceipt.checks["full-check"], undefined);
  console.log("PASS synthetic secret and missing interest admin credential rejected; schema marker mismatch detected in disposable PostgreSQL and cleaned");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
