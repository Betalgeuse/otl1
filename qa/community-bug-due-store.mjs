import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { CommunityBugDueDeliveryStore } = await import("../src/community-bug-delivery-due-store.ts");

const logs = [];
const originalConsoleError = console.error;
console.error = (line) => logs.push(JSON.parse(line));
try {
  const store = new CommunityBugDueDeliveryStore({
    async queryJson() {
      return [{ delivery_id: "not-an-integer" }];
    },
  });
  assert.deepEqual(
    await store.claim({
      teamId: "TQA",
      workerId: "clock",
      leaseToken: "lease",
      limit: 10,
      now: "2026-09-17T00:00:00.000Z",
    }),
    [],
  );
} finally {
  console.error = originalConsoleError;
}
assert.deepEqual(logs, [{ event: "community.bug.delivery.row.skipped", code: "malformed_row" }]);
console.log(
  "PASS due delivery parser: a malformed claimed row is isolated without logging payload data.",
);
