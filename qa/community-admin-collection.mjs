import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const fixtureDate = "2026-09-17";
const staleDate = "2026-09-16";
const fixtureNow = Date.parse(`${fixtureDate}T12:00:00+09:00`);
const records = new Map();
const claimed = new Set();
const batchClaims = [];
const reconciles = [];
const claimedBatchTimes = new Set();
let configWrites = 0;
const recordId = (value) => `${value.teamId}:${value.channelId}:${value.userId}:${value.key}`;
const fakeStore = {
  async putRecord(input) {
    const value = { ...input, status: "pending" };
    records.set(recordId(input), value);
    return value;
  },
  async getRecord(input) {
    return records.get(recordId(input)) ?? null;
  },
  async claimRecord(input) {
    const id = recordId(input);
    if (claimed.has(id)) return false;
    claimed.add(id);
    const value = records.get(id);
    if (value) value.status = "claimed";
    return Boolean(value);
  },
  async finishRecord(input, status) {
    const value = records.get(recordId(input));
    if (!value || value.status !== "claimed") return false;
    value.status = status;
    return true;
  },
  async reminderTriggerDue() {
    return true;
  },
  async reconcileChannelMembers(scope, snapshot) {
    reconciles.push({ scope, snapshot });
    return true;
  },
  async members() {
    return ["UONE", "UTWO"];
  },
  async claimReminderBatch(input) {
    if (claimedBatchTimes.has(input.now)) return null;
    claimedBatchTimes.add(input.now);
    batchClaims.push(input);
    const kind = input.now.endsWith("01:00:00.000Z") ? "goal" : "review";
    return {
      leaseToken: input.leaseToken,
      attempt: 1,
      firstAttemptAt: input.now,
      jobs: [
        {
          ...input,
          userId: kind === "goal" ? "UONE" : "UTWO",
          key: `reminder:${fixtureDate}:${kind}`,
          date: fixtureDate,
          kind,
        },
      ],
    };
  },
  async claimReviewReminderBatch(input) {
    if (!input.now.endsWith("09:00:00.000Z") || claimedBatchTimes.has(input.now)) return null;
    claimedBatchTimes.add(input.now);
    batchClaims.push(input);
    return {
      leaseToken: input.leaseToken,
      attempt: 1,
      firstAttemptAt: input.now,
      threadTs: "18.000001",
      jobs: [
        {
          ...input,
          userId: "UTWO",
          key: `reminder:${fixtureDate}:review`,
          date: fixtureDate,
          kind: "review",
        },
      ],
    };
  },
  async claimGoalReminderBatch(input) {
    if (!input.now.endsWith("01:00:00.000Z") || claimedBatchTimes.has(input.now)) return null;
    claimedBatchTimes.add(input.now);
    batchClaims.push(input);
    return {
      leaseToken: input.leaseToken,
      attempt: 1,
      firstAttemptAt: input.now,
      jobs: [
        {
          ...input,
          userId: "UONE",
          key: `reminder:${fixtureDate}:goal`,
          date: fixtureDate,
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
  async claimCommonDelivery() {
    return null;
  },
  async finishCommonDelivery() {
    return false;
  },
  async setGroupSchedule() {
    configWrites += 1;
  },
  async preferences() {
    configWrites += 1;
    return { enabled: true, goalTime: "10:00", reviewTime: "18:00" };
  },
};
mock.module("../src/community-store.ts", () => ({
  CommunityStore: class {
    constructor() {
      return fakeStore;
    }
  },
}));
mock.module("../src/community-store", () => ({
  CommunityStore: class {
    constructor() {
      return fakeStore;
    }
  },
}));

const { groupCard } = await import("../src/community-controls.ts");
const { communityInteraction } = await import("../src/community-interactions.ts");
const env = {
  COMMUNITY_ENABLED: "true",
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "test",
  DATABASE_URL: "postgresql://u:p@x.neon.tech/db",
  BOARD_SIGNING_SECRET: "test",
  PUBLIC_BASE_URL: "https://test",
  COMMUNITY_CHANNEL_ID: "CADMIN",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_BOT_USER_ID: "UBOT",
};
const adminScope = { teamId: "TQA", channelId: "CADMIN", userId: "UADMIN" };
records.set(recordId({ ...adminScope, channelId: "CPUBLIC", key: "group-schedule" }), {
  ...adminScope,
  channelId: "CPUBLIC",
  key: "group-schedule",
  kind: "settings",
  body: { enabled: true, goalTime: "10:00", reviewTime: "18:00" },
  status: "pending",
});
const calls = [];
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
try {
  Date.now = () => fixtureNow;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("conversations.members"))
      return Response.json({
        ok: true,
        members: ["UONE", "UTWO", "UBOT"],
        response_metadata: { next_cursor: "" },
      });
    if (parsed.pathname.endsWith("users.info")) {
      const id = parsed.searchParams.get("user");
      return Response.json({
        ok: true,
        user: { id, deleted: false, is_bot: id === "UBOT", is_app_user: false },
      });
    }
    if (parsed.pathname.endsWith("emoji.list")) return Response.json({ ok: true, emoji: {} });
    const body = JSON.parse(options.body);
    calls.push({ method: parsed.pathname.split("/").at(-1), body });
    return Response.json({
      ok: true,
      ts: `${calls.length}.000001`,
      message_ts: `${calls.length}.000001`,
    });
  };

  const context = {
    env,
    scope: adminScope,
    store: fakeStore,
    date: fixtureDate,
    source: "1.000001",
    thread: "1.000001",
    key: "message:1",
  };
  await groupCard(context);
  const card = calls.at(-1).body;
  const button = card.blocks
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === "community_test_public_collection");
  assert.equal(button.text.text, "데일리스크럼 수집 테스트");

  const action = {
    type: "block_actions",
    team: { id: "TQA" },
    user: { id: "UADMIN" },
    container: { channel_id: "CADMIN", message_ts: "1.000001" },
    actions: [{ action_id: button.action_id, value: button.value, action_ts: "2.000001" }],
  };
  const pending = [];
  assert.equal(
    (await communityInteraction(action, env, (promise) => pending.push(promise))).status,
    200,
  );
  await Promise.all(pending);
  assert.equal(reconciles.length, 2);
  assert.ok(
    reconciles.every(
      (entry) =>
        entry.scope.channelId === "CPUBLIC" && entry.snapshot.eligibleHumanIds.length === 2,
    ),
  );
  assert.deepEqual(
    reconciles.map((entry) => entry.snapshot.observedAt),
    [new Date(fixtureNow).toISOString(), new Date(fixtureNow).toISOString()],
  );
  assert.equal(batchClaims.length, 2);
  assert.deepEqual(
    batchClaims.map((entry) => entry.now),
    [`${fixtureDate}T01:00:00.000Z`, `${fixtureDate}T09:00:00.000Z`],
  );
  assert.ok(batchClaims.every((entry) => entry.channelId === "CPUBLIC"));
  const batchPosts = calls.filter(
    (call) => call.method === "chat.postMessage" && /알림 설정/.test(call.body.text),
  );
  assert.equal(batchPosts.length, 2);
  assert.ok(batchPosts.every((call) => call.body.channel === "CPUBLIC"));
  assert.equal(
    calls.some(
      (call) =>
        call.method === "chat.postMessage" &&
        call.body.channel === "CADMIN" &&
        /알림 설정/.test(call.body.text),
    ),
    false,
  );
  const receipt = calls.findLast((call) => call.method === "chat.postEphemeral");
  assert.equal(receipt.body.channel, "CADMIN");
  assert.match(receipt.body.text, /대상 2명 · 배치 2건/);
  assert.equal(configWrites, 0);

  const publicBeforeReplay = calls.filter((call) => call.body.channel === "CPUBLIC").length;
  const replay = [];
  await communityInteraction(action, env, (promise) => replay.push(promise));
  await Promise.all(replay);
  assert.equal(calls.filter((call) => call.body.channel === "CPUBLIC").length, publicBeforeReplay);

  for (const changed of [
    { user: { id: "UMEMBER" } },
    { container: { channel_id: "CPUBLIC", message_ts: "1.000001" } },
  ]) {
    const before = calls.length;
    await assert.rejects(
      () => communityInteraction({ ...action, ...changed }, env, () => {}),
      /운영자|관리|동작/,
    );
    assert.equal(calls.length, before);
  }
  const ownerTamper = {
    ...action,
    actions: [
      {
        ...action.actions[0],
        value: JSON.stringify({ ...JSON.parse(button.value), ownerId: "UOTHER" }),
      },
    ],
  };
  await assert.rejects(() => communityInteraction(ownerTamper, env, () => {}), /본인 기록/);

  const staleKey = "admin-collection-test:stale";
  records.set(recordId({ ...adminScope, key: staleKey }), {
    ...adminScope,
    key: staleKey,
    kind: "admin_qa_action",
    status: "pending",
    body: { date: staleDate, source: "3.000001", thread: "3.000001", targetChannelId: "CPUBLIC" },
  });
  const staleValue = JSON.stringify({
    ownerId: "UADMIN",
    key: staleKey,
    source: "3.000001",
    thread: "3.000001",
  });
  const stalePending = [];
  const stalePublicBefore = calls.filter((call) => call.body.channel === "CPUBLIC").length;
  await communityInteraction(
    {
      ...action,
      container: { channel_id: "CADMIN", message_ts: "3.000001" },
      actions: [{ action_id: button.action_id, value: staleValue, action_ts: "3.000002" }],
    },
    env,
    (promise) => stalePending.push(promise),
  );
  await Promise.all(stalePending);
  assert.equal(calls.filter((call) => call.body.channel === "CPUBLIC").length, stalePublicBefore);
  console.log(
    "PASS admin collection QA action: owner-scoped current-member public triggers, one batch each, private count receipt and replay denial",
  );
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}
