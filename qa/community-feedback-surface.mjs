import assert from "node:assert/strict";
import {
  feedbackPromptDue,
  parseFeedbackAnalysis,
  sendDailyFeedbackPrompt,
  startCodexFeedback,
} from "../src/community-feedback.ts";
import { withFeedbackAction } from "../src/community-social.ts";

const augmented = withFeedbackAction("chat.postMessage", {
  channel: "CQA",
  text: "기존 봇 응답",
});
assert.equal(augmented.text, "기존 봇 응답");
assert.equal(augmented.blocks[0].text.text, "기존 봇 응답");
assert.equal(augmented.blocks.at(-1).elements[0].action_id, "community_bug_open");
assert.equal(augmented.blocks.at(-1).elements[0].text.text, "피드백 남기기");
assert.deepEqual(withFeedbackAction("chat.postMessage", { channel: "DQA", text: "DM" }), {
  channel: "DQA",
  text: "DM",
});
assert.equal(feedbackPromptDue("17:59"), false);
assert.equal(feedbackPromptDue("18:00"), true);
assert.equal(feedbackPromptDue("18:05"), true);
assert.equal(feedbackPromptDue("18:06"), false);
assert.deepEqual(
  parseFeedbackAnalysis({
    kind: "defect",
    summary: "버튼이 문서와 다르게 저장되지 않음",
    missing: ["trigger", "invented"],
    docRefs: ["docs/SPEC.md", "README.md"],
  }),
  {
    kind: "defect",
    summary: "버튼이 문서와 다르게 저장되지 않음",
    missing: ["trigger"],
    docRefs: ["docs/SPEC.md"],
  },
);

const calls = [];
let queueAccepted = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsedUrl = new URL(url);
  const method = parsedUrl.pathname.split("/").at(-1);
  const body = options.body ? JSON.parse(options.body) : null;
  const authorization = options.headers?.Authorization ?? options.headers?.authorization ?? "";
  calls.push({ method, body, authorization });
  if (method === "users.info")
    return Response.json({ ok: true, user: { id: "UADMIN", is_admin: true, is_owner: false } });
  if (parsedUrl.hostname === "api.github.com") return Response.json({ sha: "a".repeat(40) });
  if (method === "sql")
    return Response.json({
      rows: [
        [
          JSON.stringify({
            accepted: queueAccepted,
            state: queueAccepted ? "queued" : "needs_info_exhausted",
          }),
        ],
      ],
    });
  if (method === "chat.postMessage") return Response.json({ ok: true, ts: "123.456" });
  throw new Error(`unexpected ${method}`);
};
try {
  const promptRecords = new Map();
  const promptStore = {
    async putRecord(input) {
      if (!promptRecords.has(input.key))
        promptRecords.set(input.key, { ...input, status: "pending" });
      return promptRecords.get(input.key);
    },
    async claimRecord(input) {
      const record = promptRecords.get(input.key);
      if (record?.status !== "pending") return false;
      record.status = "claimed";
      return true;
    },
    async finishRecord(input, status) {
      promptRecords.get(input.key).status = status;
      return true;
    },
  };
  const promptEnv = {
    SLACK_TEAM_ID: "TQA",
    SLACK_BOT_TOKEN: "fake",
    COMMUNITY_ADMIN_ID: "UADMIN",
    COMMUNITY_FEEDBACK_CHANNEL_ID: "CFEEDBACK",
  };
  assert.equal(await sendDailyFeedbackPrompt(promptEnv, promptStore, "2026-09-23", "18:02"), true);
  assert.equal(await sendDailyFeedbackPrompt(promptEnv, promptStore, "2026-09-23", "18:03"), false);
  assert.match(
    calls.find((call) => call.method === "chat.postMessage")?.body.text ?? "",
    /아래 버튼으로 편하게 남겨주세요\. 필요한 내용은 최대 세 번만 더 여쭙고, 확인된 의견은 적극 반영할게요!$/,
  );
  await startCodexFeedback(
    {
      env: {
        DATABASE_URL:
          "postgresql://runtime:secret@ep-example-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
        SLACK_BOT_TOKEN: "fake",
        BUG_RUNNER_ENABLED: "true",
        COMMUNITY_CODEX_REPOSITORY: "Betalgeuse/otl1",
        COMMUNITY_CODEX_BRANCH: "main",
        COMMUNITY_FEEDBACK_CHANNEL_ID: "CFEEDBACK",
      },
      scope: { teamId: "TQA", channelId: "CFEEDBACK", userId: "UADMIN" },
      source: "123.100",
      thread: "123.100",
      date: "2026-09-23",
      key: "interaction:start",
      store: {},
    },
    {
      feedbackId: "BUG-ABCDEF123456",
      publicAlias: "B-1234",
      sourceChannel: "CORIGIN",
      sourceThread: "111.222",
      reporterId: "UREPORTER",
      packetRevision: 2,
    },
  );
  const post = calls.find(
    (call) => call.method === "chat.postMessage" && call.body.text.includes("GenQuant 작업 대기열"),
  );
  assert.equal(post.body.thread_ts, "123.100");
  assert.match(post.body.text, /자동 병합은 하지 않습니다/);
  assert.equal(post.authorization, "Bearer fake");
  assert.equal(calls.find((call) => call.method === "users.info")?.authorization, "Bearer fake");
  const queueCall = calls.find((call) => call.method === "sql");
  assert.match(queueCall.body.params[0], /"reporterId":"UREPORTER"/);
  assert.match(queueCall.body.params[0], new RegExp(`"baseSha":"${"a".repeat(40)}"`));
  queueAccepted = false;
  const postsBeforeMismatch = calls.filter((call) => call.method === "chat.postMessage").length;
  await assert.rejects(
    () =>
      startCodexFeedback(
        {
          env: {
            DATABASE_URL:
              "postgresql://runtime:secret@ep-example-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
            SLACK_BOT_TOKEN: "fake",
            BUG_RUNNER_ENABLED: "true",
            COMMUNITY_CODEX_REPOSITORY: "Betalgeuse/otl1",
            COMMUNITY_CODEX_BRANCH: "main",
          },
          scope: { teamId: "TQA", channelId: "CFEEDBACK", userId: "UADMIN" },
          thread: "123.100",
        },
        {
          feedbackId: "BUG-MISMATCH",
          publicAlias: "mismatch",
          sourceChannel: "CORIGIN",
          sourceThread: "111.222",
          reporterId: "UREPORTER",
          packetRevision: 2,
        },
      ),
    /확정된 버그 명세만 자동 작업에 넣을 수 있어요/,
  );
  assert.equal(
    calls.filter((call) => call.method === "chat.postMessage").length,
    postsBeforeMismatch,
  );
  console.log(
    "PASS feedback surface: every channel bot post gets intake, 18:00 is due, admin queues a SHA-bound GenQuant handoff",
  );
} finally {
  globalThis.fetch = originalFetch;
}
