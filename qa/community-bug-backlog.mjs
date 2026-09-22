import { mock } from "bun:test";
import assert from "node:assert/strict";

const databaseResults = [];
const databaseCalls = [];
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
mock.module("../src/store.ts", () => ({
  NeonStore: class {
    async queryJson(query, params) {
      databaseCalls.push({ query, input: JSON.parse(params[0]) });
      return databaseResults.shift();
    }
  },
}));
mock.module("../src/community-store.ts", () => ({ CommunityStore: class {} }));
mock.module("../src/community-bug-delivery.ts", () => ({
  BUG_DELIVERY_WORKER_ID: "slack-bug-delivery",
  bugQuestionForField() {
    return {};
  },
  async failClaimedBugDelivery() {
    return "failed";
  },
  async sendClaimedBugDelivery() {
    return "sent";
  },
}));
mock.module("../src/community-bug-facts.ts", () => ({
  confirmedFieldsFromSanitized() {
    return null;
  },
}));
mock.module("../src/community-bug-slack.ts", () => ({
  bugConfirmationPayload() {
    return {};
  },
  bugQuestionPayload() {
    return {};
  },
}));

const { runDueBugDeliveries } = await import("../src/community-bug-delivery-scheduler.ts");
const env = {
  SLACK_TEAM_ID: "T-BACKLOG",
  SLACK_BOT_TOKEN: "test",
  DATABASE_URL: "postgresql://test",
  BOARD_SIGNING_SECRET: "test",
  PUBLIC_BASE_URL: "https://test",
};
const scheduledTime = Date.parse("2026-09-17T00:00:00.000Z");

function dueRow(index) {
  return {
    delivery_id: index,
    delivery_key: `BUG-BACKLOG01:1:receipt:reporter_ephemeral:${index}`,
    delivery_kind: "receipt",
    team_id: "T-BACKLOG",
    bug_id: "BUG-BACKLOG01",
    packet_revision: 1,
    question_id: null,
    destination: "reporter_ephemeral",
    template_id: "receipt.confirmed.v1",
    field_name: null,
    renderer_version: "bug-message.v1",
    status: "claimed",
    attempts: 1,
    not_before: "2026-09-17T00:00:00.000Z",
    retry_after: null,
    last_error_code: null,
    message_ts: null,
    worker_id: "slack-bug-delivery",
    lease_token: "lease",
    lease_expires_at: "2026-09-17T00:05:00.000Z",
    reporter_id: "U-REPORTER",
    source_channel_id: "C-BUGS",
    source_thread: "1.1",
    report_revision: 1,
    sanitized_fields: {},
  };
}

async function run(reconciled, expired, claimed) {
  databaseResults.push(
    reconciled,
    expired,
    Array.from({ length: claimed }, (_, i) => dueRow(i + 1)),
  );
  return runDueBugDeliveries(env, scheduledTime);
}

for (const [phase, counts] of [
  ["reconcilePrivate", [10, 0, 0]],
  ["expiry", [0, 10, 0]],
  ["deliveries", [0, 0, 10]],
]) {
  const saturated = await run(...counts);
  assert.equal(saturated[phase].possiblyMore, true);
  assert.equal(saturated.possiblyMore, true);
  const drained = await run(0, 0, 0);
  assert.equal(drained.possiblyMore, false);
}

assert.deepEqual(
  databaseCalls
    .slice(0, 3)
    .map(({ query, input }) => [
      query.match(/bug_(reconcile_private_incidents|expire_due_intakes|claim_due_deliveries)/)?.[1],
      input.teamId,
      input.limit,
    ]),
  [
    ["reconcile_private_incidents", "T-BACKLOG", 10],
    ["expire_due_intakes", "T-BACKLOG", 10],
    ["claim_due_deliveries", "T-BACKLOG", 10],
  ],
);
console.log(
  "PASS bug backlog: every saturated team-scoped phase reports continuation until drained.",
);
