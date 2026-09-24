import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildFixPrompt,
  buildReproductionPrompt,
  parseLease,
  parseReproductionReceipt,
  parseTaskStatus,
  parseTaskUrl,
  reproductionPath,
  sha256,
  validateRunnerConfig,
} from "./contract.mjs";

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

function command(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
    }).trimEnd();
  } catch (error) {
    if (options.acceptOutputOnFailure && typeof error?.stdout === "string" && error.stdout.trim())
      return error.stdout.trimEnd();
    throw error;
  }
}

function sqlClient(connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".neon.tech"))
    throw new Error("invalid runner database URL");
  const endpoint = `https://${url.hostname}/sql`;
  return async (functionName, input) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Neon-Connection-String": connectionString,
        "Neon-Raw-Text-Output": "true",
        "Neon-Array-Mode": "true",
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        query: `SELECT otl.${functionName}($1::jsonb)`,
        params: [JSON.stringify(input)],
      }),
    });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.rows) || !Array.isArray(body.rows[0]))
      throw new Error(`database call failed: ${functionName}`);
    const value = body.rows[0][0];
    return value === null ? null : JSON.parse(value);
  };
}

async function ensureRepository(root, repositoryUrl) {
  const repository = join(root, "repository");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    command("git", ["-C", repository, "rev-parse", "--git-dir"]);
  } catch {
    command("git", ["clone", "--filter=blob:none", "--no-checkout", repositoryUrl, repository], {
      timeout: 180_000,
    });
  }
  const remote = command("git", ["-C", repository, "remote", "get-url", "origin"]);
  if (remote !== repositoryUrl) throw new Error("runner repository remote mismatch");
  return repository;
}

