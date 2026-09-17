import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { bugQuestionTemplate } from "../src/community-bug-delivery.ts";
import { advanceBugDialogue } from "../src/community-bug-dialogue.ts";
import {
  appendBugAnswer,
  bugCandidate,
  bugFieldsForDatabase,
  initialBugFieldsForDatabase,
  storedBugFields,
} from "../src/community-bug-facts.ts";
import { writeBugPrivateObject } from "../src/community-bug-private.ts";
import { resumeBugDialogue } from "../src/community-bug-resume.ts";
import { continueBugReport } from "../src/community-bug-session.ts";
import { bugDialogueInput } from "../src/community-bug-session-state.ts";
import { CommunityBugStore } from "../src/community-bug-store.ts";
import { CommunityStore } from "../src/community-store.ts";
import { NeonStore } from "../src/store.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp("/tmp/otl1-bug-resume-");
const data = join(temp, "pgdata");
const socket = join(temp, "socket");
const port = String(63000 + Math.floor(Math.random() * 1000));
const pgEnv = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const databaseUrl = "postgresql://qa:qa@bug-resume.neon.tech/db";
const originalFetch = globalThis.fetch;
const objects = new Map();
const slackCalls = [];
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const key = btoa(String.fromCharCode(...keyBytes));

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

function message(id, text) {
  return { id, text, at: "2026-09-17T09:00:00+09:00" };
}

