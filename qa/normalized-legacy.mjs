import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);
const team = `QA-normalized-${randomUUID()}`;
const scope = { teamId: team, channelId: "public", userId: "owner", date: "2026-09-11" };
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function sql(query) {
  const { stdout } = await exec("psql", [
    "-h", process.env.COMMUNITY_PG_SOCKET ?? "/tmp/otl-community-pg",
    "-p", process.env.COMMUNITY_PG_PORT ?? "55439",
    "-d", process.env.COMMUNITY_PG_DATABASE ?? "otl_normalization",
    "-XAt", "-v", "ON_ERROR_STOP=1", "-c", query,
  ]);
  return stdout.trim();
}
async function community(op, patch = {}) {
  return JSON.parse(await sql(`SELECT otl.community_execute(${quote(op)},${quote(JSON.stringify({ ...scope, ...patch }))}::jsonb)`));
}
async function legacy(action, time, text = "", patch = {}) {
  const input = { ...scope, ...patch };
  return JSON.parse(await sql(`SELECT otl.execute(${quote(input.teamId)},${quote(input.userId)},'2026-09-11',${quote(action)},${quote(input.date)},${quote(text)},${quote(JSON.stringify(input.palette ?? {}))}::jsonb,${time}::numeric)`));
}
async function watermark() {
  return Number(await sql(`SELECT last_event_time FROM otl.community_days WHERE team_id=${quote(team)} AND channel_id='public' AND user_id='owner' AND day='2026-09-11'`));
}

// Create the channel through the ordinary storage boundary before mapping it.
await community("day");
await sql(`UPDATE otl.workspaces SET primary_goal_channel_id='public' WHERE team_id=${quote(team)}`);
await legacy("write", 10, "first goal");
assert.equal((await community("day")).goal, "first goal");
assert.equal((await legacy("write", 9, "stale goal")).goals[0].text, "first goal");
assert.equal((await legacy("write", 10, "duplicate goal")).goals[0].text, "first goal");
await legacy("complete", 11);
const completedRevision = (await community("day")).revision;
assert.equal((await legacy("write", 12, "cannot edit completed")).goals[0].text, "first goal");
assert.equal((await community("day")).revision, completedRevision);
await legacy("reopen", 12);
assert.equal((await community("day")).outcome, "pending");

await community("change", { action: "reflection", key: "partial-review", text: "halfway reflection", outcome: "partial" });
const beforeEdit = await community("day");
const editTime = (await watermark()) + 1;
await legacy("write", editTime, "edited partial goal");
const afterEdit = await community("day");
assert.equal(afterEdit.goal, "edited partial goal");
assert.equal(afterEdit.outcome, "partial");
assert.equal(afterEdit.reflection, "halfway reflection");
assert.equal(afterEdit.revision, beforeEdit.revision + 1);
assert.equal((await community("change", { action: "complete", key: "old-confirmation", expectedRevision: beforeEdit.revision })).conflict, true);
assert.equal((await legacy("write", editTime - 0.5, "late stale goal")).goals[0].text, "edited partial goal");

const canonical = await community("change", { action: "complete", key: "canonical-complete" });
assert.equal((await legacy("get", 0)).goals[0].completed, true);
await community("change", { action: "undo", key: "canonical-undo", undoKey: canonical.undoKey });
assert.equal((await legacy("get", 0)).goals[0].completed, false);
assert.equal((await community("day")).reflection, "halfway reflection");
await community("change", { channelId: "private", action: "goal", key: "private-goal", text: "private goal" });
assert.equal((await legacy("get", 0)).goals.length, 1);
assert.equal((await legacy("get", 0)).goals[0].text, "edited partial goal");

const palette = { empty: "#123456", written: "#234567", complete: "#345678" };
await legacy("palette", 20, "", { palette });
await sql(`UPDATE otl.profiles SET start_date='2026-09-01' WHERE team_id=${quote(team)} AND user_id='owner'`);
const board = await legacy("get", 0);
assert.deepEqual(board.palette, palette);
assert.equal(board.startDate, "2026-09-01");
assert.deepEqual((await legacy("palette", 19, "", { palette: { empty: "#000000", written: "#000000", complete: "#000000" } })).palette, palette);
await legacy("palette", 1, "", { teamId: `${team}-unmapped`, palette });
assert.equal((await legacy("get", 0, "", { teamId: `${team}-unmapped` })).goals.length, 0);
await assert.rejects(legacy("write", 2, "unmapped write", { teamId: `${team}-unmapped` }));
console.log("PASS normalized legacy: ordering, duplicate suppression, completed guard, partial/reflection preservation, revisions, canonical board and undo, channel isolation, palette/start date, unmapped guard");
const futureTime = (await watermark()) + 3600;
await legacy('write',futureTime,'future ordered goal');
await community('change',{action:'partial',key:'after-future'});
assert.ok((await watermark()) >= futureTime);
assert.equal((await legacy('write',futureTime-1,'stale future overwrite')).goals[0].text,'future ordered goal');
console.log('PASS monotonic watermark across legacy clock skew and canonical mutation');
