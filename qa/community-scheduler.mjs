import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { CommunityStore } from "../src/community-store.ts";
import { runCommunitySchedule } from "../src/community-scheduler.ts";

const exec = promisify(execFile);
const store = new CommunityStore({
  async queryJson(_query, params) {
    const payload = params[1].replaceAll("'", "''");
    const { stdout } = await exec("psql", ["-h", "/tmp/otl-community-pg", "-p", "55439", "-d", process.env.COMMUNITY_PG_DATABASE ?? "postgres", "-XAt", "-v", "ON_ERROR_STOP=1", "-c", `SELECT otl.community_execute('${params[0]}','${payload}'::jsonb)`]);
    return JSON.parse(stdout);
  },
});
const env = { SLACK_TEAM_ID: `QA-${randomUUID()}`, SLACK_BOT_TOKEN: "test-token", COMMUNITY_CHANNEL_ID: "admin", COMMUNITY_ADMIN_ID: "owner" };
const scope = { teamId: env.SLACK_TEAM_ID, channelId: "admin", userId: "owner" };
const messages = [];
globalThis.fetch = async (url, request) => {
  if (url === "https://slack.com/api/emoji.list") return Response.json({ok:true,emoji:{party:"https://test/party",cat:"https://test/cat"}});
  assert.equal(url, "https://slack.com/api/chat.postMessage");
  const payload = JSON.parse(request.body);
  assert.equal(payload.channel, "admin");
  messages.push(payload);
  return Response.json({ ok: true, ts: `1234567.${messages.length}` });
};
const morning = new Date("2026-09-11T01:00:00Z");
assert.deepEqual(await runCommunitySchedule(env, store, morning), { common: 0, personal: 0 });
await store.setGroupSchedule(scope, { enabled: true, goalTime: "10:00", reviewTime: "18:00" });
assert.deepEqual(await runCommunitySchedule(env, store, morning), { common: 1, personal: 0 });
assert.deepEqual((await store.getRecord({ ...scope, key: "prompt:1234567.1" })).body, { date: "2026-09-11", kind: "goal" });
assert.deepEqual(await runCommunitySchedule(env, store, morning), { common: 0, personal: 0 });
await store.setGroupSchedule(scope, { enabled: false, goalTime: "10:05", reviewTime: "18:05" });
assert.equal((await store.getRecord({ ...scope, key: "group-schedule" })).body.enabled, false);
await store.preferences(scope, { enabled: true, goalTime: "10:00", reviewTime: "18:00" });
assert.deepEqual(await runCommunitySchedule(env, store, morning), { common: 0, personal: 1 });
assert.equal(messages.at(-1).thread_ts, "1234567.1");
assert.equal(messages.at(-1).blocks.some(block=>block.type==="actions"), false);
assert.match(messages.at(-1).text,/알림 설정/);
assert.deepEqual(await runCommunitySchedule(env, store, morning), { common: 0, personal: 0 });
await store.change({ ...scope, date: "2026-09-11", key: "goal", action: "goal", text: "운동" });
await store.change({ ...scope, date: "2026-09-11", key: "rest", action: "rest" });
assert.deepEqual(await runCommunitySchedule(env, store, new Date("2026-09-11T09:00:00Z")), { common: 0, personal: 0 });
assert.equal((await store.history(scope)).length, 1);
await store.preferences({ ...scope, userId: "quiet" }, { enabled: true });
assert.equal((await store.due(scope.teamId, scope.channelId, "2026-09-11T09:00:00Z")).length, 1);
const sentBeforeQuiet = messages.length;
assert.deepEqual(await runCommunitySchedule(env, store, new Date("2026-09-11T13:01:00Z")), { common: 0, personal: 0 });
assert.equal(messages.length, sentBeforeQuiet);
console.log("PASS scheduler: real PostgreSQL settings edits, KST timing, opt-in, single delivery, prompt context, threaded user mention, stop button, rest suppression");
