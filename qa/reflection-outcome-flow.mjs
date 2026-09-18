import { mock } from "bun:test";
import assert from "node:assert/strict";

const posts = [];
const changes = [];
let failPosts = 0;
let accepted = false;
mock.module("../src/community-runtime.ts", () => ({
  async ephemeral() {},
  async textReply(_context, text) { posts.push({ text }); },
  payloadRecord(value) {
    return value;
  },
  async post(_context, message) {
    posts.push(message);
    if (failPosts > 0) {
      failPosts -= 1;
      throw new TypeError("synthetic Slack failure");
    }
    return `${posts.length}.000001`;
  },
}));
mock.module("../src/community-social.ts", () => ({
  async callSlack() {
    return accepted
      ? { ok: true, messages: [{ ts: "9.000001", blocks: [{ block_id: accepted }] }] }
      : { ok: true, messages: [], response_metadata: { next_cursor: "" } };
  },
}));
mock.module("../src/community-admin.ts", () => ({ publishRelease: async () => {}, releasePreview: async () => {} }));
mock.module("../src/community-admin-collection.ts", () => ({ runPublicCollectionTest: async () => {} }));
mock.module("../src/community-controls.ts", () => ({ stopSettings: async () => {} }));
mock.module("../src/community-cutover.ts", () => ({ enablePublicSchedule: async () => {} }));
mock.module("../src/community-edits.ts", () => ({ confirmedRecordEdit: () => ({}) }));
mock.module("../src/community-scheduler.ts", () => ({ runCommunitySchedule: async () => ({}) }));
mock.module("../src/community-records.ts", () => ({
  async publishStatus() {},
  async undoChange() {},
  async applyChange(context, change) {
    changes.push(change);
    const current = context.store.current;
    context.store.current = {
      ...current,
      outcome:
        change.action === "complete" || change.action === "partial" || change.action === "not_done"
          ? change.action
          : current.outcome,
      resting: change.action === "rest",
      revision: current.revision + 1,
    };
  },
}));

const {
  captureReflectionAwaitingOutcome,
  replayReflectionOutcomeDelivery,
  resolveNaturalReflectionOutcome,
  resolvePendingReflectionOutcome,
} = await import("../src/community-reflection-outcome.ts");
const { processRecordAction } = await import("../src/community-record-interactions.ts");

function fakeStore(day) {
  const records = new Map();
  return {
    current: day,
    records,
    async putRecord(input) {
      const id = `${input.kind}:${input.key}`;
      if (!records.has(id)) records.set(id, { ...input, status: "pending" });
      return records.get(id);
    },
    async getRecord(input) {
      return [...records.values()].find((record) => record.key === input.key) ?? null;
    },
    async listRecords(_scope, kind) {
      return [...records.values()].filter((record) => record.kind === kind);
    },
    async claimRecord(input) {
      const record = [...records.values()].find((item) => item.key === input.key);
      if (!record || record.status !== "pending") return false;
      record.status = "claimed";
      return true;
    },
    async finishRecord(input, status) {
      const record = [...records.values()].find((item) => item.key === input.key);
      if (!record || record.status !== "claimed") return false;
      record.status = status;
      return true;
    },
    async day() {
      return this.current;
    },
  };
}

const scope = { teamId: "TQA", channelId: "CPUBLIC", userId: "UYUNSU" };
const day = {
  ...scope,
  date: "2026-09-15",
  goal: "프로젝트 구상",
  outcome: "pending",
  reflection: "자료조사 방향과 의사결정 항목 정리",
  resting: false,
  revision: 2,
};
const store = fakeStore(day);
const context = {
  env: { SLACK_BOT_TOKEN: "fake" },
  scope,
  store,
  date: day.date,
  source: "1789541204.889939",
  thread: "1789432863.093679",
  key: "incoming:1789541204.889939",
};

await captureReflectionAwaitingOutcome(context, day);
assert.equal(posts.length, 1);
assert.match(posts[0].text, /2026-09-15 결과는 완료·부분 완료·미완료·휴식/);
assert.doesNotMatch(JSON.stringify(posts[0]), /자료조사 방향/);
const pending = [...store.records.values()].find((record) => record.kind === "reflection_outcome");
assert.equal(pending.status, "pending", "unanswered question persists indefinitely");
const buttons = posts[0].blocks.at(-1).elements;
assert.deepEqual(buttons.map((button) => button.action_id), [
  "community_complete",
  "community_partial",
  "community_not_done",
  "community_rest",
]);
for (const button of buttons) {
  const value = JSON.parse(button.value);
  assert.equal(value.ownerId, scope.userId);
  assert.equal(value.date, "2026-09-15");
  assert.equal(value.revision, 2);
  assert.equal(value.source, context.source);
  assert.equal(value.thread, context.thread);
}
await captureReflectionAwaitingOutcome(context, day);
assert.equal(posts.length, 1, "duplicate capture does not duplicate the question");

