import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { nextAlarmTime, armCommunityClock } = await import("../src/community-clock.ts");
const now = Date.parse("2026-09-11T00:00:00Z");
assert.equal(nextAlarmTime([], now), null);
assert.equal(nextAlarmTime(["18:00", "10:00", "10:00"], now), Date.parse("2026-09-11T01:00:00Z"));
assert.equal(nextAlarmTime(["10:00"], Date.parse("2026-09-11T01:00:00Z")), Date.parse("2026-09-12T01:00:00Z"));
assert.equal(nextAlarmTime(["00:05"], Date.parse("2026-09-11T14:59:00Z")), Date.parse("2026-09-11T15:05:00Z"));
assert.throws(() => nextAlarmTime(["24:00"], now));
assert.deepEqual(await armCommunityClock({}, "admin"), { next: null });
let routed = "";
await armCommunityClock({ SLACK_TEAM_ID: "team", COMMUNITY_CLOCK: { getByName(name) { routed = name; return { async refresh(channel) { assert.equal(channel, "admin"); return { next: now }; } }; } } }, "admin");
assert.equal(routed, "team:admin");
console.log("PASS clock timing/routing: nearest future KST deadline, rollover, disabled binding, scope name. Durable Object runtime requires live verification.");
