import assert from "node:assert/strict";
import { reconcileShareInfoChannels } from "../src/community-share-info-reconcile.ts";

const records = new Map();
const store = {
  async putRecord(input) {
    const scopedKey = `${input.channelId}:${input.key}`;
    const prior = records.get(scopedKey);
    if (prior) return prior;
    const value = { ...input, status: "pending" };
    records.set(scopedKey, value);
    return value;
  },
  async claimRecord(input) {
    const value = records.get(`${input.channelId}:${input.key}`);
    if (!value || value.status !== "pending") return false;
    value.status = "claimed";
    return true;
  },
  async finishRecord(input, status) {
    const value = records.get(`${input.channelId}:${input.key}`);
    if (!value) return false;
    value.status = status;
    return true;
  },
};
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  const method = parsed.pathname.split("/").at(-1);
  const payload = options.body
    ? JSON.parse(String(options.body))
    : Object.fromEntries(parsed.searchParams);
  calls.push({ method, payload });
  if (method === "conversations.history")
    return Response.json({
      ok: true,
      messages: [
        {
          type: "message",
          user: "UQA",
          ts: payload.channel === "CSHARE" ? "100.1" : "200.1",
          text: "놓친 정보 공유 글",
        },
        {
          type: "message",
          user: "UBOT",
          bot_id: "BQA",
          ts: "300.1",
          text: "봇 글",
        },
      ],
    });
  if (method === "emoji.list")
    return Response.json({ ok: true, emoji: { party_blob: "https://emoji.invalid/party" } });
  if (method === "reactions.add") return Response.json({ ok: true });
  if (method === "chat.postMessage") return Response.json({ ok: true, ts: "400.1" });
  throw new Error(`unexpected Slack method ${method}`);
};

try {
  const env = {
    SLACK_TEAM_ID: "TQA",
    SLACK_BOT_TOKEN: "xoxb-test",
    DATABASE_URL: "postgresql://unused.neon.tech/db",
    BOARD_SIGNING_SECRET: "board",
    PUBLIC_BASE_URL: "https://example.invalid",
    COMMUNITY_SHAREINFO_CHANNEL_ID: "CSHARE",
    COMMUNITY_CHAPTER_CHANNEL_IDS: "CSCI",
    AI: {
      async run() {
        return {
          response: JSON.stringify({
            summary: "놓친 글을 요약했어요.",
            thought: "다음 행동과 연결해 보세요.",
          }),
        };
      },
    },
  };
  assert.equal(await reconcileShareInfoChannels(env, Date.parse("2026-09-22T07:30:00Z"), store), 2);
  assert.equal(calls.filter((call) => call.method === "conversations.history").length, 2);
  assert.equal(calls.filter((call) => call.method === "reactions.add").length, 2);
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 4);
  assert.equal(await reconcileShareInfoChannels(env, Date.parse("2026-09-22T07:45:00Z"), store), 2);
  assert.equal(
    calls.filter((call) => call.method === "chat.postMessage").length,
    4,
    "reconciliation is idempotent",
  );
  console.log(
    "PASS Share Info reconciliation: recent missed Share Info and Chapter posts are recovered once every bounded scan",
  );
} finally {
  globalThis.fetch = originalFetch;
}
