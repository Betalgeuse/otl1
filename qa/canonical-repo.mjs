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
    requiredChecks: [],
    checkSource: "github-ruleset-api",
    signedReceipts: false,
    requiredReviewCount: 0,
    mergeQueue: false,
    allowedMergeMethods: ["squash"],
    bypassActors: [],
    allowForcePush: false,
    allowDeletion: false,
    dismissStaleReviews: true,
    requireLastPushApproval: false,
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
    "public",
    "https://github.com/Betalgeuse/otl1.git",
  ]);
}

function commitRepository(directory) {
  writeFileSync(join(directory, "tracked.txt"), "canonical source\n");
  execFileSync("git", ["-C", directory, "add", "tracked.txt"]);
  execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Canonical Fixture",
      "-c",
      "user.email=canonical-fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Create canonical fixture",
    ],
    { encoding: "utf8" },
  );
  return execFileSync("git", ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
  }).trim();
}

const metadataDirectory = mkdtempSync(join(tmpdir(), "otl1-canonical-metadata-"));
const metadataPath = join(metadataDirectory, "ruleset.json");
writeFileSync(metadataPath, JSON.stringify(metadata));
const baseline = run();
assert.equal(baseline.exitCode, 1);
assert.equal(baseline.value.schema_version, "canonical_repo_check.v1");
assert.equal(baseline.value.canonical, false);
assert.equal(baseline.value.remotes.public.matches, true);
assert.equal(baseline.value.ci.github_actions_allowed, false);
assert.equal(baseline.value.ci.github_actions_enabled, false);
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
  const unbornBefore = execFileSync("git", ["-C", clean, "status", "--porcelain=v1", "--branch"], {
    encoding: "utf8",
  });
  const unborn = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(unborn.exitCode, 1);
  assert.equal(unborn.value.canonical, false);
  assert.equal(unborn.value.repository.head_resolved, false);
  assert.equal(unborn.value.repository.head_sha, null);
  assert.ok(unborn.value.missing_requirements.includes("head_commit"));
  assert.ok(unborn.value.errors.some((error) => error.code === "head_commit_unavailable"));
  assert.equal(
    execFileSync("git", ["-C", clean, "status", "--porcelain=v1", "--branch"], {
      encoding: "utf8",
    }),
    unbornBefore,
  );

  const headSha = commitRepository(clean);
  const cleanResult = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(cleanResult.exitCode, 0);
  assert.equal(cleanResult.value.canonical, true);
  assert.equal(cleanResult.value.repository.head_resolved, true);
  assert.equal(cleanResult.value.repository.head_sha, headSha);
  assert.match(cleanResult.value.repository.head_sha, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.equal(cleanResult.value.remotes.public.matches, true);

  const detached = mkdtempSync(join(tmpdir(), "otl1-canonical-detached-"));
  temporaryDirectories.push(detached);
  initRepository(detached);
  const detachedSha = commitRepository(detached);
  execFileSync("git", ["-C", detached, "checkout", "--quiet", "--detach", detachedSha]);
  const detachedResult = run("--repo", detached, "--metadata", metadataPath);
  assert.equal(detachedResult.exitCode, 1);
  assert.equal(detachedResult.value.canonical, false);
  assert.equal(detachedResult.value.repository.detached, true);
  assert.equal(detachedResult.value.repository.head_resolved, true);
  assert.equal(detachedResult.value.repository.head_sha, detachedSha);
  assert.ok(detachedResult.value.missing_requirements.includes("canonical_branch"));

  const malformedHead = mkdtempSync(join(tmpdir(), "otl1-canonical-malformed-head-"));
  temporaryDirectories.push(malformedHead);
  initRepository(malformedHead);
  writeFileSync(join(malformedHead, ".git", "HEAD"), "ref: refs/heads/../invalid\n");
  const malformedHeadResult = run("--repo", malformedHead, "--metadata", metadataPath);
  assert.equal(malformedHeadResult.exitCode, 1);
  assert.equal(malformedHeadResult.value.canonical, false);
  assert.equal(malformedHeadResult.value.repository.head_resolved, false);
  assert.equal(malformedHeadResult.value.repository.head_sha, null);
  assert.ok(malformedHeadResult.value.missing_requirements.includes("head_commit"));
  assert.ok(
    malformedHeadResult.value.errors.some((error) => error.code === "head_commit_unavailable"),
  );

  execFileSync("git", [
    "-C",
    clean,
    "remote",
    "set-url",
    "--add",
    "public",
    "https://github.com/attacker/untrusted.git",
  ]);
  execFileSync("git", [
    "-C",
    clean,
    "remote",
    "set-url",
    "--add",
    "--push",
    "public",
    "https://github.com/attacker/untrusted.git",
  ]);
  const poisoned = run("--repo", clean, "--metadata", metadataPath);
  assert.equal(poisoned.value.canonical, false);
  assert.ok(poisoned.value.missing_requirements.includes("public_remote_fetch_urls"));
  assert.ok(poisoned.value.missing_requirements.includes("public_remote_push_urls"));

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
  "PASS canonical repository preflight: exact HEAD, unborn/detached/malformed HEAD, metadata, remotes, and read-only status",
);
