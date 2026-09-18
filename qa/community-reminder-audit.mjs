import assert from "node:assert/strict";
import {
  chunkReminderJobs,
  renderReminderBatch,
  sendReminderBatches,
} from "../src/community-reminder-batch.ts";
import { collectCurrentChannelMembers } from "../src/community-membership.ts";

const job = (index, kind = "goal") => ({
  teamId: "TQA",
  channelId: "CPUBLIC",
  userId: `U${String(index).padStart(9, "0")}`,
  key: `reminder:2026-09-18:${kind}`,
  date: "2026-09-18",
  kind,
});
for (const count of [101, 201]) {
  const chunks = chunkReminderJobs(Array.from({ length: count }, (_, index) => job(index)));
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    count === 101 ? [100, 1] : [100, 100, 1],
  );
  assert.equal(new Set(chunks.flat().map((item) => item.userId)).size, count);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
    assert.ok((renderReminderBatch(chunk) ?? "").length <= 2_800);
  }
}

const claims = [
  {
    leaseToken: "a",
    attempt: 1,
    firstAttemptAt: "2026-09-18T02:00:00Z",
    jobs: Array.from({ length: 100 }, (_, index) => job(index)),
  },
  {
    leaseToken: "b",
    attempt: 1,
    firstAttemptAt: "2026-09-18T02:00:00Z",
    jobs: Array.from({ length: 100 }, (_, index) => job(index + 100)),
  },
  { leaseToken: "c", attempt: 1, firstAttemptAt: "2026-09-18T02:00:00Z", jobs: [job(200)] },
];
const finishes = [];
const posts = [];
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, request) => {
    if (new URL(url).pathname.endsWith("chat.postMessage")) {
      posts.push(JSON.parse(request.body));
      return Response.json({ ok: true, ts: `100.${posts.length}` });
    }
    throw new Error(`unexpected ${url}`);
  };
  const store = {
    async claimReminderBatch() {
      return claims.shift() ?? null;
    },
    async finishReminderBatch(input) {
      finishes.push(input);
      return true;
    },
  };
  assert.equal(
    await sendReminderBatches({
      token: "token",
      teamId: "TQA",
      channelId: "CPUBLIC",
      now: "2026-09-18T02:00:00Z",
      store,
    }),
    201,
  );
  assert.equal(posts.length, 3);
  assert.equal(finishes.length, 3);
  assert.equal(posts.flatMap((post) => post.text.match(/<@[^>]+>/g) ?? []).length, 201);
} finally {
  globalThis.fetch = originalFetch;
}

let profileCalls = 0;
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("conversations.members"))
    return Response.json({ ok: true, members: [], response_metadata: { next_cursor: "" } });
  profileCalls += 1;
  return Response.json({ ok: true, user: {} });
};
try {
  const empty = await collectCurrentChannelMembers(
    "token",
    "CPUBLIC",
    "UBOT",
    "2026-09-18T02:00:00Z",
  );
  assert.deepEqual(empty.members, []);
  assert.equal(profileCalls, 0);
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "PASS reminder audit: deterministic 101/201 chunks, bounded posts, and complete empty snapshots",
);
