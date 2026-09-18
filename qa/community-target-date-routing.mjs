import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mock } from "bun:test";

const days = new Map();
const records = new Map();
const changes = [];
const slackCalls = [];
const intentCalls = [];
const published = [];

const dayKey = ({ teamId, channelId, userId, date }) =>
  `${teamId}:${channelId}:${userId}:${date}`;
const recordKey = ({ teamId, channelId, userId, key }) =>
  `${teamId}:${channelId}:${userId}:${key}`;
const emptyDay = (scope) => ({
  ...scope,
  goal: "",
  outcome: "pending",
  reflection: "",
  resting: false,
  revision: 0,
});

class FakeCommunityStore {
  async day(scope) {
    return days.get(dayKey(scope)) ?? emptyDay(scope);
  }
  async history(scope) {
    return [...days.values()].filter(
      (day) =>
        day.teamId === scope.teamId &&
        day.channelId === scope.channelId &&
        day.userId === scope.userId,
    );
  }
  async getRecord(scope) {
    return records.get(recordKey(scope)) ?? null;
  }
  async listRecords(scope, kind) {
    return [...records.values()].filter(
      (record) =>
        record.teamId === scope.teamId &&
        record.channelId === scope.channelId &&
        record.userId === scope.userId &&
        record.kind === kind,
    );
  }
  async putRecord(input) {
    const key = recordKey(input);
    if (!records.has(key)) records.set(key, { ...input, status: "pending" });
    return records.get(key);
  }
  async claimRecord(input) {
    const record = records.get(recordKey(input));
    if (!record || record.status !== "pending") return false;
    record.status = "claimed";
    return true;
  }
  async finishRecord(input, status) {
    const record = records.get(recordKey(input));
    if (!record) return false;
    record.status = status;
    return true;
  }
  async change(input) {
    const key = dayKey(input);
    const previous = days.get(key) ?? emptyDay({
      teamId: input.teamId,
      channelId: input.channelId,
      userId: input.userId,
      date: input.date,
    });
    if (previous.revision !== input.expectedRevision)
      return { day: previous, changed: false, conflict: true, firstGoal: false, firstRegistration: false, firstReflection: false, undoKey: "conflict" };
    let next;
    if (input.action === "goal") next = { ...previous, goal: input.text, revision: previous.revision + 1 };
    else if (input.action === "reflection")
      next = { ...previous, reflection: input.text, outcome: input.outcome ?? previous.outcome, revision: previous.revision + 1 };
    else next = { ...previous, outcome: input.action, revision: previous.revision + 1 };
    days.set(key, next);
    changes.push(input);
    return { day: next, changed: true, conflict: false, firstGoal: false, firstRegistration: false, firstReflection: false, undoKey: `undo-${changes.length}` };
  }
}

mock.module("../src/community-store.ts", () => ({ CommunityStore: FakeCommunityStore }));
mock.module("../src/community-clock.ts", () => ({ CommunityClock: class {}, armCommunityClock: async () => {} }));
mock.module("../src/community-bugs.ts", () => ({
  handleBugReportMessage: async () => false,
  continueBugReport: async () => false,
  replayBugDelivery: async () => {},
  confirmBugReport: async () => {},
  isBugReportMessage: () => false,
  openBugReportModal: async () => {},
  parseBugReportModal: () => ({ errors: {} }),
  submitBugReportModal: async () => null,
}));
const { handleRequest } = await import("../src/index.ts");

const fixedNow = Date.parse("2026-09-17T03:00:00Z");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
Date.now = () => fixedNow;
globalThis.fetch = async (url, options = {}) => {
  const method = new URL(String(url)).pathname.split("/").at(-1);
  const body = options.body ? JSON.parse(String(options.body)) : {};
  slackCalls.push({ method, body });
  if (method === "sql") throw new Error("unexpected database fetch");
  if (method === "emoji.list") return Response.json({ ok: true, emoji: {} });
  return Response.json({ ok: true, ts: `${20 + slackCalls.length}.000001`, message_ts: `${20 + slackCalls.length}.000001` });
};

