import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const checker = join(root, "scripts/check-canonical-repo.mjs");
const before = execFileSync("git", ["status", "--porcelain=v1", "--branch"], {
  cwd: root,
  encoding: "utf8",
});

const metadata = {
  branch: "main",
  actionsEnabled: false,
  usesGitHubActions: false,
  ruleset: {
    target: "refs/heads/main",
    enforcement: "active",
    requiredChecks: [
      { name: "CI / check", appId: "123", receipt: "genquant-signed" },
      { name: "CI / public-export-scan", appId: "123", receipt: "genquant-signed" },
      { name: "Policy / risk", appId: "123", receipt: "genquant-signed" },
      { name: "Evidence / receipt", appId: "123", receipt: "genquant-signed" },
    ],
    checkSource: "genquant-ci-github-apps",
    signedReceipts: true,
    requiredReviewCount: 1,
    mergeQueue: true,
    allowedMergeMethods: ["squash"],
    bypassActors: [],
    allowForcePush: false,
    allowDeletion: false,
    dismissStaleReviews: true,
    requireLastPushApproval: true,
    readbackVerified: false,
  },
};

function run(...args) {
  const result = spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.stderr, "", `checker stderr: ${result.stderr}`);
  assert.ok(result.stdout.trim().length > 0, "checker emitted no JSON");
  return { exitCode: result.status, value: JSON.parse(result.stdout) };
}

function initRepository(directory) {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", directory], {
    encoding: "utf8",
  });
  execFileSync("git", [
    "-C",
    directory,
    "remote",
    "add",
    "ops",
    "https://github.com/Betalgeuse/otl1-ops.git",
  ]);
  execFileSync("git", [
    "-C",
    directory,
    "remote",
    "add",
    "public",
    "https://github.com/Betalgeuse/otl1.git",
  ]);
}

const metadataDirectory = mkdtempSync(join(tmpdir(), "otl1-canonical-metadata-"));
const metadataPath = join(metadataDirectory, "ruleset.json");
writeFileSync(metadataPath, JSON.stringify(metadata));
const baseline = run();
assert.equal(baseline.exitCode, 1);
assert.equal(baseline.value.schema_version, "canonical_repo_check.v1");
assert.equal(baseline.value.canonical, false);
assert.equal(baseline.value.remotes.public.matches, true);
assert.equal(baseline.value.remotes.ops.matches, false);
assert.equal(baseline.value.ci.github_actions_allowed, false);
assert.equal(baseline.value.ci.github_actions_enabled, false);
assert.ok(baseline.value.missing_requirements.includes("ops_remote"));
assert.ok(baseline.value.missing_requirements.includes("canonical_branch"));
assert.ok(baseline.value.missing_requirements.includes("ruleset_metadata"));
assert.ok(baseline.value.errors.some((error) => error.code === "ruleset_metadata_input_missing"));
assert.doesNotMatch(JSON.stringify(baseline.value), /xox[baprs]-[A-Za-z0-9-]+/);
assert.doesNotMatch(JSON.stringify(baseline.value), /[TUCD][A-Z0-9]{8,}/);
assert.equal(
  execFileSync("git", ["status", "--porcelain=v1", "--branch"], { cwd: root, encoding: "utf8" }),
  before,
);

const metadataOnly = run("--metadata", metadataPath);
assert.equal(metadataOnly.value.canonical, false);
assert.ok(metadataOnly.value.missing_requirements.includes("ops_remote"));
assert.ok(
  metadataOnly.value.missing_requirements.includes("ruleset_readback_verified"),
  "unverified metadata cannot claim success",
);
metadata.ruleset.readbackVerified = true;
writeFileSync(metadataPath, JSON.stringify(metadata));

const temporaryDirectories = [];
try {
  const clean = mkdtempSync(join(tmpdir(), "otl1-canonical-repo-"));
  temporaryDirectories.push(clean);
  initRepository(clean);
  const cleanResult = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(cleanResult.exitCode, 0);
  assert.equal(cleanResult.value.canonical, true);
  assert.equal(cleanResult.value.remotes.ops.matches, true);
  assert.equal(cleanResult.value.remotes.public.matches, true);

  execFileSync("git", [
    "-C",
    clean,
    "remote",
    "set-url",
    "--add",
    "ops",
    "https://github.com/attacker/untrusted.git",
  ]);
  execFileSync("git", [
    "-C",
    clean,
    "remote",
    "set-url",
    "--add",
    "--push",
    "ops",
    "https://github.com/attacker/untrusted.git",
  ]);
  const poisoned = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(poisoned.value.canonical, false);
  assert.ok(poisoned.value.missing_requirements.includes("ops_remote_fetch_urls"));
  assert.ok(poisoned.value.missing_requirements.includes("ops_remote_push_urls"));

  metadata.actionsEnabled = true;
  writeFileSync(metadataPath, JSON.stringify(metadata));
  const actionsEnabled = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(actionsEnabled.value.canonical, false);
  assert.ok(actionsEnabled.value.missing_requirements.includes("github_actions_disabled"));
  assert.equal(actionsEnabled.value.ci.github_actions_enabled, true);
  metadata.actionsEnabled = false;
  metadata.ruleset.usesGitHubActions = true;
  writeFileSync(metadataPath, JSON.stringify(metadata));
  const nestedActionsEnabled = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(nestedActionsEnabled.value.canonical, false);
  assert.ok(nestedActionsEnabled.value.missing_requirements.includes("github_actions_disabled"));
  assert.equal(nestedActionsEnabled.value.ci.github_actions_enabled, true);
  delete metadata.ruleset.usesGitHubActions;
  writeFileSync(metadataPath, JSON.stringify(metadata));

  writeFileSync(join(clean, "untracked.txt"), "dirty\n");
  const dirty = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(dirty.value.canonical, false);
  assert.ok(dirty.value.missing_requirements.includes("clean_worktree"));

  const misleading = JSON.parse(readFileSync(metadataPath, "utf8"));
  misleading.ruleset.readbackVerified = false;
  writeFileSync(metadataPath, JSON.stringify(misleading));
  const dirtyAndUnverified = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(dirtyAndUnverified.value.canonical, false);
  assert.ok(dirtyAndUnverified.value.missing_requirements.includes("ruleset_readback_verified"));

  const malformed = mkdtempSync(join(tmpdir(), "otl1-canonical-malformed-"));
  temporaryDirectories.push(malformed);
  initRepository(malformed);
  writeFileSync(join(malformed, ".git", "config"), "[remote\nmalformed\n");
  const malformedResult = run("--repo", malformed);
  assert.equal(malformedResult.value.canonical, false);
  assert.ok(malformedResult.value.errors.length > 0);
  assert.ok(
    malformedResult.value.errors.every(
      (error) => Object.keys(error).length === 1 && typeof error.code === "string",
    ),
  );
} finally {
  rmSync(metadataDirectory, { recursive: true, force: true });
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
}

console.log(
  "PASS canonical repository preflight: baseline, metadata gating, clean/dirty, malformed config, redaction, and read-only status",
);
