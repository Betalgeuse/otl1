import { mock } from "bun:test";
import assert from "node:assert/strict";

const finished = [],
  prepared = [],
  cards = [],
  retired = [];
let claims = 0,
  loseAcceptedReceipt = true,
  postedMarker = null,
  postCalls = 0;
const delivery = {
  teamId: "TQA",
  channelId: "CQA",
  userId: "UQA",
  deliveryKey: "garden:2026-09-18:r2",
  date: "2026-09-18",
  revision: 2,
  source: "1.1",
  thread: "1.1",
  undoKey: null,
  status: "claimed",
  attempts: 1,
  leaseToken: "lease",
  payloadDigest: null,
  messageTs: null,
};
mock.module("../src/community-garden-store.ts", () => ({
  GardenDeliveryStore: class {
    async claim() {
      claims++;
      return claims <= 3 ? { ...delivery, attempts: claims } : null;
    }
    async prepare(input) {
      prepared.push(input);
      return true;
    }
    async finish(input) {
      if (input.status === "sent" && loseAcceptedReceipt) {
        loseAcceptedReceipt = false;
        throw new Error("db finish unavailable");
      }
      finished.push(input);
      return true;
    }
  },
}));
mock.module("../src/community-records.ts", () => ({
  statusMessage: async () => ({
    text: "state",
    blocks: [
      { type: "section", text: { type: "plain_text", text: "state" } },
      { type: "image", image_url: "https://example.test/board.png", alt_text: "board" },
    ],
  }),
}));
mock.module("../src/store.ts", () => ({ NeonStore: class {} }));
mock.module("../src/community-store.ts", () => ({
  CommunityStore: class {
    async day() {
      return { ...delivery, goal: "goal", outcome: "pending", reflection: "", resting: false };
    }
    async listRecords(_scope, kind) {
      return kind === "card" ? [{ body: { ts: "0.9", text: "old" } }] : [];
    }
    async getRecord() {
      return null;
    }
    async putRecord(value) {
      cards.push(value);
    }
  },
}));
const { deliverGardenByKey } = await import("../src/community-garden-delivery.ts");
const env = {
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "token",
  DATABASE_URL: "postgresql://fake",
  BOARD_SIGNING_SECRET: "secret",
  PUBLIC_BASE_URL: "https://example.test",
};
const original = globalThis.fetch;
let failPost = true;
globalThis.fetch = async (url, request) => {
  const method = new URL(url).pathname.split("/").at(-1);
  if (method === "conversations.replies")
    return Response.json({
      ok: true,
      messages: postedMarker
        ? [
            {
              ts: "2.2",
              blocks: [
                {
                  type: "section",
                  block_id: postedMarker,
                  text: { type: "plain_text", text: "state" },
                },
              ],
            },
          ]
        : [],
      response_metadata: { next_cursor: "" },
    });
  if (method === "chat.postMessage") {
    postCalls++;
    if (failPost) {
      failPost = false;
      return Response.json({ ok: false, error: "rate_limited" });
    }
    const body = JSON.parse(request.body);
    postedMarker = body.blocks[0].block_id;
    return Response.json({ ok: true, ts: "2.2" });
  }
  if (method === "chat.update") {
    retired.push(JSON.parse(request.body));
    return Response.json({ ok: true });
  }
  if (method === "chat.postEphemeral") return Response.json({ ok: true, message_ts: "3.3" });
  throw new Error(method);
};
try {
  assert.equal(
    await deliverGardenByKey(env, "CQA", delivery.deliveryKey, Date.parse("2026-09-18T03:00:00Z")),
    null,
  );
  assert.equal(finished[0].status, "failed");
  assert.equal(retired.length, 0);
  assert.equal(
    await deliverGardenByKey(env, "CQA", delivery.deliveryKey, Date.parse("2026-09-18T03:02:00Z")),
    null,
  );
  assert.equal(finished.at(-1).status, "failed");
  assert.equal(retired.length, 0);
  const sent = await deliverGardenByKey(
    env,
    "CQA",
    delivery.deliveryKey,
    Date.parse("2026-09-18T03:08:00Z"),
  );
  assert.equal(sent, "2.2");
  assert.equal(finished.at(-1).status, "sent");
  assert.equal(retired.length, 1);
  assert.equal(
    postCalls,
    2,
    "reconciliation must prevent a duplicate post after accepted-response loss",
  );
  assert.equal(prepared.length, 3);
  assert.ok(prepared.every((item) => item.payloadDigest === prepared[0].payloadDigest));
  assert.ok(cards.some((r) => r.kind === "card"));
  console.log(
    "PASS durable garden retries post failure, reconciles accepted response, then retires old image after durable sent receipt",
  );
} finally {
  globalThis.fetch = original;
}
