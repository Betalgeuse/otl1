import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  console.log("PASS synthetic secret rejected before deployment readback, PG startup, and public export; receipt redacted");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
