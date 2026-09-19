import assert from "node:assert/strict";
import {
  deliverLifecycleNotices,
  LIFECYCLE_REQUIRED_SCOPES,
} from "../src/community-lifecycle-delivery.ts";
import {
  lifecycleNoticeKinds,
  ordinaryReminderEligibility,
  parseLifecycleMode,
} from "../src/community-lifecycle-evaluator.ts";
import {
  parseLifecycleAction,
  signLifecycleAction,
} from "../src/community-lifecycle-interactions.ts";
import { runLifecycleMaintenance } from "../src/community-lifecycle-runtime.ts";
import { CommunitySlackError } from "../src/community-social.ts";

assert.equal(parseLifecycleMode(undefined), "disabled");
assert.equal(parseLifecycleMode("shadow"), "shadow");
assert.equal(parseLifecycleMode("enforce"), "enforce");
assert.throws(() => parseLifecycleMode("unsafe"));
assert.deepEqual(ordinaryReminderEligibility("active"), { eligible: true });
assert.deepEqual(ordinaryReminderEligibility("grace"), {
  eligible: false,
  reason: "lifecycle_grace",
});
assert.deepEqual(ordinaryReminderEligibility("dormant"), {
  eligible: false,
  reason: "lifecycle_dormant",
});
assert.deepEqual(lifecycleNoticeKinds(), [
  "grace_start",
  "three_days",
  "one_day",
  "extension",
  "closure",
  "return",
]);

const binding = {
  actionId: "lifecycle_extend",
  teamId: "TQA",
  channelId: "CQA",
  ownerId: "UOWNER",
  revision: 3,
  key: "extend:3",
};
const signed = await signLifecycleAction(binding, "secret");
assert.deepEqual(await parseLifecycleAction(signed, "UOWNER", "UADMIN", "secret"), binding);
await assert.rejects(() => parseLifecycleAction(signed, "UOTHER", "UADMIN", "secret"));
await assert.rejects(() => parseLifecycleAction(`${signed}x`, "UOWNER", "UADMIN", "secret"));
const restore = await signLifecycleAction(
  { ...binding, actionId: "lifecycle_restore_error", key: "restore:3" },
  "secret",
);
await assert.rejects(() => parseLifecycleAction(restore, "UOWNER", "UADMIN", "secret"));
assert.equal(
  (await parseLifecycleAction(restore, "UADMIN", "UADMIN", "secret")).actionId,
  "lifecycle_restore_error",
);
assert.equal(lifecycleNoticeKinds().includes("continue"), false);
assert.deepEqual(LIFECYCLE_REQUIRED_SCOPES, ["im:write"]);

const notice = (effectKey, attempts = 1) => ({
  teamId: "TQA",
  channelId: "CQA",
  userId: "UOWNER",
  effectKey,
  kind: "grace_start",
  revision: 3,
  scheduledAt: "2026-10-01T00:00:00Z",
  attempts,
  leaseToken: "from-store",
  dmChannelId: null,
  payload: {},
});

class FakeDeliveryStore {
  queue = [];
  prepared = [];
  finished = [];
  async claimNotices({ leaseToken, limit }) {
    return this.queue.splice(0, limit).map((item) => ({ ...item, leaseToken }));
  }
  async prepareNotice(input) {
    this.prepared.push(input);
    return true;
  }
  async finishNotice(input) {
    this.finished.push(input);
    return true;
  }
}

