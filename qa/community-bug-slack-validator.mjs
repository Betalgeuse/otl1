import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { bugQuestionForField } = await import("../src/community-bug-delivery.ts");
const { bugQuestionPayload } = await import("../src/community-bug-slack.ts");

const context = {
  env: {},
  scope: { teamId: "TQA", channelId: "CQA", userId: "UQA" },
  store: {},
  date: "2026-09-17",
  source: "1.000002",
  thread: "1.000001",
  key: "validator",
};

for (const field of ["frequency", "impact"]) {
  const payload = bugQuestionPayload(
    context,
    "BUG-VALIDATOR01",
    `BUG-VALIDATOR01:q1:${field}`,
    1,
    bugQuestionForField(field),
  );
  const actionIds = payload.blocks[1].elements.map((element) => element.action_id);
  assert.equal(new Set(actionIds).size, actionIds.length, `${field} action IDs must be unique`);
  const response = await fetch("https://slack.com/api/blocks.validate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ blocks: JSON.stringify(payload.blocks) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { ok: true });
}

console.log("PASS Slack blocks.validate: exact frequency and impact renders accepted");