function questionEvidence(questionId, field, question, answerRevision) {
  return {
    answerRevision,
    completenessResult: "needs_info",
    questionId,
    fieldName: field,
    templateVersion: bugQuestionTemplate(field),
    questionText: question.text,
  };
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
    "022_bug_private_read",
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
    const method = target.pathname.slice(5);
    if (method === "conversations.replies" || method === "conversations.history")
      return Response.json({ ok: true, messages: [] });
    slackCalls.push({ method, body });
    const ts = `50.${String(slackCalls.length).padStart(6, "0")}`;
    return Response.json({ ok: true, ts, message_ts: ts });
  };

  const bugId = "BUG-RESUMEPG001";
  const thread = "50.000001";
  const env = {
    SLACK_TEAM_ID: "T-RESUME",
    SLACK_BOT_TOKEN: "test",
    DATABASE_URL: databaseUrl,
    COMMUNITY_CHANNEL_ID: "C-ADMIN",
    BUG_PRIVATE_KEK: key,
    BUG_PRIVATE_KEK_VERSION: "qa-v1",
    BUG_PRIVATE_OBJECTS: {
      async put(objectKey, body) {
        objects.set(objectKey, new Uint8Array(body));
      },
      async get(objectKey) {
        const body = objects.get(objectKey);
        return body
          ? {
              async arrayBuffer() {
                return body.slice().buffer;
              },
            }
          : null;
      },
      async delete(objectKey) {
        objects.delete(objectKey);
      },
    },
  };
  const scope = { teamId: "T-RESUME", channelId: "C-REPORT", userId: "U-REPORTER" };
  const communityStore = new CommunityStore(new NeonStore(databaseUrl));
  const context = {
    env,
    scope,
    store: communityStore,
    date: "2026-09-17",
    source: thread,
    thread,
    key: `incoming:${thread}`,
  };
  const bugStore = new CommunityBugStore(new NeonStore(databaseUrl));
  let parsed = {
    messages: [
      message("actual", "탈퇴한 계정이 정기 후기 수집 때 멘션돼요"),
      message("freq", "항상"),
      message("impact", "불편"),
    ],
    candidates: [
      bugCandidate("actual", "actual", "탈퇴한 계정이 정기 후기 수집 때 멘션돼요"),
      { ...bugCandidate("frequency", "freq", "항상"), value: "always" },
      { ...bugCandidate("impact", "impact", "불편"), value: "inconvenience" },
    ],
  };
  const source = { kind: "slack_thread", opaqueRef: `slack:T-RESUME:C-REPORT:${thread}` };
  let dialogue = await advanceBugDialogue({
    bugId,
    expectedRevision: 1,
    currentRevision: 1,
    source,
    messages: parsed.messages,
    candidates: parsed.candidates,
    now: "2026-09-17T09:00:00+09:00",
  });
  assert.equal(dialogue.status, "needs_info");
  assert.equal(dialogue.question.field, "expected");
  const encrypted = await writeBugPrivateObject(context, bugId, 1, { parsed });
  const created = await bugStore.createDraft({
    ...encrypted,
    bugId,
    teamId: scope.teamId,
    publicAlias: "B-RESUMEPG001",
    reporterId: scope.userId,
    source: "slack",
    sourceOpaqueRef: source.opaqueRef,
    sourceChannelId: scope.channelId,
    sourceThread: thread,
    idempotencyKey: "resume-pg-draft",
    sanitizedFields: {
      title: "resume fixture",
      ...initialBugFieldsForDatabase(storedBugFields(dialogue.packet), false),
    },
  });
  const q1 = `${bugId}:q1:expected`;
  await bugStore.transition({
    bugId,
    toState: "needs_info",
    actors: ["deterministic_worker"],
    guard: { missingRequiredField: true },
    evidence: {
      reasonCodes: ["missing:expected"],
      questionId: q1,
      fieldName: "expected",
      templateVersion: bugQuestionTemplate("expected"),
      questionText: dialogue.question.text,
    },
    expectedRevision: created.revision,
    idempotencyKey: "resume-pg-q1",
  });

  async function answerAndRead(field, answer, sourceId) {
    const before = await bugStore.getDraft({
      teamId: scope.teamId,
      bugId,
      reporterId: scope.userId,
    });
    const question = before.questions.findLast((item) => !item.answered);
    assert.equal(question.fieldName, field);
    parsed = appendBugAnswer(parsed, field, sourceId, answer);
    dialogue = await advanceBugDialogue(bugDialogueInput(before, parsed));
    const revision = before.packetRevision + 1;
    const stored = await writeBugPrivateObject(context, bugId, revision, { parsed });
    const packetRevision = await bugStore.answerRevision({
      ...stored,
      bugId,
      reporterId: scope.userId,
      questionId: question.questionId,
      answerDigest: "b".repeat(64),
      answerOpaqueRef: stored.opaqueRef,
      expectedPacketRevision: before.packetRevision,
      idempotencyKey: `answer:${sourceId}`,
      privacy: false,
      sanitizedFields: bugFieldsForDatabase(storedBugFields(dialogue.packet), false),
      completeness: { status: dialogue.status },
    });
    return {
      packetRevision,
      draft: await bugStore.getDraft({ teamId: scope.teamId, bugId, reporterId: scope.userId }),
      dialogue,
    };
  }

  let turn = await answerAndRead("expected", "현재 멤버만 멘션되어야 해요", "answer-expected");
  const q2 = `${bugId}:q2:steps`;
  await bugStore.transition({
    bugId,
    toState: "needs_info",
    actors: ["reporter", "deterministic_worker"],
    guard: { stillIncomplete: true },
    evidence: questionEvidence(q2, "steps", turn.dialogue.question, turn.packetRevision),
    expectedRevision: turn.draft.revision,
    idempotencyKey: "resume-pg-q2",
  });
  turn = await answerAndRead("steps", "사용자 동작 없음\n후기 수집 트리거 실행", "answer-steps");
  const q3 = `${bugId}:q3:location`;
  await bugStore.transition({
    bugId,
    toState: "needs_info",
    actors: ["reporter", "deterministic_worker"],
    guard: { stillIncomplete: true },
    evidence: questionEvidence(q3, "location", turn.dialogue.question, turn.packetRevision),
    expectedRevision: turn.draft.revision,
    idempotencyKey: "resume-pg-q3",
  });
  turn = await answerAndRead("location", "#ot1l-daily-scrum", "answer-location");
  assert.equal(turn.packetRevision, 4);
  assert.equal(turn.draft.questions.length, 3);
  assert.equal(
    turn.draft.questions.every((question) => question.answered),
    true,
  );

  const objectSnapshot = [...objects.entries()].map(([objectKey, bytes]) => [
    objectKey,
    Buffer.from(bytes).toString("base64"),
  ]);
  await resumeBugDialogue(context, turn.draft);
  const resumed = await bugStore.getDraft({
    teamId: scope.teamId,
    bugId,
    reporterId: scope.userId,
  });
  const q4 = resumed.questions.findLast((question) => !question.answered);
  assert.equal(q4.questionId, `${bugId}:q4:occurredAt`);
  assert.equal(q4.fieldName, "occurredAt");
  const resumeEvent = JSON.parse(
    (
      await psql([
        "-Atc",
        `SELECT jsonb_build_object('actors',actors,'evidence',evidence) FROM otl.bug_events WHERE bug_id='${bugId}' AND idempotency_key='resume:${bugId}:4:4'`,
      ])
    ).stdout.trim(),
  );
  assert.deepEqual(resumeEvent.actors, ["reporter", "deterministic_worker"]);
  assert.equal(resumeEvent.evidence.answerRevision, 4);
  assert.equal(resumeEvent.evidence.completenessResult, "needs_info");
  assert.equal(slackCalls.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.deepEqual(
    [...objects.entries()].map(([objectKey, bytes]) => [
      objectKey,
      Buffer.from(bytes).toString("base64"),
    ]),
    objectSnapshot,
  );

  await resumeBugDialogue(context, turn.draft);
  await continueBugReport(
    { ...context, source: "50.000002", key: "incoming:50.000002" },
    "버그 제보 계속",
  );
  assert.equal(slackCalls.filter((call) => call.method === "chat.postMessage").length, 1);
  const counts = JSON.parse(
    (
      await psql([
        "-Atc",
        `SELECT jsonb_build_object(
      'q4',(SELECT count(*) FROM otl.bug_questions WHERE bug_id='${bugId}' AND question_id='${bugId}:q4:occurredAt'),
      'deliveries',(SELECT count(*) FROM otl.bug_deliveries WHERE bug_id='${bugId}' AND question_id='${bugId}:q4:occurredAt' AND status='sent'),
      'jobs',(SELECT count(*) FROM otl.bug_jobs WHERE bug_id='${bugId}'),
      'questionCount',(SELECT question_count FROM otl.bug_reports WHERE bug_id='${bugId}'))`,
      ])
    ).stdout.trim(),
  );
  assert.deepEqual(counts, { q4: 1, deliveries: 1, jobs: 0, questionCount: 4 });
  assert.deepEqual(
    [...objects.entries()].map(([objectKey, bytes]) => [
      objectKey,
      Buffer.from(bytes).toString("base64"),
    ]),
    objectSnapshot,
  );
} finally {
  globalThis.fetch = originalFetch;
  if (started) await command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}

console.log(
  "PASS bug resume PG: q1-q3 answered -> q4 once; continue replay silent; R2 unchanged; jobs zero",
);
