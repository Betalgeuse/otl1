import { mock } from "bun:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { dispatchCommunityMessage } = await import("../src/community-message-router.ts");

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-dormant-return-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(56000 + Math.floor(Math.random() * 7000));
const env = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const migrations = (await readdir(join(root, "migrations")))
  .filter((name) => /^\d{3}_.*\.sql$/.test(name))
  .filter((name) => process.env.DORMANT_RED !== "1" || Number(name.slice(0, 3)) <= 32)
  .sort();
let started = false;
const run = (binary, args) => exec(binary, args, { cwd: root, env, encoding: "utf8" });
const psql = (args) => run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
const scalar = async (sql) => (await psql(["-Atq", "-c", sql])).stdout.trim();
const call = (payload) =>
  scalar(
    `SELECT otl.community_execute('change',convert_from(decode('${Buffer.from(JSON.stringify(payload)).toString("base64")}','base64'),'UTF8')::jsonb)`,
  );

const slackCalls = [];
const changes = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  slackCalls.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({ ok: true, ts: "1.1", message_ts: "1.1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const fakeStore = {
  lifecycleEligibility: async () => ({ state: "dormant", revision: 7 }),
  day: async (scope) => ({
    ...scope,
    goal: "",
    outcome: "pending",
    reflection: "",
    resting: false,
    revision: 0,
  }),
  change: async (change) => {
    changes.push(change);
    return {
      day: {
        teamId: change.teamId,
        channelId: change.channelId,
        userId: change.userId,
        date: change.date,
        goal: "",
        outcome: "pending",
        reflection: "",
        resting: false,
        revision: 0,
      },
      changed: false,
      conflict: false,
      firstGoal: false,
      firstReflection: false,
      undoKey: "",
    };
  },
};
const context = {
  env: {
    SLACK_TEAM_ID: "TDORM",
    SLACK_BOT_TOKEN: "test",
    DATABASE_URL: "test",
    BOARD_SIGNING_SECRET: "test",
    PUBLIC_BASE_URL: "https://example.test",
    COMMUNITY_CHANNEL_ID: "CDORM",
    COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
    COMMUNITY_RELEASE_CHANNEL_ID: "CRELEASE",
    COMMUNITY_ADMIN_ID: "UADMIN",
  },
  store: fakeStore,
  scope: { teamId: "TDORM", channelId: "CDORM", userId: "UDORM" },
  date: "2026-09-19",
  thread: "1.1",
  source: "1.1",
  key: "synthetic",
};
await dispatchCommunityMessage(context, "그냥 메시지", false);
await dispatchCommunityMessage(context, "오늘은 쉬어요", false);
await dispatchCommunityMessage(context, "후기: 해봤어요", false);
await dispatchCommunityMessage(context, "원씽: 다시 시작", false);
assert.equal(changes.length, 1);
assert.equal(changes[0].expectedLifecycleRevision, 7);
assert.equal(changes[0].action, "goal");
assert.equal(slackCalls.length, 4);
globalThis.fetch = originalFetch;

try {
  await mkdir(socket);
  await run(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pgBin, "pg_ctl"), [
    "-D",
    data,
    "-o",
    `-F -k ${socket} -p ${port}`,
    "-l",
    join(temp, "postgres.log"),
    "-w",
    "start",
  ]);
  started = true;
  for (const migration of migrations) {
    if (migration.startsWith("006_")) {
      await psql([
        "--single-transaction",
        "-f",
        `migrations/${migration}`,
        "-f",
        "migrations/007_normalized_legacy.sql",
      ]);
    } else if (!migration.startsWith("007_")) await psql(["-f", `migrations/${migration}`]);
  }
  const contract = await psql(["-Atq", "-f", "qa/dormant-eligibility-contract.sql"]);
  assert.match(contract.stdout, /SURFACE_COUNTS=1:RETURN_SEASONS=1:WELCOME=1/);

  const base = {
    teamId: "TDORM",
    channelId: "CDORM",
    userId: "URACE",
    date: "2026-09-19",
    action: "goal",
    text: "concurrent return",
    expectedRevision: 0,
    expectedLifecycleRevision: 1,
    now: "2026-09-19T01:00:00Z",
  };
  const raced = await Promise.allSettled([
    call({ ...base, key: "race-a" }),
    call({ ...base, key: "race-b" }),
  ]);
  assert.equal(raced.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(raced.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(
    await scalar(
      "SELECT count(*) FROM otl.grass_seasons WHERE user_id='URACE' AND opened_reason='return'",
    ),
    "1",
  );
  assert.equal(
    await scalar(
      "SELECT count(*) FROM otl.member_lifecycle_events WHERE user_id='URACE' AND event_type='reactivated'",
    ),
    "1",
  );
  assert.equal(
    await scalar(
      "SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE user_id='URACE' AND notice_kind='return'",
    ),
    "1",
  );

  await scalar(
    `SELECT otl.lifecycle_runtime_execute('claim_notices','{"teamId":"TDORM","now":"2026-09-19T01:00:01Z","limit":10,"leaseToken":"lease-return"}'::jsonb)`,
  );
  await scalar(
    `SELECT otl.lifecycle_runtime_execute('finish_notice','{"teamId":"TDORM","userId":"URACE","effectKey":"return:2","leaseToken":"lease-return","status":"failed","errorCode":"http_500","retryAt":"2026-09-19T01:01:01Z","now":"2026-09-19T01:00:02Z"}'::jsonb)`,
  );
  assert.equal(
    await scalar("SELECT state FROM otl.member_lifecycles WHERE user_id='URACE'"),
    "active",
  );
  assert.equal(
    await scalar("SELECT goal FROM otl.community_days WHERE user_id='URACE' AND day='2026-09-19'"),
    "concurrent return",
  );
  assert.equal(
    await scalar(
      `SELECT count(*) FROM jsonb_array_elements(otl.lifecycle_runtime_execute('claim_notices','{"teamId":"TDORM","now":"2026-09-19T01:01:01Z","limit":10,"leaseToken":"lease-retry"}'::jsonb))`,
    ),
    "1",
  );
  console.log(
    "PASS dormant eligibility: router-guidance=3 router-return=1 surfaces=6 denied-actions=4 preferences/history=byte-stable return-season=1 transition=1 welcome=1 concurrent-winner=1 slack-failure-authority=active retry=1",
  );
} finally {
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
