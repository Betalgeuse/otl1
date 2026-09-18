import assert from "node:assert/strict";
import { runCommunitySchedule } from "../src/community-scheduler.ts";

let watermark = "2026-09-18T11:00:00.000Z";
let displayName = "Before QA";
const observations = [];
const dueTimes = [];
const dispatches = [];
const store = {
  async getRecord(value) {
    return value.key === "group-schedule"
      ? { body: { enabled: true, goalTime: "10:00", reviewTime: "18:00" } }
      : null;
  },
  async putRecord(value) {
    if (value.kind === "dispatch") dispatches.push(value);
    return { ...value, status: "sent" };
  },
  async claimRecord() {
    return false;
  },
  async finishRecord() {
    return false;
  },
  async reminderTriggerDue(_teamId, _channelId, now) {
    dueTimes.push(now);
    return false;
  },
  async reconcileChannelMembers(_scope, snapshot) {
    observations.push(snapshot.observedAt);
    if (snapshot.observedAt <= watermark) return false;
    watermark = snapshot.observedAt;
    displayName = snapshot.members[0].displayName;
    return true;
  },
  async claimCommonDelivery() {
    return null;
  },
  async finishCommonDelivery() {
    return false;
  },
  async claimReminderBatch() {
    return null;
  },
  async pruneReminderBatch() {
    return null;
  },
  async finishReminderBatch() {
    return false;
  },
};
let profileName = "Observed at 21";
let posts = 0;
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "conversations.members")
      return Response.json({ ok: true, members: ["UONE"], response_metadata: { next_cursor: "" } });
    if (method === "users.info")
      return Response.json({
        ok: true,
        user: {
          id: "UONE",
          real_name: profileName,
          deleted: false,
          is_bot: false,
          is_app_user: false,
        },
      });
    if (method === "emoji.list") return Response.json({ ok: true, emoji: {} });
    posts += 1;
    return Response.json({ ok: true, ts: "unexpected" });
  };
  const env = {
    SLACK_TEAM_ID: "TQA",
    SLACK_BOT_TOKEN: "token",
    COMMUNITY_CHANNEL_ID: "CPUBLIC",
    COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
    COMMUNITY_BOT_USER_ID: "UBOT",
    COMMUNITY_ADMIN_ID: "UADMIN",
  };
  const evaluation = new Date("2026-09-18T09:00:00.000Z");
  assert.deepEqual(
    await runCommunitySchedule(env, store, evaluation, {
      now: () => new Date("2026-09-18T12:00:00.000Z"),
    }),
    { common: 0, personal: 0 },
  );
  assert.equal(watermark, "2026-09-18T12:00:00.000Z");
  assert.equal(displayName, "Observed at 21");
  profileName = "Stale at 19";
  assert.deepEqual(
    await runCommunitySchedule(env, store, evaluation, {
      now: () => new Date("2026-09-18T10:00:00.000Z"),
    }),
    { common: 0, personal: 0 },
  );
  assert.deepEqual(observations, ["2026-09-18T12:00:00.000Z", "2026-09-18T10:00:00.000Z"]);
  assert.equal(watermark, "2026-09-18T12:00:00.000Z");
  assert.equal(displayName, "Observed at 21");
  assert.deepEqual(dueTimes, [evaluation.toISOString(), evaluation.toISOString()]);
  assert.ok(
    dispatches.every(
      (record) => record.key === "common:2026-09-18:review" && record.body.date === "2026-09-18",
    ),
  );
  assert.equal(posts, 0);
  console.log(
    "PASS admin replay separates configured schedule time from monotonic current membership observation",
  );
} finally {
  globalThis.fetch = originalFetch;
}
