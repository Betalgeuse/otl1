import assert from "node:assert/strict";
import { GardenDeliveryStore } from "../src/community-garden-store.ts";

const row = {
  teamId: "TQA", channelId: "CQA", userId: "UQA", deliveryKey: "garden:1",
  date: "2026-09-19", revision: 1, source: "123.456", thread: "1800.001",
  undoKey: null, status: "claimed", attempts: 1, leaseToken: "lease-1",
  payloadDigest: null, messageTs: null, projectionKey: "projection:1",
  routeKind: "review_prompt", routeProvenance: "canonical_review",
};
const db = { async queryJson() { return row; } };
const store = new GardenDeliveryStore(db);
const input = { teamId: "TQA", channelId: "CQA", leaseToken: "lease-1", now: "2026-09-19T12:00:00Z" };
assert.equal((await store.claim(input)).routeProvenance, "canonical_review");
row.routeProvenance = "forged_route";
await assert.rejects(() => store.claim(input), /Invalid garden route provenance/);
console.log("PASS garden parser: canonical review accepted; forged provenance rejected");
