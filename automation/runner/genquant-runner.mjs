import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  buildReproductionPrompt,
  parseLease,
  parseReproductionReceipt,
  parseTaskStatus,
  parseTaskUrl,
  reproductionPath,
  sha256,
  validateRunnerConfig,
} from "./contract.mjs";

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
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
      body: JSON.stringify({ query: `SELECT otl.${functionName}($1::jsonb)`, params: [JSON.stringify(input)] }),
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
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify({ bugId: lease.bugId, baseSha: lease.baseSha, promptDigest, taskUrl: task.taskUrl, runId: proposedRunId })}\n`, "utf8");
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
  const remoteSha = command("git", ["-C", repository, "rev-parse", "FETCH_HEAD"]);
  if (remoteSha !== lease.baseSha) throw new Error("runner base SHA changed after approval");
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
      if (!providerLogStat.isFile() || providerLogStat.isSymbolicLink() || providerLogStat.size > 1024 * 1024)
        throw new Error("unsafe provider diagnostic file");
      await unlink(providerLog);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const paths = command("git", ["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));
    const expectedPath = reproductionPath(lease.bugId);
    if (paths.length !== 1 || paths[0] !== expectedPath)
      throw new Error("reproduction task changed files outside its artifact boundary");
    return parseReproductionReceipt(await readFile(join(worktree, expectedPath), "utf8"), lease.bugId);
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

async function processOne(config) {
  const db = sqlClient(config.BUG_RUNNER_DATABASE_URL);
  const workerId = config.BUG_RUNNER_WORKER_ID ?? "genquant-primary";
  const leaseToken = randomUUID();
  const runnerImageDigest = sha256(
    `${process.version}|${command("codex", ["--version"])}|${command("git", ["--version"])}`,
  );
  const leased = await db("bug_runner_lease", {
    teamId: config.SLACK_TEAM_ID,
    workerId,
    accountAlias: config.CODEX_ACCOUNT_ALIAS,
    leaseToken,
    leaseSeconds: 900,
    runnerImageDigest,
  });
  if (leased === null) return false;
  const lease = parseLease(leased);
  const prompt = buildReproductionPrompt(lease);
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
    let lastHeartbeat = Date.now();
    let status = "pending";
    phase = "status";
    while (Date.now() - startedAt < 15 * 60_000) {
      await sleep(10_000);
      status = parseTaskStatus(
        command("codex", ["cloud", "status", task.taskId], { acceptOutputOnFailure: true }),
      );
      if (["ready", "failed", "cancelled"].includes(status)) break;
      if (Date.now() - lastHeartbeat >= 240_000) {
        await db("bug_runner_heartbeat", {
          teamId: config.SLACK_TEAM_ID,
          jobId: lease.jobId,
          workerId,
          leaseToken,
          leaseSeconds: 900,
        });
        lastHeartbeat = Date.now();
      }
    }
    if (status !== "ready") throw new Error(`Codex task did not become ready: ${status}`);
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
    const failureDigest = sha256(`${lease.bugId}|${lease.jobId}|${error instanceof Error ? error.message : "unknown"}`);
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