async function dispatchTaskOnce(config, lease, prompt, promptDigest, proposedRunId) {
  const directory = join(config.BUG_RUNNER_ROOT, "receipts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `job-${lease.jobId}.json`);
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (
      existing.bugId !== lease.bugId ||
      existing.baseSha !== lease.baseSha ||
      existing.promptDigest !== promptDigest
    )
      throw new Error("runner task receipt does not match the leased job");
    return { task: parseTaskUrl(existing.taskUrl), runId: existing.runId };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const task = parseTaskUrl(
    command(
      "codex",
      [
        "cloud",
        "exec",
        "--env",
        config.CODEX_ENVIRONMENT_ID,
        "--branch",
        config.CODEX_BASE_BRANCH,
        prompt,
      ],
      { timeout: 90_000 },
    ),
  );
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(
      `${JSON.stringify({ bugId: lease.bugId, baseSha: lease.baseSha, promptDigest, taskUrl: task.taskUrl, runId: proposedRunId })}\n`,
      "utf8",
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (existing.taskUrl !== task.taskUrl || existing.runId !== proposedRunId)
      throw new Error("concurrent task dispatch created a conflicting receipt");
  } finally {
    await handle?.close();
  }
  return { task, runId: proposedRunId };
}

async function validateTaskArtifact(config, lease, taskId, runId) {
  const repository = await ensureRepository(config.BUG_RUNNER_ROOT, config.CODEX_REPOSITORY_URL);
  command("git", ["-C", repository, "fetch", "--no-tags", "origin", config.CODEX_BASE_BRANCH], {
    timeout: 180_000,
  });
  command("git", ["-C", repository, "cat-file", "-e", `${lease.baseSha}^{commit}`]);
  const runsRoot = join(config.BUG_RUNNER_ROOT, "runs");
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const worktree = resolve(runsRoot, `${lease.jobId}-${runId}`);
  if (!worktree.startsWith(`${resolve(runsRoot)}/`) || !isAbsolute(worktree))
    throw new Error("unsafe runner worktree path");
  command("git", ["-C", repository, "worktree", "add", "--detach", worktree, lease.baseSha], {
    timeout: 60_000,
  });
  try {
    command("codex", ["cloud", "apply", taskId], { cwd: worktree, timeout: 180_000 });
    const providerLog = join(worktree, "error.log");
    try {
      const providerLogStat = await lstat(providerLog);
      if (
        !providerLogStat.isFile() ||
        providerLogStat.isSymbolicLink() ||
        providerLogStat.size > 1024 * 1024
      )
        throw new Error("unsafe provider diagnostic file");
      await unlink(providerLog);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const paths = command("git", [
      "-C",
      worktree,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    const expectedPath = reproductionPath(lease.bugId);
    if (paths.length !== 1 || paths[0] !== expectedPath)
      throw new Error("reproduction task changed files outside its artifact boundary");
    return parseReproductionReceipt(
      await readFile(join(worktree, expectedPath), "utf8"),
      lease.bugId,
    );
  } finally {
    try {
      command("git", ["-C", repository, "worktree", "remove", "--force", worktree], {
        timeout: 60_000,
      });
    } catch {
      log("bug.runner.cleanup_failed", { jobId: lease.jobId });
    }
  }
}

async function fixTaskArtifact(config, lease, taskId, runId) {
  const repository = await ensureRepository(config.BUG_RUNNER_ROOT, config.CODEX_REPOSITORY_URL);
  command("git", ["-C", repository, "fetch", "--no-tags", "origin", config.CODEX_BASE_BRANCH], {
    timeout: 180_000,
  });
  command("git", ["-C", repository, "cat-file", "-e", `${lease.baseSha}^{commit}`]);
  const runsRoot = join(config.BUG_RUNNER_ROOT, "runs");
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const worktree = resolve(runsRoot, `${lease.jobId}-${runId}`);
  command("git", ["-C", repository, "worktree", "add", "--detach", worktree, lease.baseSha]);
  try {
    command("codex", ["cloud", "apply", taskId], { cwd: worktree, timeout: 180_000 });
    try {
      const stat = await lstat(join(worktree, "error.log"));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new Error("unsafe provider diagnostic file");
      await unlink(join(worktree, "error.log"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const paths = command("git", [
      "-C",
      worktree,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    if (paths.length < 1 || paths.length > 50) throw new Error("fix diff size is outside policy");
    const forbidden = paths.some(
      (path) =>
        /(^|\/)([.]env|[.]dev[.]vars|wrangler[.]production[.]jsonc|error[.]log)$/.test(path) ||
        path.startsWith(".github/workflows/") ||
        path.startsWith("backups/") ||
        path.startsWith("bugs/runner/"),
    );
    if (forbidden) throw new Error("fix touched a forbidden path");
    command("git", ["-C", worktree, "add", "-N", "--", ...paths]);
    const diff = command("git", ["-C", worktree, "diff", "--binary", "--", ...paths], {
      timeout: 60_000,
    });
    const artifactDigest = sha256(diff);
    command("bun", ["install", "--frozen-lockfile"], { cwd: worktree, timeout: 180_000 });
    command("bun", ["run", "check"], { cwd: worktree, timeout: 20 * 60_000 });
    const slug = lease.publicAlias
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const branch = `feedback/${slug}-${lease.jobId}`;
    command("git", ["-C", worktree, "switch", "-c", branch]);
    command("git", ["-C", worktree, "add", "--", ...paths]);
    command("git", [
      "-C",
      worktree,
      "-c",
      "user.name=OT1L",
      "-c",
      "user.email=otl1@users.noreply.github.com",
      "commit",
      "-m",
      `Fix ${lease.bugId}`,
    ]);
    const headSha = command("git", ["-C", worktree, "rev-parse", "HEAD"]);
    command("git", ["-C", worktree, "push", "origin", `HEAD:refs/heads/${branch}`], {
      timeout: 180_000,
    });
    const title = `Fix ${lease.bugId}`;
    const body = `Automated OT1L fix for ${lease.bugId}.\n\nValidation: bun run check`;
    const prUrl = command(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        "Betalgeuse/otl1",
        "--base",
        "main",
        "--head",
        branch,
        "--draft",
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: worktree, timeout: 120_000 },
    ).trim();
    const pr = JSON.parse(
      command("gh", ["pr", "view", prUrl, "--repo", "Betalgeuse/otl1", "--json", "number,url"], {
        cwd: worktree,
      }),
    );
    return { artifactDigest, branch, headSha, prNumber: pr.number, prUrl: pr.url, paths };
  } finally {
    try {
      command("git", ["-C", repository, "worktree", "remove", "--force", worktree]);
    } catch {
      log("bug.runner.cleanup_failed", { jobId: lease.jobId });
    }
  }
}

async function waitForTask(db, config, lease, workerId, leaseToken, taskId, startedAt) {
  let lastHeartbeat = Date.now();
  while (Date.now() - startedAt < 20 * 60_000) {
    await sleep(10_000);
    const status = parseTaskStatus(
      command("codex", ["cloud", "status", taskId], { acceptOutputOnFailure: true }),
    );
    if (["ready", "failed", "cancelled"].includes(status)) return status;
    if (Date.now() - lastHeartbeat >= 240_000) {
      await db("bug_runner_heartbeat", {
        teamId: config.SLACK_TEAM_ID,
        jobId: lease.jobId,
        workerId,
        leaseToken,
        leaseSeconds: 1800,
      });
      lastHeartbeat = Date.now();
    }
  }
  return "timeout";
}

async function processApprovedMerge(db, config, workerId) {
  const leaseToken = randomUUID();
  const claim = await db("bug_runner_claim_merge", {
    teamId: config.SLACK_TEAM_ID,
    workerId,
    leaseToken,
  });
  if (claim === null) return false;
  const prNumber = Number(claim.prNumber);
  const changeId = Number(claim.changeId);
  if (!Number.isSafeInteger(prNumber) || !Number.isSafeInteger(changeId))
    throw new Error("merge claim identity invalid");
  const prUrl = `https://github.com/Betalgeuse/otl1/pull/${prNumber}`;
  try {
    command("gh", ["pr", "ready", prUrl, "--repo", "Betalgeuse/otl1"]);
    command(
      "gh",
      ["pr", "merge", prUrl, "--repo", "Betalgeuse/otl1", "--squash", "--delete-branch"],
      { timeout: 180_000 },
    );
    const merged = JSON.parse(
      command("gh", [
        "pr",
        "view",
        prUrl,
        "--repo",
        "Betalgeuse/otl1",
        "--json",
        "state,mergeCommit",
      ]),
    );
    const mergeSha = merged.mergeCommit?.oid;
    if (merged.state !== "MERGED" || typeof mergeSha !== "string")
      throw new Error("merge receipt missing");
    await db("bug_runner_finish_merge", {
      teamId: config.SLACK_TEAM_ID,
      changeId,
      workerId,
      leaseToken,
      runId: claim.runId,
      headSha: claim.headSha,
      mergeSha,
      mergeReceipt: sha256(`${prUrl}|${mergeSha}|merged`),
      summary: `관리자가 승인한 수정안 PR #${prNumber}을 main에 반영했습니다.`,
    });
    log("bug.runner.change_merged", { bugId: claim.bugId, changeId, runId: claim.runId });
  } catch (error) {
    await db("bug_runner_fail_merge", {
      teamId: config.SLACK_TEAM_ID,
      changeId,
      workerId,
      leaseToken,
    });
    throw error;
  }
  return true;
}

async function processOne(config) {
  const db = sqlClient(config.BUG_RUNNER_DATABASE_URL);
  const workerId = config.BUG_RUNNER_WORKER_ID ?? "genquant-primary";
  const repository = new URL(config.CODEX_REPOSITORY_URL).pathname.replace(/^\/+|[.]git$/g, "");
  const remoteHead = command("git", [
    "ls-remote",
    config.CODEX_REPOSITORY_URL,
    `refs/heads/${config.CODEX_BASE_BRANCH}`,
  ]).split(/\s+/)[0];
  if (!/^[a-f0-9]{40,64}$/.test(remoteHead)) throw new Error("repository head unavailable");
  await db("bug_runner_update_head", {
    teamId: config.SLACK_TEAM_ID,
    repository,
    branch: config.CODEX_BASE_BRANCH,
    headSha: remoteHead,
    workerId,
    observedAt: new Date().toISOString(),
  });
  if (await processApprovedMerge(db, config, workerId)) return true;
  const leaseToken = randomUUID();
  const runnerImageDigest = sha256(
    `${process.version}|${command("codex", ["--version"])}|${command("git", ["--version"])}`,
  );
  let leased = await db("bug_runner_lease", {
    teamId: config.SLACK_TEAM_ID,
    workerId,
    accountAlias: config.CODEX_ACCOUNT_ALIAS,
    leaseToken,
    leaseSeconds: 900,
    runnerImageDigest,
  });
  if (leased === null)
    leased = await db("bug_runner_lease_fix", {
      teamId: config.SLACK_TEAM_ID,
      workerId,
      accountAlias: config.CODEX_ACCOUNT_ALIAS,
      leaseToken,
      leaseSeconds: 1800,
      runnerImageDigest,
    });
  if (leased === null) return false;
  const lease = parseLease(leased);
  const prompt =
    lease.kind === "reproduce" ? buildReproductionPrompt(lease) : buildFixPrompt(lease);
  const promptDigest = sha256(prompt);
  let runId = `run-${randomUUID()}`;
  const startedAt = Date.now();
  let task;
  let phase = "dispatch";
  try {
    const dispatch = await dispatchTaskOnce(config, lease, prompt, promptDigest, runId);
    task = dispatch.task;
    runId = dispatch.runId;
    phase = "record_start";
    await db("bug_runner_start", {
      teamId: config.SLACK_TEAM_ID,
      jobId: lease.jobId,
      workerId,
      leaseToken,
      runId,
      baseSha: lease.baseSha,
      promptDigest,
      providerTaskId: task.taskId,
      providerTaskUrl: task.taskUrl,
    });
    log("bug.runner.task_started", { bugId: lease.bugId, jobId: lease.jobId, runId });
    phase = "status";
    const status = await waitForTask(
      db,
      config,
      lease,
      workerId,
      leaseToken,
      task.taskId,
      startedAt,
    );
    if (status !== "ready") throw new Error(`Codex task did not become ready: ${status}`);
    if (lease.kind === "fix") {
      phase = "fix_artifact";
      const fix = await fixTaskArtifact(config, lease, task.taskId, runId);
      const resultDigest = sha256(`${task.taskId}|${fix.artifactDigest}|checks_green`);
      const summary = `수정 파일 ${fix.paths.length}개(${fix.paths.slice(0, 5).join(", ")}${fix.paths.length > 5 ? " 외" : ""})의 검증을 마쳤습니다.`;
      phase = "record_fix";
      await db("bug_runner_finish_fix", {
        teamId: config.SLACK_TEAM_ID,
        jobId: lease.jobId,
        workerId,
        leaseToken,
        runId,
        elapsedMs: Date.now() - startedAt,
        artifactDigest: fix.artifactDigest,
        resultDigest,
        branch: fix.branch,
        headSha: fix.headSha,
        prNumber: fix.prNumber,
        summary,
      });
      log("bug.runner.merge_ready", { bugId: lease.bugId, jobId: lease.jobId, runId });
      return true;
    }
    phase = "artifact";
    const artifact = await validateTaskArtifact(config, lease, task.taskId, runId);
    const resultDigest = sha256(`${task.taskId}|${artifact.artifactDigest}|ready`);
    phase = "finish";
    await db("bug_runner_finish", {
      teamId: config.SLACK_TEAM_ID,
      jobId: lease.jobId,
      workerId,
      leaseToken,
      runId,
      status: "succeeded",
      exitClass: "reproduced",
      elapsedMs: Date.now() - startedAt,
      artifactDigest: artifact.artifactDigest,
      resultDigest,
    });
    log("bug.runner.task_ready", { bugId: lease.bugId, jobId: lease.jobId, runId });
    return true;
  } catch (error) {
    const failureDigest = sha256(
      `${lease.bugId}|${lease.jobId}|${error instanceof Error ? error.message : "unknown"}`,
    );
    if (task) {
      try {
        await db("bug_runner_finish", {
          teamId: config.SLACK_TEAM_ID,
          jobId: lease.jobId,
          workerId,
          leaseToken,
          runId,
          status: "failed",
          exitClass: "runner_failure",
          elapsedMs: Date.now() - startedAt,
          artifactDigest: failureDigest,
          resultDigest: failureDigest,
        });
      } catch {
        log("bug.runner.finish_failed", { bugId: lease.bugId, jobId: lease.jobId });
      }
    }
    log("bug.runner.task_failed", {
      bugId: lease.bugId,
      jobId: lease.jobId,
      phase,
      errorType: error instanceof Error ? error.name : "Unknown",
    });
    return true;
  }
}

export async function runLoop(environment = process.env) {
  const config = validateRunnerConfig(environment);
  const once = environment.BUG_RUNNER_ONCE === "true";
  do {
    const processed = await processOne(config);
    if (once) return;
    if (!processed) await sleep(15_000);
  } while (true);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href)
  runLoop().catch((error) => {
    log("bug.runner.fatal", { errorType: error instanceof Error ? error.name : "Unknown" });
    process.exitCode = 1;
  });
