import assert from "node:assert/strict";
import { isKoreanPublicHoliday, isOptionalDay, isWeekend } from "../src/calendar.ts";
import { buildBoard } from "../src/board.ts";
import { unresolvedDays } from "../src/community-followup.ts";
import { runCommunitySchedule } from "../src/community-scheduler.ts";
import { koreaDate } from "../src/input.ts";

assert.equal(isWeekend("2026-09-11"), false);
assert.equal(isWeekend("2026-09-12"), true);
assert.equal(isWeekend("2026-09-13"), true);
assert.equal(isWeekend("2026-09-14"), false);
assert.equal(isKoreanPublicHoliday("2026-09-24"), true);
assert.equal(isKoreanPublicHoliday("2026-07-17"), true);
assert.equal(isKoreanPublicHoliday("2027-02-09"), true);
assert.equal(isKoreanPublicHoliday("2026-09-23"), false);
assert.equal(isOptionalDay("2026-09-24"), true);
assert.equal(koreaDate(Date.parse("2026-09-24T01:59:59+09:00") / 1000), "2026-09-23");
assert.equal(koreaDate(Date.parse("2026-09-24T02:00:00+09:00") / 1000), "2026-09-24");
const day = { teamId: "TQA", channelId: "CQA", userId: "UQA", goal: "optional goal", reflection: "", outcome: "pending", resting: false, revision: 1 };
assert.equal(unresolvedDays([{ ...day, date: "2026-09-12" }, { ...day, date: "2026-09-13" }], "2026-09-14").length, 0);
assert.equal(unresolvedDays([{ ...day, date: "2026-09-24" }], "2026-09-28").length, 0);
const board = buildBoard({ startDate: "2026-09-11", goals: [], palette: { empty: "#EBEDF0", written: "#9BE9A8", complete: "#216E39" } }, "2026-09-14");
assert.equal(board.cells[0].optional, false);
assert.deepEqual(board.cells.map((cell) => cell.date), ["2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16"]);
const holidayBoard = buildBoard({ startDate: "2026-09-23", goals: [{ date: "2026-09-24", text: "optional holiday goal", completed: false }], palette: { empty: "#EBEDF0", written: "#9BE9A8", complete: "#216E39" } }, "2026-09-28");
assert.deepEqual(holidayBoard.cells.slice(0, 3).map((cell) => cell.date), ["2026-09-23", "2026-09-24", "2026-09-28"]);
assert.equal(holidayBoard.cells[1].optional, true);

const sent = [];
const records = new Map();
let dueCalls = 0;
const scopeKey = (value) => `${value.userId}:${value.key}`;
const store = {
  async getRecord(value) {
    if (value.key === "group-schedule") return { body: { enabled: true, goalTime: "10:00", reviewTime: "18:00" } };
    return records.get(scopeKey(value)) ?? null;
  },
  async putRecord(value) {
    const key = scopeKey(value);
    if (!records.has(key)) records.set(key, { ...value, status: "pending" });
    return records.get(key);
  },
  async claimRecord() { return false; },
  async finishRecord() { return false; },
  async claimCommonDelivery(input) {
    const found = [...records.values()].find((record) => record.kind === "dispatch" && record.status === "pending");
    if (!found) return null;
    found.status = "claimed";
    return { leaseToken: input.leaseToken, attempt: 1, firstAttemptAt: input.now, key: found.key, ...found.body };
  },
  async finishCommonDelivery(input) {
    const found = [...records.values()].find((record) => record.kind === "dispatch" && record.status === "claimed");
    if (!found) return false;
    found.status = input.status;
    return true;
  },
  async reminderTriggerDue() { dueCalls += 1; return false; },
  async reconcileChannelMembers() { return true; },
  async members() { return ["UQA"]; },
  async claimReminderBatch() { return null; },
  async claimReviewReminderBatch() { return null; },
  async claimGoalReminderBatch() { return null; },
  async pruneReminderBatch() { return null; },
  async finishReminderBatch() { return false; },
  async finishReviewReminderBatch() { return false; },
  async finishReviewRoot() { return true; },
};
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const method = new URL(url).pathname.split("/").at(-1);
  if (method === "emoji.list") return Response.json({ ok: true, emoji: {} });
  if (method === "conversations.members") return Response.json({ ok: true, members: ["UQA"], response_metadata: { next_cursor: "" } });
  if (method === "users.info") return Response.json({ ok: true, user: { id: "UQA", name: "qa", is_bot: false, is_app_user: false, deleted: false } });
  sent.push(JSON.parse(options.body));
  return Response.json({ ok: true, ts: `123.${sent.length}` });
};
const env = { SLACK_TEAM_ID: "TQA", SLACK_BOT_TOKEN: "fake", COMMUNITY_CHANNEL_ID: "CQA", COMMUNITY_PUBLIC_CHANNEL_ID: "CQA", COMMUNITY_BOT_USER_ID: "UBOT", COMMUNITY_ADMIN_ID: "UQA", COMMUNITY_GUIDE_CANVAS_URL: "https://example.slack.com/docs/TQA/FGUIDE01", COMMUNITY_INTRO_CANVAS_URL: "https://example.slack.com/docs/TQA/FINTRO01" };
try {
  await runCommunitySchedule(env, store, new Date("2026-09-12T01:00:00Z"));
  await runCommunitySchedule(env, store, new Date("2026-09-12T01:00:00Z"));
  await runCommunitySchedule(env, store, new Date("2026-09-12T09:00:00Z"));
  await runCommunitySchedule(env, store, new Date("2026-09-13T01:00:00Z"));
  assert.equal(sent.length, 2, "Sunday 10:00 KST must publish its optional ONE THING prompt");
  assert.doesNotMatch(sent[0].text, /<!channel>|<!here>|<@/);
  assert.doesNotMatch(sent[1].text, /<!channel>|<!here>|<@/);
  assert.match(sent[0].text, /선택|멘션 없이/);
  assert.match(sent[1].text, /선택|멘션 없이/);
  assert.match(sent[0].text, /오늘 안에 끝낼 만큼 작고, 완료 여부가 분명한/);
  assert.match(sent[1].text, /발표 자료 준비하기.*발표 자료 1~5쪽 초안을 완성해 동료에게 공유하기/s);
  assert.deepEqual(sent[0].blocks.at(-1).elements.map((element) => element.text.text), ["사용설명서 보기", "자기소개 쓰기", "자기소개 모두 보기", "지난 후기 정리", "친구 초대하기"]);
  assert.equal(dueCalls, 0);
  await runCommunitySchedule(env, store, new Date("2026-09-14T01:00:00Z"));
  assert.equal(sent.length, 3);
  assert.match(sent.at(-1).text, /<@UQA>/);
  assert.equal(dueCalls, 1);
  await runCommunitySchedule(env, store, new Date("2026-09-24T01:00:00Z"));
  await runCommunitySchedule(env, store, new Date("2026-09-24T09:00:00Z"));
  assert.equal(sent.length, 4, "Korean public holidays publish one optional morning prompt only");
  assert.match(sent.at(-1).text, /공휴일.*선택/);
  assert.doesNotMatch(sent.at(-1).text, /<@/);
  assert.equal(dueCalls, 1, "Korean public holidays suppress personal reminders");
  console.log("PASS KST optional days: weekends and Korean public holidays get morning-only no-mention participation");
} finally {
  globalThis.fetch = original;
}
