import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const base = { teamId: `QA-${randomUUID()}`, channelId: "admin", userId: "owner", date: "2026-09-11" };
async function call(op, input = {}) {
  const payload = JSON.stringify({ ...(op === "preferences" ? {goalTime:"10:00",reviewTime:"18:00"} : {}), ...base, now: "2026-09-11T09:30:00Z", ...input }).replaceAll("'", "''");
  const { stdout } = await exec("psql", ["-h", process.env.COMMUNITY_PG_SOCKET ?? "/tmp/otl-community-pg", "-p", process.env.COMMUNITY_PG_PORT ?? "55439", "-d", process.env.COMMUNITY_PG_DATABASE ?? "postgres", "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", `DO $$ BEGIN IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='otl' AND table_name='community_preferences' AND column_name='eligible_from') THEN UPDATE otl.community_preferences SET eligible_from='2026-09-10' WHERE team_id='${base.teamId}'; END IF; END $$; SELECT otl.community_execute('${op}','${payload}'::jsonb)`]);
  return JSON.parse(stdout);
}

const first = await call("change", { action: "goal", key: "goal", text: "논문 서론을 모두 읽고 의문점 세 가지 정리하기" });
assert.equal(first.day.goal, "논문 서론을 모두 읽고 의문점 세 가지 정리하기");
assert.equal(first.firstGoal, false);
assert.equal((await call("change", { action: "goal", key: "goal", text: "duplicate" })).changed, false);
assert.equal((await call("day", { channelId: "public" })).goal, "");

const reflection = await call("change", { action: "reflection", key: "reflection", text: "절반 했고 어려웠어요", outcome: "partial" });
assert.equal(reflection.day.outcome, "partial");
assert.equal(reflection.firstReflection, true);
const complete = await call("change", { action: "complete", key: "complete" });
assert.equal(complete.firstGoal, true);
assert.equal(complete.day.reflection, reflection.day.reflection);
const undone = await call("change", { action: "undo", key: "undo", undoKey: "complete" });
assert.equal(undone.day.outcome, "partial");
assert.equal((await call("change", { action: "complete", key: "complete-again" })).firstGoal, false);
assert.equal((await call("change", { action: "undo", key: "stale", undoKey: "reflection" })).conflict, true);

const revision = (await call("day")).revision;
const concurrent = await Promise.all(["a", "b"].map((key) => call("change", { key, action: "rest", expectedRevision: revision })));
assert.equal(concurrent.filter((x) => x.changed).length, 1);
assert.equal(concurrent.filter((x) => x.conflict).length, 1);
const restReview = await call("change", { action: "reflection", key: "rest-review", text: "오늘은 돌아볼게요" });
assert.equal(restReview.day.resting, true);
const resumedReview = await call("change", { action: "reflection", key: "resume-review", text: "쉬다가 절반 진행했어요", outcome: "partial" });
assert.equal(resumedReview.day.resting, false);

await call("preferences", { userId: "remind", enabled: true, goalTime: "09:00", reviewTime: "18:00" });
let jobs = await call("due", { now: "2026-09-11T09:30:00Z" });
assert.equal(jobs.length, 1);
const job = jobs[0];
assert.equal((await call("due", { now: "2026-09-11T13:01:00Z" })).length, 0);
assert.equal(await call("claim_reminder", { ...job, now: "2026-09-11T13:01:00Z" }), false);
await call("change", { userId: "remind", action: "goal", key: "late-goal", text: "운동" });
assert.equal(await call("claim_reminder", job), false);
jobs = await call("due", { now: "2026-09-11T09:30:00Z" });
assert.equal(jobs.length, 1);
assert.equal(jobs[0].kind, "review");
const claims = await Promise.all([call("claim_reminder", jobs[0]), call("claim_reminder", jobs[0])]);
assert.equal(claims.filter(Boolean).length, 1);
assert.equal(await call("finish_record", { ...jobs[0], status: "sent" }), true);
assert.equal((await call("due", { now: "2026-09-11T09:30:00Z" })).length, 0);
await call("preferences", { userId: "stopped", enabled: true });
const stoppedJob = (await call("due", { now: "2026-09-11T09:30:00Z" })).find((x) => x.userId === "stopped");
await call("preferences", { userId: "stopped", enabled: false });
assert.equal(await call("claim_reminder", stoppedJob), false);

