import assert from "node:assert/strict";
import { sendCommonDeliveries } from "../src/community-common-delivery.ts";

const scope = { teamId: "TQA", channelId: "CPUBLIC", userId: "UADMIN" };
const text = "stable common payload <@U1>";
const originalFetch = globalThis.fetch;
try {
  const failures = [];
  let firstClaim = true;
  const rateStore = {
    async claimCommonDelivery() {
      if (!firstClaim) return null;
      firstClaim = false;
      return {
        leaseToken: "rate",
        attempt: 1,
        firstAttemptAt: "2026-09-18T01:00:00Z",
        key: "common:2026-09-18:goal",
        text,
        date: "2026-09-18",
        kind: "goal",
      };
    },
    async finishCommonDelivery(value) {
      failures.push(value);
      return true;
    },
    async putRecord() {
      throw new Error("unexpected record");
    },
  };
  globalThis.fetch = async () =>
    new Response("", { status: 429, headers: { "Retry-After": "23" } });
  assert.equal(
    await sendCommonDeliveries({
      token: "token",
      now: "2026-09-18T01:00:00Z",
      scope,
      store: rateStore,
    }),
    0,
  );
  assert.deepEqual(failures, [
    {
      ...scope,
      leaseToken: "rate",
      status: "failed",
      errorCode: "rate_limited",
      retryAfterSeconds: 23,
    },
  ]);

  const records = [];
  const finishes = [];
  let historyPages = 0;
  let posts = 0;
  let retryClaimed = false;
  const retryStore = {
    async claimCommonDelivery() {
      if (retryClaimed) return null;
      retryClaimed = true;
      return {
        leaseToken: "retry",
        attempt: 2,
        firstAttemptAt: "2026-09-18T01:00:00Z",
        key: "common:2026-09-18:goal",
        text,
        date: "2026-09-18",
        kind: "goal",
      };
    },
    async putRecord(value) {
      records.push(value);
      return value;
    },
    async finishCommonDelivery(value) {
      finishes.push(value);
      return true;
    },
  };
  globalThis.fetch = async (url) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "conversations.history") {
      historyPages += 1;
      return historyPages === 1
        ? Response.json({ ok: true, messages: [], response_metadata: { next_cursor: "page-2" } })
        : Response.json({
            ok: true,
            messages: [{ ts: "200.2", text }],
            response_metadata: { next_cursor: "" },
          });
    }
    posts += 1;
    return Response.json({ ok: true, ts: "unexpected" });
  };
  assert.equal(
    await sendCommonDeliveries({
      token: "token",
      now: "2026-09-18T01:05:00Z",
      scope,
      store: retryStore,
    }),
    1,
  );
  assert.equal(historyPages, 2);
  assert.equal(posts, 0);
  assert.deepEqual(
    records.map((value) => value.key),
    ["prompt:200.2", "common-thread:2026-09-18:goal"],
  );
  assert.deepEqual(finishes, [
    { ...scope, leaseToken: "retry", status: "sent", messageTs: "200.2" },
  ]);
  console.log(
    "PASS common delivery: bounded 429 retry and exact multi-page history reconciliation prevent duplicate posts",
  );
} finally {
  globalThis.fetch = originalFetch;
}
