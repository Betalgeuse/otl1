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
      return day;
    },
    async change(input) {
      changes.push(input);
      return {
        day: { ...day, outcome: "complete", reflection: input.text, revision: 2 },
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