const accepted = new Map();
const slackBodies = [];
let loseAcceptedResponse = true;
const slackServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const method = new URL(request.url).pathname.slice(5);
    const payload = await request.json();
    if (method === "conversations.open") return Response.json({ ok: true, channel: { id: "DQA" } });
    slackBodies.push(payload);
    const existing = accepted.get(payload.client_msg_id);
    if (existing) return Response.json({ ok: true, ts: existing });
    accepted.set(payload.client_msg_id, "1.1");
    if (loseAcceptedResponse) {
      loseAcceptedResponse = false;
      return Response.json({ ok: false, error: "accepted_response_lost" }, { status: 599 });
    }
    return Response.json({ ok: true, ts: "1.1" });
  },
});
const fakeSlack = async (_token, method, payload) => {
  try {
    const response = await fetch(`http://127.0.0.1:${slackServer.port}/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new CommunitySlackError("transport_error");
    return await response.json();
  } catch (error) {
    if (error instanceof Error) throw new CommunitySlackError("transport_error");
    throw error;
  }
};
const deliveryStore = new FakeDeliveryStore();
deliveryStore.queue.push(notice("grace:3:start"));
const firstDelivery = await deliverLifecycleNotices({
  store: deliveryStore,
  teamId: "TQA",
  token: "fake",
  signingSecret: "secret",
  now: Date.parse("2026-10-01T00:00:00Z"),
  call: fakeSlack,
});
assert.deepEqual(
  { sent: firstDelivery.sent, failed: firstDelivery.failed, dead: firstDelivery.dead },
  { sent: 0, failed: 1, dead: 0 },
);
deliveryStore.queue.push(notice("grace:3:start", 2));
const reconciled = await deliverLifecycleNotices({
  store: deliveryStore,
  teamId: "TQA",
  token: "fake",
  signingSecret: "secret",
  now: Date.parse("2026-10-01T00:01:00Z"),
  call: fakeSlack,
});
assert.equal(reconciled.sent, 1, JSON.stringify({ reconciled, finished: deliveryStore.finished }));
assert.equal(accepted.size, 1, "client_msg_id reconciles an accepted response loss");
slackServer.stop(true);
assert.equal(JSON.stringify(slackBodies).includes("continue"), false);
assert.deepEqual(
  slackBodies
    .at(0)
    .blocks.at(1)
    .elements.map((item) => item.action_id),
  ["lifecycle_extend", "lifecycle_review", "lifecycle_stop"],
);

for (const [code, expectedStatus, expectedCode] of [
  ["rate_limited", "failed", "http_429"],
  ["http_503", "failed", "http_503"],
  ["missing_scope", "dead", "missing_im_write"],
]) {
  const store = new FakeDeliveryStore();
  store.queue.push(notice(`failure:${code}`));
  await deliverLifecycleNotices({
    store,
    teamId: "TQA",
    token: "fake",
    signingSecret: "secret",
    now: Date.parse("2026-10-01T00:00:00Z"),
    call: async (_token, method) => {
      if (method === "conversations.open") {
        if (code === "missing_scope") throw new CommunitySlackError(code);
        return { ok: true, channel: { id: "DQA" } };
      }
      throw new CommunitySlackError(code, code === "rate_limited" ? 17 : null);
    },
  });
  assert.equal(store.finished.at(-1).status, expectedStatus);
  assert.equal(store.finished.at(-1).errorCode, expectedCode);
}

const maintenanceCalls = [];
const evaluationQueue = [
  { processed: 10, candidates: 0, transitions: 0, possiblyMore: true, nextDue: null },
  { processed: 1, candidates: 0, transitions: 0, possiblyMore: false, nextDue: null },
];
const maintenanceStore = {
  async evaluateBatch(input) {
    maintenanceCalls.push(["evaluate", input]);
    return evaluationQueue.shift();
  },
  async reconcile(input) {
    maintenanceCalls.push(["reconcile", input]);
    return { processed: 0, candidates: 0, transitions: 0, possiblyMore: false, nextDue: null };
  },
  async claimNotices() {
    maintenanceCalls.push(["claim"]);
    return [];
  },
  async prepareNotice() {
    return true;
  },
  async finishNotice() {
    return true;
  },
};
const maintenanceInput = {
  store: maintenanceStore,
  teamId: "TQA",
  channelId: "CQA",
  token: "fake",
  signingSecret: "secret",
  mode: "enforce",
  maintenance: true,
  serviceHealthComplete: true,
  serviceDate: "2026-10-01",
  now: Date.parse("2026-10-02T00:00:00Z"),
};
await runLifecycleMaintenance(maintenanceInput);
assert.equal(maintenanceCalls.length, 0, "maintenance fails closed before DB or Slack");
await runLifecycleMaintenance({
  ...maintenanceInput,
  maintenance: false,
  serviceHealthComplete: false,
});
assert.equal(maintenanceCalls.length, 0, "incomplete common-delivery health fails closed");
const saturated = await runLifecycleMaintenance({ ...maintenanceInput, maintenance: false });
assert.equal(saturated.possiblyMore, true);
assert.deepEqual(
  maintenanceCalls.map(([phase]) => phase),
  ["evaluate", "reconcile", "claim"],
);
maintenanceCalls.length = 0;
const afterRestart = await runLifecycleMaintenance({ ...maintenanceInput, maintenance: false });
assert.equal(afterRestart.possiblyMore, false, "a restarted fake clock drains the next fair batch");
assert.deepEqual(
  maintenanceCalls.map(([phase]) => phase),
  ["evaluate", "reconcile", "claim"],
);
let dbOutageSlackCalls = 0;
await assert.rejects(() =>
  runLifecycleMaintenance({
    ...maintenanceInput,
    maintenance: false,
    store: {
      ...maintenanceStore,
      async evaluateBatch() {
        throw new Error("synthetic DB outage");
      },
      async claimNotices() {
        dbOutageSlackCalls += 1;
        return [];
      },
    },
  }),
);
assert.equal(dbOutageSlackCalls, 0, "DB outage produces no Slack effect");

const logCorpus = JSON.stringify({ delivery: reconciled, saturated });
assert.equal(/UOWNER|grace:3|ONE THING/.test(logCorpus), false);
console.log(
  "PASS lifecycle runtime: modes, typed reminder suppression, signed owner/admin actions, no continue, DM dedupe/retry/scope, maintenance and health fail-closed, bounded backlog",
);
