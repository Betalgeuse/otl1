import assert from "node:assert/strict";
import { runCommunitySchedule } from "../src/community-scheduler.ts";

const jobs = [
  { teamId: "TQA", channelId: "CPUBLIC", userId: "U1", key: "reminder:2026-09-17:goal", date: "2026-09-17", kind: "goal" },
  { teamId: "TQA", channelId: "CPUBLIC", userId: "U2", key: "reminder:2026-09-17:goal", date: "2026-09-17", kind: "goal" },
  { teamId: "TQA", channelId: "CPUBLIC", userId: "U3", key: "reminder:2026-09-17:review", date: "2026-09-17", kind: "review" },
];
const finished = [];
let reconciled = 0;
const store = {
  async getRecord() { return null; },
  async putRecord() { throw new Error("unexpected put"); },
  async claimRecord() { return false; },
  async finishRecord() { return false; },
  async reminderTriggerDue() { return true; },
  async reconcileChannelMembers(_scope, snapshot) { reconciled += 1; assert.equal(snapshot.members.length, 4); },
  async claimReminderBatch() { return { leaseToken: "lease-1", attempt: 1, firstAttemptAt: "2026-09-17T09:00:00Z", jobs }; },
  async finishReminderBatch(input) { finished.push(input); return true; },
};
const env = {
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "token",
  COMMUNITY_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_BOT_USER_ID: "UBOT",
  COMMUNITY_ADMIN_ID: "UADMIN",
};
const posts = [];
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, request) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("conversations.members"))
      return Response.json({ ok: true, members: ["U1", "U2", "U3", "UBOT"], response_metadata: { next_cursor: "" } });
    if (parsed.pathname.endsWith("users.info")) {
      const id = parsed.searchParams.get("user");
      return Response.json({ ok: true, user: { id, deleted: false, is_bot: id === "UBOT", is_app_user: false } });
    }
    if (parsed.pathname.endsWith("emoji.list")) return Response.json({ ok: true, emoji: {} });
    if (parsed.pathname.endsWith("chat.postMessage")) {
      posts.push(JSON.parse(request.body));
      return Response.json({ ok: true, ts: "123.456" });
    }
    throw new Error(`unexpected ${url}`);
  };
  assert.deepEqual(await runCommunitySchedule(env, store, new Date("2026-09-17T09:00:00Z")), { common: 0, personal: 3 });
  assert.equal(reconciled, 1);
  assert.equal(posts.length, 1);
  assert.equal((posts[0].text.match(/<@U1>/g) ?? []).length, 1);
  assert.equal((posts[0].text.match(/<@U2>/g) ?? []).length, 1);
  assert.equal((posts[0].text.match(/<@U3>/g) ?? []).length, 1);
  assert.match(posts[0].text, /아직 안 적은 분/);
  assert.match(posts[0].text, /후기를 기다리는 분/);
  assert.deepEqual(finished, [{ teamId: "TQA", channelId: "CPUBLIC", leaseToken: "lease-1", status: "sent" }]);
  console.log("PASS batched reminders: one complete snapshot and one post for goal and review members");
} finally {
  globalThis.fetch = originalFetch;
}