const secret = "synthetic-signing-secret";
const signedAt = Math.floor(fixedNow / 1000);
const effects = [];
const env = {
  COMMUNITY_ENABLED: "true",
  SLACK_TEAM_ID: "TQA",
  SLACK_SIGNING_SECRET: secret,
  SLACK_BOT_TOKEN: "synthetic-token",
  DATABASE_URL: "postgresql://qa:qa@ep-qa-pooler.ap-southeast-1.aws.neon.tech/qa?sslmode=require",
  BOARD_SIGNING_SECRET: "synthetic-board-secret",
  PUBLIC_BASE_URL: "https://worker.invalid",
  DAILY_SCRUM_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_CHANNEL_ID: "CADMIN",
  COMMUNITY_RELEASE_CHANNEL_ID: "CRELEASE",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_BOT_USER_ID: "UBOT",
  COMMUNITY_CLOCK: {
    getByName() {
      return {
        async armBugDelivery() { return { role: "bug_delivery", armed: true, next: null }; },
        async publishGarden(input) { published.push(input); return "30.000001"; },
      };
    },
  },
  AI: {
    async run(_model, request) {
      if (request.max_tokens !== 220) return { response: JSON.stringify({ text: "not approved" }) };
      intentCalls.push(request);
      const input = JSON.parse(request.messages.at(-1).content);
      const reflection = /일부 완료/.test(input.text);
      const partialOnly = /^부분완료[.!。！\s]*$/u.test(input.text);
      const misleadingCompletion = /파이프라인 업데이트 완료/.test(input.text);
      return {
        response: JSON.stringify(
          partialOnly
            ? { intent: "completion", outcome: "partial", goalText: null, hasReflection: false, needsConfirmation: false }
            : reflection
              ? { intent: "reflection", outcome: "partial", goalText: null, hasReflection: true, needsConfirmation: false }
            : misleadingCompletion
              ? { intent: "completion", outcome: "complete", goalText: null, hasReflection: false, needsConfirmation: false }
            : { intent: "goal", outcome: "unknown", goalText: input.text, hasReflection: false, needsConfirmation: false },
        ),
      };
    },
  },
};
const runtime = { env, store: {}, invitations: {} };
const context = { waitUntil(promise) { effects.push(promise); } };

function signedRequest(payload) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`v0:${signedAt}:${body}`).digest("hex");
  return new Request("https://worker.invalid/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(signedAt),
      "x-slack-signature": `v0=${signature}`,
    },
    body,
  });
}

async function send({ eventId, user, ts, text, thread }) {
  const payload = {
    type: "event_callback",
    team_id: "TQA",
    event_id: eventId,
    event: { type: "message", channel: "CPUBLIC", user, ts, text, ...(thread ? { thread_ts: thread } : {}) },
  };
  assert.equal((await handleRequest(signedRequest(payload), runtime, context)).status, 200);
  await Promise.all(effects.splice(0));
  return payload;
}

