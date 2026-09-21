import assert from "node:assert/strict";
const { handleShareInfoMessage } = await import("../src/community-share-info.ts");

const records = new Map();
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const method = new URL(String(url)).pathname.split("/").at(-1);
  const payload = options.body ? JSON.parse(String(options.body)) : {};
  calls.push({ method, payload });
  if (method === "emoji.list") return Response.json({ ok: true, emoji: { party_blob: "https://emoji.invalid/party" } });
  if (method === "chat.postMessage") return Response.json({ ok: true, ts: "100.2" });
  if (method === "reactions.add") return Response.json({ ok: true });
  throw new Error(`unexpected Slack method ${method}`);
};

const store = {
  async putRecord(input) {
    const prior = records.get(input.key);
    if (prior) return prior;
    const value = { ...input, status: "pending" };
    records.set(input.key, value);
    return value;
  },
  async claimRecord(input) {
    const value = records.get(input.key);
    if (!value || value.status !== "pending") return false;
    value.status = "claimed";
    return true;
  },
  async finishRecord(input, status) {
    const value = records.get(input.key);
    if (!value) return false;
    value.status = status;
    return true;
  },
};
const context = {
  env: {
    COMMUNITY_SHAREINFO_CHANNEL_ID: "CSHARE",
    SLACK_BOT_TOKEN: "xoxb-test",
    AI: {
      async run() {
        return { response: JSON.stringify({ summary: "자료의 핵심을 한 줄로 정리했어요.", thought: "이 내용을 다른 회원의 실험이나 자료와 연결하면 무엇이 달라질까요?" }) };
      },
    },
  },
  store,
  scope: { teamId: "TQA", channelId: "CSHARE", userId: "UQA" },
  thread: "100.1",
  source: "100.1",
  date: "2026-09-22",
  key: "share-info:100.1",
};

try {
  assert.equal(await handleShareInfoMessage({ type: "message", channel: "CSHARE", user: "UQA", ts: "100.1", text: "새 자료를 공유합니다." }, context), true);
  assert.equal(await handleShareInfoMessage({ type: "message", channel: "CSHARE", user: "UQA", ts: "100.1", text: "새 자료를 공유합니다." }, context), true);
  assert.equal(await handleShareInfoMessage({ type: "message", channel: "CSHARE", user: "UBOT", bot_id: "BQA", ts: "100.3", text: "봇 글" }, context), false);
  assert.equal(await handleShareInfoMessage({ type: "message", channel: "CSHARE", user: "UQA", ts: "100.4", thread_ts: "100.1", text: "답글" }, context), false);
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 2);
  assert.equal(calls.filter((call) => call.method === "reactions.add").length, 1);
  assert.match(calls.find((call) => call.method === "chat.postMessage" && call.payload.text.includes("한 줄 요약"))?.payload.thread_ts, /^100\.1$/);
  console.log("PASS Share Info: top-level human post once, emoji and thanks immediately, Qwen summary/thought in the same parent thread, bot/reply duplicates ignored");
} finally {
  globalThis.fetch = originalFetch;
}