const naturalContext = { ...context, source: "1789541300.000001", key: "incoming:answer" };
assert.equal(await resolveNaturalReflectionOutcome(naturalContext, "부분완료"), true);
assert.equal(changes.at(-1).action, "partial");
assert.equal(changes.at(-1).date, "2026-09-15");
assert.equal(store.current.reflection, day.reflection);
assert.equal(pending.status, "sent");
assert.equal(await resolveNaturalReflectionOutcome(naturalContext, "완료"), false, "closed pending is not replayed");

const staleStore = fakeStore({ ...day, revision: 3 });
const staleContext = { ...context, store: staleStore, key: "incoming:stale" };
await staleStore.putRecord({
  ...scope,
  key: "reflection-outcome:stale",
  kind: "reflection_outcome",
  body: { date: day.date, revision: 2, source: context.source, thread: context.thread },
});
const staleChanges = changes.length;
assert.equal(await resolveNaturalReflectionOutcome(staleContext, "완료"), true);
assert.equal(changes.length, staleChanges, "stale natural answer fails closed without generic fallback");

const secondStore = fakeStore(day);
const secondContext = { ...context, store: secondStore, key: "incoming:second" };
const postsBeforeFailure = posts.length;
failPosts = 1;
await captureReflectionAwaitingOutcome(secondContext, day);
assert.equal(secondStore.current.reflection, day.reflection, "question failure never rolls back reflection");
assert.equal(
  [...secondStore.records.values()].find((record) => record.kind === "reflection_outcome").status,
  "pending",
);
assert.equal(
  [...secondStore.records.values()].find((record) => record.kind === "reflection_outcome_delivery").status,
  "failed",
);
await replayReflectionOutcomeDelivery(secondContext);
assert.equal(
  [...secondStore.records.values()].filter((record) => record.kind === "reflection_outcome_delivery").length,
  2,
);
assert.equal(posts.length, postsBeforeFailure + 2, "failed public post is retried once");

const thirdStore = fakeStore(day);
const thirdContext = { ...context, store: thirdStore, key: "incoming:third" };
failPosts = 1;
await captureReflectionAwaitingOutcome(thirdContext, day);
const postsBeforeReconciliation = posts.length;
accepted = posts.at(-1).blocks[0].block_id;
await replayReflectionOutcomeDelivery(thirdContext);
assert.equal(posts.length, postsBeforeReconciliation, "accepted Slack post is reconciled before retry");
assert.equal(
  [...thirdStore.records.values()].filter(
    (record) => record.kind === "reflection_outcome_delivery" && record.status === "sent",
  ).length,
  1,
);
accepted = false;

const secondPending = [...secondStore.records.values()].find(
  (record) => record.kind === "reflection_outcome",
);
assert.equal(
  await resolvePendingReflectionOutcome(
    secondContext,
    secondPending.key,
    "complete",
    true,
    { date: "2026-09-15", revision: 999 },
  ),
  false,
  "stale button revision fails closed",
);
assert.equal(
  await resolvePendingReflectionOutcome(
    secondContext,
    secondPending.key,
    "complete",
    true,
    { date: "2026-09-15", revision: 2 },
  ),
  true,
);
assert.equal(secondStore.current.outcome, "complete");
assert.equal(secondStore.current.reflection, day.reflection);
assert.equal(
  await resolvePendingReflectionOutcome(secondContext, secondPending.key, "not_done", true),
  false,
  "button replay cannot rewrite the chosen outcome",
);

const wrongOwnerContext = {
  ...secondContext,
  scope: { ...scope, userId: "UOTHER" },
};
assert.equal(
  await resolvePendingReflectionOutcome(wrongOwnerContext, secondPending.key, "not_done", true),
  false,
);

const fourthStore = fakeStore(day);
const fourthContext = { ...context, store: fourthStore, key: "interaction:button" };
await captureReflectionAwaitingOutcome(fourthContext, day);
const fourthPending = [...fourthStore.records.values()].find(
  (record) => record.kind === "reflection_outcome",
);
const partialButton = posts.at(-1).blocks.at(-1).elements.find(
  (button) => button.action_id === "community_partial",
);
const partialValue = JSON.parse(partialButton.value);
await assert.rejects(
  () =>
    processRecordAction(fourthContext, "community_partial", fourthPending.key, {
      ...partialValue,
      revision: 999,
    }),
  /만료/,
);
assert.equal(fourthStore.current.outcome, "pending");
await processRecordAction(
  fourthContext,
  "community_partial",
  fourthPending.key,
  partialValue,
);
assert.equal(fourthStore.current.outcome, "partial");
assert.equal(fourthStore.current.reflection, day.reflection);

console.log(
  "PASS durable public outcome question is private-text-free, retryable, owner/date/revision-bound, and optional",
);
