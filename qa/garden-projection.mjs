import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("../src/community-records.ts", () => ({
  statusMessage: async () => ({
    text: "state",
    blocks: [
      { type: "section", text: { type: "plain_text", text: "state" } },
      { type: "image", image_url: "https://example.test/board.png", alt_text: "board" },
    ],
  }),
}));
const { gardenMarker } = await import("../src/community-garden-delivery.ts");
const { postGarden, retireGardenCards } = await import("../src/community-garden.ts");
const base = {
  teamId: "TQA",
  channelId: "CQA",
  deliveryKey: "garden:v2:2026-09-15:r2:shared",
  date: "2026-09-15",
  revision: 2,
  source: "11.1",
  thread: "10.1",
  undoKey: null,
  status: "claimed",
  attempts: 1,
  leaseToken: "lease",
  payloadDigest: null,
  messageTs: null,
  projectionKey: "projection-a",
  routeKind: "goal_prompt",
  routeProvenance: "daily_prompt_fallback",
};
const digest = "a".repeat(64);
const markers = await Promise.all(
  ["UA", "UB", "UC", "UD"].map((userId) => gardenMarker({ ...base, userId }, digest)),
);
assert.equal(
  new Set(markers).size,
  4,
  "four users in one root need distinct reconciliation markers",
);
assert.equal(await gardenMarker(base, digest), await gardenMarker(base, digest));
assert.notEqual(await gardenMarker(base, "b".repeat(64)), await gardenMarker(base, digest));
const posted = [];
const original = globalThis.fetch;
globalThis.fetch = async (url, request) => {
  if (url.includes("conversations.replies"))
    return Response.json({ ok: true, messages: [], response_metadata: { next_cursor: "" } });
  const body = JSON.parse(request.body);
  if (url.endsWith("chat.postMessage")) {
    posted.push(body);
    return Response.json({ ok: true, ts: `message.${posted.length}` });
  }
  return Response.json({ ok: true });
};
const receipts = [];
for (const [index, userId] of ["UA", "UB", "UC", "UD"].entries()) {
  const context = {
    env: { SLACK_BOT_TOKEN: "test" },
    scope: { teamId: "TQA", channelId: "CQA", userId },
    thread: "10.1",
    source: `11.${index + 1}`,
    store: {
      async day() {
        return {};
      },
      async listRecords() {
        return [];
      },
      async putRecord() {},
      async getRecord() {
        return null;
      },
    },
  };
  receipts.push(
    (await postGarden(context, "2026-09-15", markers[index], `projection-${userId}`, 2)).sent,
  );
}
assert.equal(new Set(receipts).size, 4);
assert.equal(new Set(posted.map((message) => message.blocks[0].block_id)).size, 4);

const updates = [],
  saved = [];
globalThis.fetch = async (_url, request) => {
  updates.push(JSON.parse(request.body));
  return Response.json({ ok: true });
};
const context = {
  env: { SLACK_BOT_TOKEN: "test" },
  scope: { teamId: "TQA", channelId: "CQA", userId: "UA" },
  store: {
    async getRecord() {
      return null;
    },
    async putRecord(value) {
      saved.push(value);
    },
  },
};
const publication = {
  sent: "new.1",
  messageText: "state",
  projectionKey: "projection-a",
  prior: [
    {
      body: {
        ts: "old-same.1",
        text: "same",
        date: "2026-09-15",
        thread: "10.1",
        revision: 1,
        projectionKey: "projection-a",
      },
    },
    {
      body: {
        ts: "old-other-date.1",
        text: "other",
        date: "2026-09-18",
        thread: "18.1",
        revision: 1,
        projectionKey: "projection-b",
      },
    },
    {
      body: {
        ts: "old-other-thread.1",
        text: "other",
        date: "2026-09-15",
        thread: "15.9",
        revision: 1,
        projectionKey: "projection-c",
      },
    },
  ],
};
try {
  await retireGardenCards(context, publication);
  assert.deepEqual(
    updates.map((item) => item.ts),
    ["old-same.1"],
  );
  assert.equal(saved.length, 1);
  console.log(
    "PASS full-scope markers are collision-free and retirement stays inside one projection route",
  );
} finally {
  globalThis.fetch = original;
}
