import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { deliverPrivateBugOutbox } from "../src/community-bug-delivery-messages.ts";
import { CommunityBugStore } from "../src/community-bug-store.ts";
import { NeonStore } from "../src/store.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-private-delivery-");
const data = join(temp, "pgdata");
const socket = join(temp, "socket");
const port = String(62000 + Math.floor(Math.random() * 1000));
const pgEnv = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const databaseUrl = "postgresql://qa:qa@private-delivery.neon.tech/db";
const originalFetch = globalThis.fetch;
const slackCalls = [];

async function command(binary, args) {
  return exec(binary, args, { cwd: root, env: pgEnv, encoding: "utf8" });
}

async function psql(args) {
  return command(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", ...args]);
}

async function callJson(functionName, input) {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64");
  const response = await psql([
    "-Atc",
    `SELECT otl.${functionName}(convert_from(decode('${payload}','base64'),'UTF8')::jsonb)`,
  ]);
  return response.stdout.trim();
}

async function deliveryRows(bugId) {
  const response = await psql([
    "-Atc",
    `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'key',delivery_key,'kind',delivery_kind,'destination',destination,
      'template',template_id,'renderer',renderer_version,'status',status,'attempts',attempts
    ) ORDER BY delivery_id),'[]'::jsonb) FROM otl.bug_deliveries WHERE bug_id='${bugId}'`,
  ]);
  return JSON.parse(response.stdout.trim());
}

function draftInput(bugId, source, privacy) {
  return {
    bugId,
    teamId: "T-PRIVATE-APP",
    publicAlias: `B-${bugId.slice(4)}`,
    reporterId: "U-PRIVATE",
    source: "slack",
    sourceOpaqueRef: `slack:T-PRIVATE-APP:C-PRIVATE:${source}`,
    sourceChannelId: "C-PRIVATE",
    sourceThread: source,
    idempotencyKey: `draft:${bugId}`,
    sanitizedFields: {
      title: privacy ? "비공개 버그 제보" : "일반 버그 제보",
      actual: privacy ? "비공개 버그 제보" : "버튼이 멈춰요",
      expected: null,
      steps: [],
      location: null,
      occurredAt: null,
      frequency: null,
      impact: privacy ? "security_privacy" : null,
      privacy,
    },
    opaqueRef: `bugs/${bugId}/1.enc`,
    objectDigest: "a".repeat(64),
    envelopeDek: "encrypted-envelope",
    kekVersion: "v1",
    nonce: "nonce-123456",
  };
}

function context(source) {
  return {
    env: {
      SLACK_TEAM_ID: "T-PRIVATE-APP",
      SLACK_BOT_TOKEN: "test",
      DATABASE_URL: databaseUrl,
      COMMUNITY_CHANNEL_ID: "C-ADMIN",
    },
    scope: { teamId: "T-PRIVATE-APP", channelId: "C-PRIVATE", userId: "U-PRIVATE" },
    store: {},
    date: "2026-09-17",
    source,
    thread: source,
    key: `qa:${source}`,
  };
}

async function assertImmediate(store, bugId, source, packetRevision) {
  const start = slackCalls.length;
  await deliverPrivateBugOutbox(context(source), {
    bugId,
    reporterId: "U-PRIVATE",
    packetRevision,
  });
  assert.deepEqual(
    (await deliveryRows(bugId)).map((row) => [
      row.kind,
      row.destination,
      row.template,
      row.renderer,
      row.status,
      row.attempts,
    ]),
    [
      [
        "receipt",
        "reporter_ephemeral",
        "receipt.private.v1",
        "bug-receipt.v1",
        "sent",
        1,
      ],
      [
        "admin_handoff",
        "admin_channel",
        "admin_handoff.private.v1",
        "bug-handoff.v1",
        "sent",
        1,
      ],
    ],
  );
  assert.deepEqual(
    slackCalls
      .slice(start)
      .map((call) => [call.method, call.body.channel])
      .toSorted(([left], [right]) => left.localeCompare(right)),
    [
      ["chat.postEphemeral", "C-PRIVATE"],
      ["chat.postMessage", "C-ADMIN"],
    ],
  );
  const replayStart = slackCalls.length;
  await deliverPrivateBugOutbox(context(source), {
    bugId,
    reporterId: "U-PRIVATE",
    packetRevision,
  });
  assert.equal(slackCalls.length, replayStart, "sent replay must not post a duplicate");
  assert.equal((await deliveryRows(bugId)).length, 2);
  assert.equal(
    slackCalls.some((call) => String(call.body.text).includes("확인하지 못했어요")),
    false,
  );
  assert.equal(
    (
      await psql([
        "-Atc",
        `SELECT count(*) FROM otl.bug_jobs WHERE bug_id='${bugId}'`,
      ])
    ).stdout.trim(),
    "0",
  );
  return store;
}

let started = false;
try {
  await command("mkdir", ["-p", socket]);
  await command(join(pgBin, "initdb"), [
    "-D",
    data,
    "--no-locale",
    "--encoding=UTF8",
    "--auth=trust",
  ]);
  await command(join(pgBin, "pg_ctl"), [
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
  for (const migration of ["001_initial", "005_community"])
    await psql(["-f", `migrations/${migration}.sql`]);
  await psql([
    "--single-transaction",
    "-f",
    "migrations/006_normalized_foundation.sql",
    "-f",
    "migrations/007_normalized_legacy.sql",
  ]);
  for (const migration of [
    "014_bug_ledger",
    "015_bug_deliveries",
    "016_bug_delivery_scheduler",
    "017_bug_expiry_job_guard",
    "018_bug_integrity",
    "019_bug_team_scope",
    "020_bug_private_atomic",
    "021_bug_private_backfill",
  ])
    await psql(["-f", `migrations/${migration}.sql`]);

  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    if (target.hostname.endsWith(".neon.tech")) {
      const request = JSON.parse(options.body);
      const functionName = request.query.match(/otl\.(bug_[a-z_]+)/)?.[1];
      assert.notEqual(functionName, undefined);
      const value = await callJson(functionName, JSON.parse(request.params[0]));
      return Response.json({ rows: [[value]] });
    }
    const body = JSON.parse(options.body);
    slackCalls.push({ method: target.pathname.slice(5), body });
    const ts = `30.${String(slackCalls.length).padStart(6, "0")}`;
    return Response.json({ ok: true, ts, message_ts: ts });
  };

  const store = new CommunityBugStore(new NeonStore(databaseUrl));
  const privateDraft = await store.createDraft(
    draftInput("BUG-PRIVATEDRAFT021", "41.000001", true),
  );
  assert.equal(privateDraft.state, "private_incident");
  await assertImmediate(store, privateDraft.bugId, "41.000001", privateDraft.packetRevision);

  const answerBugId = "BUG-PRIVATEANSWER021";
  const answerDraft = await store.createDraft(draftInput(answerBugId, "42.000001", false));
  await store.transition({
    bugId: answerBugId,
    toState: "needs_info",
    actors: ["deterministic_worker"],
    guard: { missingRequiredField: true },
    evidence: {
      reasonCodes: ["missing:impact"],
      questionId: "private-answer-q1",
      fieldName: "impact",
      templateVersion: "question.impact.v1",
      questionText: "영향",
    },
    expectedRevision: answerDraft.revision,
    idempotencyKey: "private-answer-question",
  });
  const answerRevision = await store.answerRevision({
    bugId: answerBugId,
    reporterId: "U-PRIVATE",
    questionId: "private-answer-q1",
    answerDigest: "b".repeat(64),
    answerOpaqueRef: `bugs/${answerBugId}/2.enc`,
    expectedPacketRevision: 1,
    idempotencyKey: "private-answer",
    privacy: true,
    sanitizedFields: {
      actual: "비공개 버그 제보",
      expected: null,
      steps: [],
      location: null,
      occurredAt: null,
      frequency: null,
      impact: "security_privacy",
    },
    completeness: { status: "needs_info" },
    opaqueRef: `bugs/${answerBugId}/2.enc`,
    objectDigest: "c".repeat(64),
    envelopeDek: "encrypted-envelope",
    kekVersion: "v1",
    nonce: "nonce-654321",
  });
  assert.equal(answerRevision, 2);
  await assertImmediate(store, answerBugId, "42.000001", answerRevision);
} finally {
  globalThis.fetch = originalFetch;
  if (started)
    await command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}

console.log(
  "PASS private delivery: PostgreSQL draft/answer atomic outbox claimed and sent once; replay silent",
);