try {
  const sameDay = await send({ eventId: "E-SAME", user: "UCASEA", ts: `${signedAt}.100001`, text: "9/17: ONE THING 발표 자료 한 장 정리" });
  await send({ eventId: "E-SAME-REPLAY", user: sameDay.event.user, ts: sameDay.event.ts, text: sameDay.event.text });
  await send({ eventId: "E-CHAPTER", user: "UCASEB", ts: `${signedAt}.100002`, text: "CS 교재 10.4, 10.10, 10.6-10.9 복습" });
  const reasonGoal = await send({ eventId: "E-REASON", user: "UCASEC", ts: `${signedAt}.100003`, text: "오늘 ONE THING: 보고서 마무리\n이유: 어제 못 끝내서" });
  await send({ eventId: "E-PARTIAL", user: "UCASEC", ts: `${signedAt}.100004`, thread: reasonGoal.event.ts, text: "일부 완료했어요. 어제보다 범위를 줄이니 진도가 났어요." });
  await send({ eventId: "E-HISTORICAL", user: "UCASED", ts: `${signedAt}.100005`, text: "9월 16일 완료 처리" });

  const explicitText = "원씽: 파이프라인 업데이트 완료 (진짜)\n사유: 합성 검증 사유";
  const beforeExplicitSlack = slackCalls.length;
  const explicit = await send({ eventId: "E-EXPLICIT", user: "UCASEE", ts: `${signedAt}.100006`, text: explicitText });
  const afterExplicitSlack = slackCalls.length;
  const beforeRepeatPublished = published.length;
  const repeated = await send({ eventId: "E-EXPLICIT-REPEAT", user: explicit.event.user, ts: `${signedAt}.100007`, text: explicitText });
  assert.equal(published.length, beforeRepeatPublished, "exact explicit repeat publishes no new card");
  assert.equal(slackCalls.length, afterExplicitSlack, "exact explicit repeat causes no Slack side effect");
  assert.equal(changes.filter((change) => change.userId === "UCASEE").length, 1, "exact explicit repeat causes no new change");
  assert.equal(records.has(recordKey({ teamId: "TQA", channelId: "CPUBLIC", userId: repeated.event.user, key: `pending:incoming:${repeated.event.ts}` })), false, "exact explicit repeat creates no pending outcome or edit");
  assert.equal(changes.find((change) => change.userId === "UCASEE")?.text, "파이프라인 업데이트 완료 (진짜)");
  assert.ok(afterExplicitSlack > beforeExplicitSlack, "first explicit goal follows normal apply path");

  const beforeDifferent = changes.length;
  const different = await send({ eventId: "E-EXPLICIT-DIFFERENT", user: explicit.event.user, ts: `${signedAt}.100008`, text: "목표: 다른 합성 목표" });
  assert.equal(changes.length, beforeDifferent, "different explicit goal never overwrites existing goal");
  assert.equal(slackCalls.at(-1)?.method, "chat.postEphemeral", "different explicit goal keeps edit confirmation");
  assert.equal(records.get(recordKey({ teamId: "TQA", channelId: "CPUBLIC", userId: different.event.user, key: `pending:incoming:${different.event.ts}` }))?.body.action, "goal", "different explicit goal remains a goal edit confirmation");

  await send({ eventId: "E-EXPLICIT-EDIT-WORD", user: "UCASEF", ts: `${signedAt}.100009`, text: "원씽: 코드 수정 완료\n사유: 합성 검증" });
  assert.equal(changes.find((change) => change.userId === "UCASEF")?.text, "코드 수정 완료", "explicit marker outranks edit words inside the title");

  assert.equal(changes.length, 6, "five goals and one reflection are the only canonical changes");
  assert.equal(changes.filter((change) => change.userId === "UCASEA").length, 1, "replay is idempotent");
  const partial = changes.find((change) => change.userId === "UCASEC" && change.action === "reflection");
  assert.equal(partial?.outcome, "partial");
  const beforeDuplicatePartial = { changes: changes.length, published: published.length, slack: slackCalls.length };
  await send({ eventId: "E-PARTIAL-DUP", user: "UCASEC", ts: `${signedAt}.100010`, thread: reasonGoal.event.ts, text: "부분완료" });
  assert.deepEqual(
    { changes: changes.length, published: published.length, slack: slackCalls.length },
    beforeDuplicatePartial,
    "duplicate equal outcome creates no event, reaction, question or garden card",
  );
  assert.equal(
    changes.filter((change) => change.userId === "UCASEC" && change.action === "reflection").length,
    1,
    "first partial reflection creates exactly one event",
  );
  assert.equal(
    published.filter((item) => item.userId === "UCASEC").length,
    2,
    "goal and first partial each create one card; duplicate creates none",
  );

  const numericGoal = await send({ eventId: "E-NUMERIC-GOAL", user: "UCASEG", ts: `${signedAt}.100011`, text: "원씽: 숫자 후기 검증" });
  const beforeNumeric = changes.length;
  await send({ eventId: "E-NUMERIC-REVIEW", user: "UCASEG", ts: `${signedAt}.100012`, thread: numericGoal.event.ts, text: "후기: 3시간 정리 ABC123" });
  const numericReview = changes.at(-1);
  assert.equal(changes.length, beforeNumeric + 1);
  assert.equal(numericReview.action, "reflection");
  assert.equal(numericReview.text, "3시간 정리 ABC123");
  assert.equal(numericReview.date, "2026-09-17");
  assert.equal(intentCalls.length, 4, "explicit goals, numeric 후기 and protected historical edits avoid unnecessary Qwen calls");
  assert.equal(published.length, 8);
  assert.equal(slackCalls.some((call) => String(call.body.text ?? "").includes("날짜가 있는 수행 기록")), false);
  assert.equal(slackCalls.some((call) => String(call.body.text ?? "").includes("수정할 ONE THING이 없어요")), true);
  console.log("PASS signed Slack routing: incidental dates save once, partial reflection follows its thread, historical edit stays protected");
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}
