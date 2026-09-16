// @ts-check

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** @typedef {{ target: string, appId: string, receipt: string }} RequiredCheck */
/** @typedef {{ target: string, enforcement: string, requiredChecks: RequiredCheck[], checkSource: string, signedReceipts: boolean, requiredReviewCount: number, mergeQueue: boolean, allowedMergeMethods: string[], bypassActors: unknown[], allowForcePush: boolean, allowDeletion: boolean, dismissStaleReviews: boolean, requireLastPushApproval: boolean, readbackVerified: boolean }} RulesetMetadata */
/** @typedef {{ branch: string, actionsEnabled: boolean, usesGitHubActions: boolean, ruleset: RulesetMetadata }} RepositoryMetadata */
/** @typedef {{ code: string }} CheckError */

const EXPECTED_BRANCH = "main";
const EXPECTED_REMOTES = Object.freeze({
  ops: "Betalgeuse/otl1-ops",
  public: "Betalgeuse/otl1",
});
const EXPECTED_CHECKS = Object.freeze([
  "CI / check",
  "CI / public-export-scan",
  "Policy / risk",
  "Evidence / receipt",
]);

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  try {
    return {
      ok: true,
      output: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch {
    return { ok: false, output: "" };
  }
}

/** @param {string} remote */
function remoteTarget(remote) {
  const trimmed = remote.trim();
  const scp = trimmed.match(/^[^/@:\s]+@([^/:\s]+):(.+)$/);
  const candidate = scp ? `https://${scp[1]}/${scp[2]}` : trimmed;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (parsed.hostname.toLowerCase() !== "github.com" || !/^[^/]+\/[^/]+$/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

/** @param {unknown} input */
function parseMetadata(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = /** @type {Record<string, unknown>} */ (input);
  const ruleset = value.ruleset;
  if (
    typeof value.branch !== "string" ||
    typeof ruleset !== "object" ||
    ruleset === null ||
    Array.isArray(ruleset)
  )
    return null;
  const rule = /** @type {Record<string, unknown>} */ (ruleset);
  const requiredChecks = rule.requiredChecks;
  if (!Array.isArray(requiredChecks)) return null;
  const checks = requiredChecks.map((check) => {
    if (typeof check !== "object" || check === null || Array.isArray(check)) return null;
    const candidate = /** @type {Record<string, unknown>} */ (check);
    return typeof candidate.name === "string" &&
      typeof candidate.appId === "string" &&
      typeof candidate.receipt === "string"
      ? { target: candidate.name, appId: candidate.appId, receipt: candidate.receipt }
      : null;
  });
  if (checks.some((check) => check === null)) return null;
  const actionValues = [value.actionsEnabled, rule.actionsEnabled];
  const useGitHubActionsValues = [value.usesGitHubActions, rule.usesGitHubActions];
  if (
    actionValues.some((candidate) => candidate !== undefined && typeof candidate !== "boolean") ||
    useGitHubActionsValues.some(
      (candidate) => candidate !== undefined && typeof candidate !== "boolean",
    ) ||
    actionValues.every((candidate) => candidate === undefined) ||
    useGitHubActionsValues.every((candidate) => candidate === undefined)
  )
    return null;
  const actionsEnabled = actionValues.some((candidate) => candidate === true);
  const usesGitHubActions = useGitHubActionsValues.some((candidate) => candidate === true);
  const metadata = {
    branch: value.branch,
    actionsEnabled,
    usesGitHubActions,
    ruleset: {
      target: rule.target,
      enforcement: rule.enforcement,
      requiredChecks: /** @type {RequiredCheck[]} */ (checks),
      checkSource: rule.checkSource,
      signedReceipts: rule.signedReceipts,
      requiredReviewCount: rule.requiredReviewCount,
      mergeQueue: rule.mergeQueue,
      allowedMergeMethods: rule.allowedMergeMethods,
      bypassActors: rule.bypassActors,
      allowForcePush: rule.allowForcePush,
      allowDeletion: rule.allowDeletion,
      dismissStaleReviews: rule.dismissStaleReviews,
      requireLastPushApproval: rule.requireLastPushApproval,
      readbackVerified: rule.readbackVerified,
    },
  };
  if (
    metadata.branch !== EXPECTED_BRANCH ||
    typeof metadata.actionsEnabled !== "boolean" ||
    typeof metadata.usesGitHubActions !== "boolean" ||
    metadata.ruleset.target !== "refs/heads/main" ||
    metadata.ruleset.enforcement !== "active"
  )
    return null;
  if (
    metadata.ruleset.checkSource !== "genquant-ci-github-apps" ||
    metadata.ruleset.signedReceipts !== true
  )
    return null;
  if (
    metadata.ruleset.requiredReviewCount !== 1 ||
    metadata.ruleset.mergeQueue !== true ||
    JSON.stringify(metadata.ruleset.allowedMergeMethods) !== '["squash"]'
  )
    return null;
  if (!Array.isArray(metadata.ruleset.bypassActors) || metadata.ruleset.bypassActors.length !== 0)
    return null;
  if (
    metadata.ruleset.allowForcePush !== false ||
    metadata.ruleset.allowDeletion !== false ||
    metadata.ruleset.dismissStaleReviews !== true ||
    metadata.ruleset.requireLastPushApproval !== true ||
    typeof metadata.ruleset.readbackVerified !== "boolean"
  )
    return null;
  const names = metadata.ruleset.requiredChecks.map((check) => check.target);
  if (
    names.length !== EXPECTED_CHECKS.length ||
    EXPECTED_CHECKS.some((name, index) => names[index] !== name) ||
    metadata.ruleset.requiredChecks.some(
      (check) => !/^\d+$/.test(check.appId) || check.receipt !== "genquant-signed",
    )
  )
    return null;
  return /** @type {RepositoryMetadata} */ (metadata);
}

/** @param {string[]} args */
function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-canonical-repo.mjs [--repo PATH] [--metadata PATH]");
    return 0;
  }
  const repo = argumentValue(args, "--repo") ?? process.cwd();
  const metadataPath =
    argumentValue(args, "--metadata") ?? process.env.CANONICAL_REPO_METADATA ?? null;
  const errors = /** @type {CheckError[]} */ ([]);
  let metadata = null;
  if (metadataPath === null) {
    errors.push({ code: "ruleset_metadata_input_missing" });
  } else {
    try {
      metadata = parseMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));
      if (metadata === null) errors.push({ code: "ruleset_metadata_invalid" });
    } catch {
      errors.push({ code: "ruleset_metadata_unreadable" });
    }
  }

  const rootResult = git(["rev-parse", "--show-toplevel"], repo);
  const root = rootResult.ok ? rootResult.output.trim() : null;
  if (root === null || root.length === 0) errors.push({ code: "not_a_git_repository" });
  const branchResult =
    root === null
      ? { ok: false, output: "" }
      : git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const branch = branchResult.ok ? branchResult.output.trim() : null;
  const statusResult =
    root === null
      ? { ok: false, output: "" }
      : git(["status", "--porcelain=v1", "--untracked-files=all"], root);
  const clean = statusResult.ok && statusResult.output.length === 0;
  if (!statusResult.ok) errors.push({ code: "git_status_unavailable" });

  const remoteNamesResult = root === null ? { ok: false, output: "" } : git(["remote"], root);
  const remoteNames = remoteNamesResult.ok
    ? remoteNamesResult.output
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
  if (!remoteNamesResult.ok) errors.push({ code: "git_remotes_unavailable" });
  /** @type {Record<string, { configured: boolean, fetchTargets: (string|null)[], pushTargets: (string|null)[] }> } */
  const remotes = {};
  for (const name of remoteNames) {
    const fetchUrls = git(["remote", "get-url", "--all", name], root ?? repo);
    const pushUrls = git(["remote", "get-url", "--push", "--all", name], root ?? repo);
    const fetchTargets = fetchUrls.ok
      ? fetchUrls.output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map(remoteTarget)
          .filter((target) => target !== undefined)
      : [];
    const pushTargets = pushUrls.ok
      ? pushUrls.output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map(remoteTarget)
          .filter((target) => target !== undefined)
      : [];
    remotes[name] = {
      configured:
        fetchUrls.ok &&
        pushUrls.ok &&
        fetchTargets.some((target) => target !== null) &&
        pushTargets.some((target) => target !== null),
      fetchTargets,
      pushTargets,
    };
    if (!fetchUrls.ok) errors.push({ code: "remote_fetch_url_unavailable" });
    if (!pushUrls.ok) errors.push({ code: "remote_push_url_unavailable" });
  }
  const expectedRemoteState = Object.fromEntries(
    Object.entries(EXPECTED_REMOTES).map(([name, target]) => {
      const observed = remotes[name];
      const fetchMatches =
        observed?.fetchTargets.length === 1 && observed.fetchTargets[0] === target;
      const pushMatches = observed?.pushTargets.length === 1 && observed.pushTargets[0] === target;
      return [
        name,
        {
          configured: observed?.configured ?? false,
          fetch_url_count: observed?.fetchTargets.length ?? 0,
          push_url_count: observed?.pushTargets.length ?? 0,
          fetch_matches: fetchMatches,
          push_matches: pushMatches,
          matches: fetchMatches && pushMatches,
        },
      ];
    }),
  );
  const unexpectedRemotes = remoteNames.filter((name) => !(name in EXPECTED_REMOTES));
  const worktreeResult =
    root === null ? { ok: false, output: "" } : git(["worktree", "list", "--porcelain"], root);
  const worktreeBlocks = worktreeResult.ok
    ? worktreeResult.output.split(/\n(?=worktree )/).filter(Boolean)
    : [];
  if (!worktreeResult.ok) errors.push({ code: "git_worktree_unavailable" });
  const requirements = {
    ops_remote: expectedRemoteState.ops.matches,
    public_remote: expectedRemoteState.public.matches,
    canonical_branch: branch === EXPECTED_BRANCH,
    clean_worktree: clean,
    worktree_registered: worktreeBlocks.length > 0,
    ruleset_metadata: metadata !== null,
    ruleset_readback_verified: metadata?.ruleset.readbackVerified === true,
    github_actions_disabled:
      metadata?.actionsEnabled === false && metadata?.usesGitHubActions === false,
  };
  const missing = Object.entries(requirements)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  for (const name of Object.keys(EXPECTED_REMOTES)) {
    if (!expectedRemoteState[name].fetch_matches) missing.push(`${name}_remote_fetch_urls`);
    if (!expectedRemoteState[name].push_matches) missing.push(`${name}_remote_push_urls`);
  }
  if (unexpectedRemotes.length > 0) missing.push("unexpected_remotes");
  const canonical = missing.length === 0 && errors.length === 0;
  const result = {
    schema_version: "canonical_repo_check.v1",
    canonical,
    repository: {
      expected_branch: EXPECTED_BRANCH,
      branch_matches: requirements.canonical_branch,
      detached: branch === null,
      clean_worktree: clean,
      worktree_registered: requirements.worktree_registered,
    },
    remotes: Object.fromEntries(Object.entries(expectedRemoteState)),
    unexpected_remote_count: unexpectedRemotes.length,
    expected: {
      ops_remote: EXPECTED_REMOTES.ops,
      public_remote: EXPECTED_REMOTES.public,
      required_checks: EXPECTED_CHECKS,
      ruleset_target: "refs/heads/main",
    },
    metadata: {
      provided: metadataPath !== null,
      valid: metadata !== null,
      readback_verified: requirements.ruleset_readback_verified,
      github_actions_disabled: requirements.github_actions_disabled,
    },
    ci: {
      github_actions_allowed: false,
      github_actions_enabled:
        metadata?.actionsEnabled === true || metadata?.usesGitHubActions === true,
      check_source: "genquant-ci-github-apps",
    },
    missing_requirements: missing,
    errors,
  };
  console.log(JSON.stringify(result));
  return canonical ? 0 : 1;
}

process.exitCode = main();
