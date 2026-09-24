import assert from "node:assert/strict";
import { memberActionBlocks } from "../src/community-member-actions.ts";
import {
  openQuickEntryModal,
  parseQuickEntrySubmission,
  submitQuickEntry,
} from "../src/community-quick-entry.ts";

const day = {
  teamId: "TQA",
  channelId: "CPUBLIC",
  userId: "UQA",
  date: "2026-09-23",
  goal: "RAG 개념 다시 익히기",
  outcome: "pending",
  reflection: "",
  resting: false,
  revision: 1,
};
const changes = [];
const records = [];
const garden = [];
let currentDay = { ...day, goal: "", revision: 0 };
const context = {
  env: {
    SLACK_TEAM_ID: "TQA",
    SLACK_BOT_TOKEN: "fake",
    DATABASE_URL: "postgresql://u:p@example.neon.tech/db",
    BOARD_SIGNING_SECRET: "secret",
    PUBLIC_BASE_URL: "https://example.com",
    COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
    COMMUNITY_CLOCK: {
      getByName() {
        return {
          async publishGarden(input) {
            garden.push(input);
            return "garden-delivery";
          },
        };
      },
    },
  },
  scope: { teamId: "TQA", channelId: "CPUBLIC", userId: "UQA" },
  store: {
    async day() {
      return currentDay;
    },
    async change(input) {
      changes.push(input);
      return {
        day: { ...currentDay, goal: input.text, revision: currentDay.revision + 1 },
        changed: true,
        conflict: false,
        firstGoal: false,
        firstRegistration: false,
        firstReflection: false,
        undoKey: input.key,
        gardenDeliveryKey: "delivery-key",
      };
    },
    async putRecord(input) {
      records.push(input);
      return { ...input, status: "pending" };
    },
  },
  date: "2026-09-23",
  source: "1790090000.000001",
  thread: "1790090000.000001",
  key: "interaction:quick-review",
};

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const method = new URL(url).pathname.split("/").at(-1);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ method, body });
  if (method === "views.open") return Response.json({ ok: true });
  if (method === "chat.postMessage") return Response.json({ ok: true, ts: "1790090001.000002" });
  if (method === "emoji.list") return Response.json({ ok: true, emoji: {} });
  if (method === "reactions.add") return Response.json({ ok: true });
  throw new Error(`unexpected Slack method ${method}`);
};

try {
  const [core, navigation] = memberActionBlocks({}, "2026-09-23");
  assert.deepEqual(
    core.elements.map((element) => [element.action_id, element.style]),
    [
      ["community_quick_goal", "primary"],
      ["community_quick_review", "danger"],
    ],
  );
  assert.equal(JSON.parse(core.elements[0].value).date, "2026-09-23");
  assert.equal(navigation.elements.length, 4);

  await openQuickEntryModal(context, "GOAL-TRIGGER", "goal");
  const goalModal = calls.find((call) => call.method === "views.open").body.view;
  assert.equal(goalModal.callback_id, "community_quick_goal_submit");
  assert.equal(goalModal.blocks[1].block_id, "reason");
  assert.equal(goalModal.blocks[1].label.text, "왜 중요한가요?");
  const goalInput = parseQuickEntrySubmission({
    private_metadata: goalModal.private_metadata,
    state: {
      values: {
        text: { value: { value: "RAG 개념 층위를 나눠 정리하기" } },
        reason: { value: { value: "인수인계 뒤 연구과제를 혼동 없이 이어가기 위해서" } },
      },
    },
  });
  assert.deepEqual(goalInput, {
    kind: "goal",
    date: "2026-09-23",
    revision: 0,
    text: "RAG 개념 층위를 나눠 정리하기",
    reason: "인수인계 뒤 연구과제를 혼동 없이 이어가기 위해서",
  });
  assert.deepEqual(
    parseQuickEntrySubmission({
      private_metadata: goalModal.private_metadata,
      state: {
        values: {
          text: { value: { value: "RAG 개념 층위를 나눠 정리하기" } },
          reason: { value: { value: "" } },
        },
      },
    }),
    { errors: { reason: "중요한 이유를 1~500자로 적어 주세요." } },
  );
  calls.length = 0;
  await submitQuickEntry(context, "GOAL-VIEW", goalInput);
  const goalPost = calls.find((call) => call.method === "chat.postMessage");
  assert.match(goalPost.body.text, /ONE THING.*RAG 개념 층위를 나눠 정리하기/s);
  assert.match(goalPost.body.text, /사유: 인수인계 뒤 연구과제를 혼동 없이 이어가기 위해서/);
  assert.deepEqual(records.find((record) => record.kind === "goal_reason").body, {
    date: "2026-09-23",
    goal: "RAG 개념 층위를 나눠 정리하기",
    reason: "인수인계 뒤 연구과제를 혼동 없이 이어가기 위해서",
    source: "1790090001.000002",
    thread: context.thread,
  });

  calls.length = 0;
  changes.length = 0;
  records.length = 0;
  garden.length = 0;
  currentDay = day;

  await openQuickEntryModal(context, "TRIGGER", "review");
  const modal = calls.find((call) => call.method === "views.open").body.view;
  assert.equal(modal.callback_id, "community_quick_review_submit");
  assert.match(modal.blocks[0].text.text, /RAG 개념 다시 익히기/);

  const parsed = parseQuickEntrySubmission({
    private_metadata: modal.private_metadata,
    state: {
      values: {
        outcome: { value: { selected_option: { value: "complete" } } },
        text: { value: { value: "개념 층위를 나눠 정리했다." } },
      },
    },
  });
  assert.deepEqual(parsed, {
    kind: "review",
    date: "2026-09-23",
    revision: 1,
    text: "개념 층위를 나눠 정리했다.",
    outcome: "complete",
  });
  await submitQuickEntry(context, "VIEW-1", parsed);
  const post = calls.find((call) => call.method === "chat.postMessage");
  assert.equal(post.body.thread_ts, context.thread);
  assert.match(post.body.text, /<@UQA>.*후기.*개념 층위를 나눠 정리했다/s);
  assert.equal(changes[0].delivery.source, "1790090001.000002");
  assert.equal(changes[0].delivery.thread, context.thread);
  assert.equal(garden[0].source, "1790090001.000002");
  assert.ok(
    calls.some(
      (call) => call.method === "reactions.add" && call.body.timestamp === "1790090001.000002",
    ),
  );
  assert.equal(records[0].kind, "undo");
  console.log(
    "PASS quick entry: distinct buttons open a modal and proxy the public record into reactions and garden",
  );
} finally {
  globalThis.fetch = originalFetch;
}
