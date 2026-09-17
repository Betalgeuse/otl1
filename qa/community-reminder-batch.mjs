import assert from "node:assert/strict";
import { renderReminderBatch, sendReminderBatch } from "../src/community-reminder-batch.ts";

const job = (userId, kind = "goal") => ({
  teamId: "TQA", channelId: "CPUBLIC", userId,
  key: `reminder:2026-09-17:${kind}`, date: "2026-09-17", kind,
});
assert.equal((renderReminderBatch([job("U1"), job("U1", "review")]).match(/<@U1>/g) ?? []).length, 1);
assert.equal(renderReminderBatch(Array.from({ length: 101 }, (_, index) => job(`U${index}`))), null);
assert.equal(renderReminderBatch([job(`U${"A".repeat(2_801)}`)]), null);

const originalFetch = globalThis.fetch;
try {
  const failed = [];
  globalThis.fetch = async () => new Response("", { status: 429, headers: { "Retry-After": "17" } });
  const retryStore = {
    async claimReminderBatch() { return { leaseToken: "retry", attempt: 1, firstAttemptAt: "2026-09-17T09:00:00Z", jobs: [job("U1")] }; },
    async finishReminderBatch(input) { failed.push(input); return true; },
  };
  assert.equal(await sendReminderBatch({ token: "token", teamId: "TQA", channelId: "CPUBLIC", now: "2026-09-17T09:00:00Z", store: retryStore }), 0);
  assert.deepEqual(failed, [{ teamId: "TQA", channelId: "CPUBLIC", leaseToken: "retry", status: "failed", errorCode: "rate_limited", retryAfterSeconds: 17 }]);

  let acceptedText = "";
  let posts = 0;
  let claims = 0;
  let firstFinish = true;
  const finishes = [];
  globalThis.fetch = async (url, request) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "chat.postMessage") {
      posts += 1;
      acceptedText = JSON.parse(request.body).text;
      return Response.json({ ok: true, ts: "123.456" });
    }
    if (method === "conversations.history")
      return Response.json({ ok: true, messages: [{ ts: "123.456", text: acceptedText }], response_metadata: { next_cursor: "" } });
    throw new Error(`unexpected ${url}`);
  };
  const ambiguityStore = {
    async claimReminderBatch(input) {
      claims += 1;
      return { leaseToken: input.leaseToken, attempt: claims, firstAttemptAt: "2026-09-17T09:00:00Z", jobs: [job("U1"), job("U2", "review")] };
    },
    async finishReminderBatch(input) {
      if (firstFinish) { firstFinish = false; throw new Error("db finish unavailable"); }
      finishes.push(input);
      return true;
    },
  };
  await assert.rejects(
    () => sendReminderBatch({ token: "token", teamId: "TQA", channelId: "CPUBLIC", now: "2026-09-17T09:00:00Z", store: ambiguityStore }),
    /finish unavailable/,
  );
  assert.equal(await sendReminderBatch({ token: "token", teamId: "TQA", channelId: "CPUBLIC", now: "2026-09-17T09:05:00Z", store: ambiguityStore }), 2);
  assert.equal(posts, 1);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].status, "sent");

  let oversizedPosts = 0;
  const oversizedFinish = [];
  globalThis.fetch = async () => { oversizedPosts += 1; return Response.json({ ok: true }); };
  const oversizedStore = {
    async claimReminderBatch() { return { leaseToken: "large", attempt: 1, firstAttemptAt: "2026-09-17T09:00:00Z", jobs: Array.from({ length: 101 }, (_, index) => job(`U${index}`)) }; },
    async finishReminderBatch(input) { oversizedFinish.push(input); return true; },
  };
  assert.equal(await sendReminderBatch({ token: "token", teamId: "TQA", channelId: "CPUBLIC", now: "2026-09-17T09:00:00Z", store: oversizedStore }), 0);
  assert.equal(oversizedPosts, 0);
  assert.equal(oversizedFinish[0].errorCode, "batch_too_large");
  console.log("PASS reminder batch: bounds, rate-limit retry, exact-history ambiguity reconciliation and no duplicate post");
} finally {
  globalThis.fetch = originalFetch;
}
