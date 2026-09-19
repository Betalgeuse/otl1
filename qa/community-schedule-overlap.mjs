import assert from "node:assert/strict";
import { runCommunitySchedule } from "../src/community-scheduler.ts";

const posts = [];
let commonPending = null;
let commonClaimed = false;
let reminderClaimed = false;
const store = {
  async getRecord(value) {
    return value.key === "group-schedule"
      ? { body: { enabled: true, goalTime: "11:00", reviewTime: "20:00" } }
      : null;
  },
  async putRecord(value) {
    if (value.kind === "dispatch" && !commonPending) commonPending = value;
    return { ...value, status: "pending" };
  },
  async claimRecord() {
    return false;
  },
  async finishRecord() {
    return false;
  },
  async reminderTriggerDue() {
    return true;
  },
  async reconcileChannelMembers() {
    return true;
  },
  async members() {
    return ["U1"];
  },
  async claimCommonDelivery(input) {
    if (!commonPending || commonClaimed) return null;
    commonClaimed = true;
    return {
      leaseToken: input.leaseToken,
      attempt: 1,
      firstAttemptAt: input.now,
      key: commonPending.key,
      ...commonPending.body,
    };
  },
  async finishCommonDelivery() {
    return true;
  },
  async claimReviewReminderBatch() {
    return null;
  },
  async claimGoalReminderBatch(input) {
    if (reminderClaimed) return null;
    reminderClaimed = true;
    return {
      leaseToken: input.leaseToken,
      attempt: 1,
      firstAttemptAt: input.now,
      jobs: [
        {
          teamId: "TQA",
          channelId: "CPUBLIC",
          userId: "U1",
          key: "reminder:2026-09-18:goal",
          date: "2026-09-18",
          kind: "goal",
        },
      ],
    };
  },
  async pruneReminderBatch() {
    return null;
  },
  async finishReminderBatch() {
    return true;
  },
  async finishReviewReminderBatch() {
    return true;
  },
  async finishReviewRoot() {
    return true;
  },
};
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "conversations.members")
      return Response.json({ ok: true, members: ["U1", "UDORM"], response_metadata: { next_cursor: "" } });
    if (method === "users.info")
      return Response.json({
        ok: true,
        user: { id: new URL(url).searchParams.get("user"), name: "member", deleted: false, is_bot: false, is_app_user: false },
      });
    if (method === "emoji.list") return Response.json({ ok: true, emoji: {} });
    posts.push(JSON.parse(options.body));
    return Response.json({ ok: true, ts: `300.${posts.length}` });
  };
  assert.deepEqual(
    await runCommunitySchedule(
      {
        SLACK_TEAM_ID: "TQA",
        SLACK_BOT_TOKEN: "token",
        COMMUNITY_CHANNEL_ID: "CPUBLIC",
        COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
        COMMUNITY_BOT_USER_ID: "UBOT",
        COMMUNITY_ADMIN_ID: "UADMIN",
      },
      store,
      new Date("2026-09-18T02:00:00Z"),
    ),
    { common: 1, personal: 1 },
  );
  assert.equal(posts.length, 2);
  assert.equal(posts.filter((post) => /알림 설정/.test(post.text)).length, 1);
  assert.equal(posts.filter((post) => /오늘의 \*ONE THING\*/.test(post.text)).length, 1);
  const common = posts.find((post) => /오늘의 \*ONE THING\*/.test(post.text));
  assert.match(common.text, /<@U1>/);
  assert.doesNotMatch(common.text, /<@UDORM>/);
  console.log(
    "PASS schedule overlap: common and personal due at the same KST minute each post exactly once",
  );
} finally {
  globalThis.fetch = originalFetch;
}