await call("put_record", { key: "pending-confirm", kind: "pending", body: { action: "complete" } });
assert.equal(await call("get_record", { userId: "other", key: "pending-confirm" }), null);
assert.equal(await call("claim_record", { key: "pending-confirm" }), true);
assert.equal(await call("claim_record", { key: "pending-confirm" }), false);
assert.equal((await call("members")).includes("remind"), true);
async function legacy(userId) {
  const { stdout } = await exec("psql", ["-h", process.env.COMMUNITY_PG_SOCKET ?? "/tmp/otl-community-pg", "-p", process.env.COMMUNITY_PG_PORT ?? "55439", "-d", process.env.COMMUNITY_PG_DATABASE ?? "postgres", "-XAt", "-c", `SELECT otl.execute('${base.teamId}','${userId}','2026-09-11','get','2026-09-11','','{}',0)`]);
  return JSON.parse(stdout);
}
assert.equal((await legacy("owner")).goals.length, 0);
if (process.env.COMMUNITY_PG_DATABASE) await exec("psql", ["-h", process.env.COMMUNITY_PG_SOCKET ?? "/tmp/otl-community-pg", "-p", process.env.COMMUNITY_PG_PORT ?? "55439", "-d", process.env.COMMUNITY_PG_DATABASE, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", `UPDATE otl.workspaces SET primary_goal_channel_id='public' WHERE team_id='${base.teamId}'`]);
await call("change", { userId: "synced", ...(process.env.COMMUNITY_PG_DATABASE ? {channelId:"public"} : {}), action: "goal", key: "synced-goal", text: "공개 원씽", syncLegacy: true });
assert.equal((await legacy("synced")).goals[0].text, "공개 원씽");
await exec("psql", ["-h", process.env.COMMUNITY_PG_SOCKET ?? "/tmp/otl-community-pg", "-p", process.env.COMMUNITY_PG_PORT ?? "55439", "-d", process.env.COMMUNITY_PG_DATABASE ?? "postgres", "-XAt", "-c", `UPDATE otl.profiles SET complete_color='#123456',start_date='2026-09-01' WHERE team_id='${base.teamId}' AND user_id='synced'`]);
await call("change", { userId: "synced", ...(process.env.COMMUNITY_PG_DATABASE ? {channelId:"public"} : {}), action: "complete", key: "synced-complete", syncLegacy: true });
assert.equal((await legacy("synced")).goals[0].completed, true);
assert.equal((await legacy("synced")).palette.complete, "#123456");
assert.equal((await legacy("synced")).startDate, "2026-09-01");
await call("change", { userId: "synced", ...(process.env.COMMUNITY_PG_DATABASE ? {channelId:"public"} : {}), action: "undo", key: "synced-undo", undoKey: "synced-complete", syncLegacy: true });
assert.equal((await legacy("synced")).goals[0].completed, false);
await call("change", { userId: "removed", ...(process.env.COMMUNITY_PG_DATABASE ? {channelId:"public"} : {}), action: "goal", key: "removed-goal", text: "되돌릴 원씽", syncLegacy: true });
await call("change", { userId: "removed", ...(process.env.COMMUNITY_PG_DATABASE ? {channelId:"public"} : {}), action: "undo", key: "removed-undo", undoKey: "removed-goal", syncLegacy: true });
assert.equal((await legacy("removed")).goals.length, 0);
console.log("PASS community storage: channel isolation, reflection/outcome, durable idempotency, milestones, guarded undo, concurrent revision, reminders and ownership");
