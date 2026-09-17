import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { CommunitySlackError } from "../src/community-social";

const bugRuns = [];
function maintenanceResult({
  reconciled = 0,
  expired = 0,
  claimed = 0,
  sent = claimed,
  failed = 0,
} = {}) {
  const reconcilePrivate = { processed: reconciled, possiblyMore: reconciled === 10 };
  const expiry = { processed: expired, possiblyMore: expired === 10 };
  const deliveries = { claimed, sent, failed, possiblyMore: claimed === 10 };
  return {
    reconcilePrivate,
    expiry,
    deliveries,
    possiblyMore: reconcilePrivate.possiblyMore || expiry.possiblyMore || deliveries.possiblyMore,
  };
}
let bugRun = async (_env, scheduledTime) => {
  bugRuns.push(scheduledTime);
  return maintenanceResult();
};
const scheduleRuns = [];
let scheduleRun = async (...args) => { scheduleRuns.push(args); return { common: 0, personal: 0 }; };

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
mock.module("../src/community-bug-delivery-scheduler.ts", () => ({
  runDueBugDeliveries: (...args) => bugRun(...args),
}));
mock.module("../src/community-scheduler.ts", () => ({
  runCommunitySchedule: (...args) => scheduleRun(...args),
}));
mock.module("../src/community-scheduler", () => ({
  runCommunitySchedule: (...args) => scheduleRun(...args),
}));

const {
  CommunityClock,
  armBugDeliveryClock,
  armCommunityClock,
  bugDeliveryClockName,
  nextAlarmTime,
} = await import("../src/community-clock.ts");

class FakeStorage {
  values = new Map();
  alarm = null;
  alarmWrites = [];
  async get(key) {
    return this.values.get(key);
  }
  async put(key, value) {
    this.values.set(key, value);
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(value) {
    this.alarm = value;
    this.alarmWrites.push(value);
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

function clock(storage, env = {}) {
  return new CommunityClock(
    { storage },
    {
      SLACK_TEAM_ID: "TQA",
      SLACK_BOT_TOKEN: "test",
      DATABASE_URL: "postgresql://test",
      BOARD_SIGNING_SECRET: "test",
      PUBLIC_BASE_URL: "https://test",
      COMMUNITY_ENABLED: "true",
      COMMUNITY_ADMIN_ID: "UADMIN",
      COMMUNITY_CHANNEL_ID: "CADMIN",
      COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
      ...env,
    },
  );
}

const now = Date.parse("2026-09-11T00:00:00Z");
assert.equal(nextAlarmTime([], now), null);
assert.equal(nextAlarmTime(["18:00", "10:00", "10:00"], now), Date.parse("2026-09-11T01:00:00Z"));
assert.equal(
  nextAlarmTime(["10:00"], Date.parse("2026-09-11T01:00:00Z")),
  Date.parse("2026-09-12T01:00:00Z"),
);
assert.equal(
  nextAlarmTime(["00:05"], Date.parse("2026-09-11T14:59:00Z")),
  Date.parse("2026-09-11T15:05:00Z"),
);
assert.throws(() => nextAlarmTime(["24:00"], now));

assert.deepEqual(await armCommunityClock({}, "admin"), { next: null });
let routed = "";
await armCommunityClock(
  {
    SLACK_TEAM_ID: "team",
    COMMUNITY_CLOCK: {
      getByName(name) {
        routed = name;
        return {
          async refresh(channel) {
            assert.equal(channel, "admin");
            return { next: now };
          },
        };
      },
    },
  },
  "admin",
);
assert.equal(routed, "team:admin");

assert.equal(bugDeliveryClockName("TQA"), "bug-delivery:TQA");
let bugArm;
const clientResult = await armBugDeliveryClock(
  {
    SLACK_TEAM_ID: "TQA",
    COMMUNITY_CLOCK: {
      getByName(name) {
        assert.equal(name, "bug-delivery:TQA");
        return {
          async armBugDelivery(input) {
            bugArm = input;
            return { role: "bug_delivery", armed: true, next: input.observedAt + 300_000 };
          },
        };
      },
    },
  },
  { reason: "activity", observedAt: now },
);
assert.deepEqual(bugArm, { reason: "activity", observedAt: now });
assert.deepEqual(clientResult, { role: "bug_delivery", armed: true, next: now + 300_000 });

const firstStorage = new FakeStorage();
const firstClock = clock(firstStorage);
const [first, concurrent] = await Promise.all([
  firstClock.armBugDelivery({ reason: "activity", observedAt: now }),
  firstClock.armBugDelivery({ reason: "activity", observedAt: now }),
]);
assert.deepEqual(first, { role: "bug_delivery", armed: true, next: now + 300_000 });
assert.deepEqual(concurrent, first);
assert.equal(firstStorage.values.get("role"), "bug_delivery");
assert.equal(firstStorage.alarmWrites.length, 1);
await assert.rejects(
  () =>
    firstClock.publishGarden({
      userId: "UADMIN",
      channelId: "CADMIN",
      date: "2026-09-11",
      source: "1.1",
      thread: "1.1",
      key: "garden",
      undoKey: null,
    }),
  /role/i,
);

const restartedClock = clock(firstStorage);
assert.deepEqual(
  await restartedClock.armBugDelivery({ reason: "activity", observedAt: now + 1 }),
  first,
);
assert.equal(firstStorage.alarmWrites.length, 1);

for (const values of [[["role", "community_schedule"]], [["channel", "CPUBLIC"]]]) {
  const storage = new FakeStorage();
  storage.values = new Map(values);
  await assert.rejects(
    () => clock(storage).armBugDelivery({ reason: "activity", observedAt: now }),
    /role|channel|scope/i,
  );
  assert.equal(storage.alarmWrites.length, 0);
}

const originalNow = Date.now;
try {
  Date.now = () => now;
  const idleStorage = new FakeStorage();
  assert.deepEqual(await clock(idleStorage).armBugDelivery({ reason: "cron", observedAt: now }), {
    role: "bug_delivery",
    armed: true,
    next: now + 3_600_000,
  });
  bugRuns.length = 0;
  await clock(idleStorage).alarm();
  assert.deepEqual(bugRuns, [], "an early empty alarm must not query Neon");
  assert.equal(idleStorage.alarm, now + 3_600_000);

  const failingStorage = new FakeStorage();
  await clock(failingStorage).armBugDelivery({
    reason: "due",
    observedAt: now - 300_000,
    nextDue: now,
  });
  const failureLogs = [];
  const originalConsoleError = console.error;
  console.error = (line) => failureLogs.push(JSON.parse(line));
  bugRun = async () => {
    assert.equal(failingStorage.alarm, now + 300_000, "next alarm must exist before DB work");
    throw new Error("synthetic database failure");
  };
  try {
    await clock(failingStorage).alarm();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failingStorage.alarm, now + 300_000);
  assert.equal(failingStorage.values.get("lastRun").failure, "Error");
  assert.equal(failingStorage.values.get("bugActivityDue"), now + 300_000);
  assert.deepEqual(failureLogs, [
    {
      event: "community.bug.clock.failed",
      scheduledTime: now,
      code: "boundary_failure",
      failure: "Error",
    },
  ]);
  bugRuns.length = 0;
  bugRun = async (_env, scheduledTime) => {
    bugRuns.push(scheduledTime);
    return maintenanceResult();
  };
  Date.now = () => now + 300_000;
  await clock(failingStorage).alarm();
  assert.deepEqual(bugRuns, [now + 300_000], "failed maintenance retries on the next active tick");
  Date.now = () => now;

  const maintenanceStorage = new FakeStorage();
  await clock(maintenanceStorage).armBugDelivery({
    reason: "due",
    observedAt: now - 300_000,
    nextDue: now,
  });
  let maintenanceRuns = 0;
  bugRun = async () => {
    maintenanceRuns += 1;
  };
  await clock(maintenanceStorage, { DATABASE_MAINTENANCE: "true" }).alarm();
  assert.equal(maintenanceRuns, 0);
  assert.equal(maintenanceStorage.alarm, now + 300_000);

  const disabledStorage = new FakeStorage();
  await clock(disabledStorage).armBugDelivery({
    reason: "due",
    observedAt: now - 300_000,
    nextDue: now,
  });
  await clock(disabledStorage, { COMMUNITY_ENABLED: "false" }).alarm();
  assert.equal(maintenanceRuns, 0);
  assert.equal(disabledStorage.alarm, now + 300_000);

  const dueStorage = new FakeStorage();
  await clock(dueStorage).armBugDelivery({
    reason: "due",
    observedAt: now - 300_000,
    nextDue: now,
  });
  bugRuns.length = 0;
  const maintenancePhases = [];
  bugRun = async (_env, scheduledTime, observeDue) => {
    bugRuns.push(scheduledTime);
    maintenancePhases.push("reconcile_private", "expire", "claim");
    await observeDue(now + 60_000);
    return maintenanceResult({ expired: 1, claimed: 2 });
  };
  await clock(dueStorage).alarm();
  assert.deepEqual(bugRuns, [now], "one bounded maintenance call owns due retry and 24h expiry");
  assert.deepEqual(maintenancePhases, ["reconcile_private", "expire", "claim"]);
  assert.equal(dueStorage.alarm, now + 60_000, "scheduler retry stays in local DO storage");

  for (const saturated of [{ reconciled: 10 }, { expired: 10 }, { claimed: 10 }]) {
    const backlogStorage = new FakeStorage();
    await clock(backlogStorage).armBugDelivery({
      reason: "due",
      observedAt: now - 300_000,
      nextDue: now,
    });
    let run = 0;
    bugRun = async () => {
      run += 1;
      return run === 1 ? maintenanceResult(saturated) : maintenanceResult();
    };
    await clock(backlogStorage).alarm();
    assert.equal(backlogStorage.alarm, now + 300_000);
    assert.equal(backlogStorage.values.get("lastRun").possiblyMore, true);
    Date.now = () => now + 300_000;
    await clock(backlogStorage).alarm();
    assert.equal(run, 2);
    assert.equal(backlogStorage.alarm, now + 300_000 + 3_600_000);
    assert.equal(backlogStorage.values.get("lastRun").possiblyMore, false);
    Date.now = () => now;
  }

  const normalStorage = new FakeStorage();
  normalStorage.values.set("role", "community_schedule");
  normalStorage.values.set("channel", "CPUBLIC");
  normalStorage.alarm = now;
  scheduleRuns.length = 0;
  bugRuns.length = 0;
  await clock(normalStorage).alarm();
  assert.equal(bugRuns.length, 0, "normal channel alarm must not duplicate bug maintenance");
  assert.equal(normalStorage.values.get("role"), "community_schedule");
  assert.notEqual(normalStorage.alarm, null);

  const limitedStorage = new FakeStorage();
  limitedStorage.values.set("role", "community_schedule");
  limitedStorage.values.set("channel", "CPUBLIC");
  limitedStorage.alarm = now;
  scheduleRun = async () => { throw new CommunitySlackError("rate_limited", 17); };
  await clock(limitedStorage, { DATABASE_URL: "postgresql://u:p@x.neon.tech/db" }).alarm();
  assert.equal(limitedStorage.alarm, now + 17_000);
  scheduleRun = async (...args) => { scheduleRuns.push(args); return { common: 0, personal: 0 }; };
} finally {
  Date.now = originalNow;
}

const { default: worker, handleRequest } = await import("../src/index.ts");
const signedArms = [];
const signedEffects = [];
let healthBindingCalls = 0;
let healthStorageCalls = 0;
let healthBucketCalls = 0;
let healthSlackCalls = 0;
const secret = "synthetic-signing-secret";
const signedAt = Math.floor(Date.now() / 1_000);
const runtime = {
  env: {
    SLACK_TEAM_ID: "TQA",
    SLACK_SIGNING_SECRET: secret,
    COMMUNITY_ENABLED: "true",
    COMMUNITY_CLOCK: {
      getByName(name) {
        assert.equal(name, "bug-delivery:TQA");
        return {
          async armBugDelivery(input) {
            signedArms.push(input);
            return { role: "bug_delivery", armed: true, next: input.observedAt + 300_000 };
          },
        };
      },
    },
  },
  store: {},
};
const context = {
  waitUntil(promise) {
    signedEffects.push(promise);
  },
};
const healthRuntime = {
  ...runtime,
  store: new Proxy(
    {},
    {
      get() {
        healthStorageCalls += 1;
        throw new Error("health must not access Neon storage");
      },
    },
  ),
  env: {
    ...runtime.env,
    BUG_PRIVATE_OBJECTS: new Proxy(
      {},
      {
        get() {
          healthBucketCalls += 1;
          throw new Error("health must not access R2 storage");
        },
      },
    ),
    COMMUNITY_CLOCK: {
      getByName() {
        healthBindingCalls += 1;
        throw new Error("health must not resolve a Durable Object stub");
      },
    },
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  healthSlackCalls += 1;
  throw new Error("health must not call Slack");
};
const health = await handleRequest(new Request("https://test/health"), healthRuntime, context);
assert.deepEqual(await health.json(), {
  status: "ok",
  capabilities: {
    bugDeliveryClock: {
      role: "bug_delivery",
      activityArming: true,
      dueDeadlineArming: true,
      cronBackup: true,
    },
  },
});
assert.equal(healthBindingCalls, 0, "health must not call a Durable Object binding");
assert.equal(signedEffects.length, 0, "health must not schedule background effects");
signedArms.length = 0;
const deployedHealth = await worker.fetch(
  new Request("https://test/health"),
  {
    ...healthRuntime.env,
    SLACK_BOT_TOKEN: "test",
    DATABASE_URL: "postgresql://test",
    BOARD_SIGNING_SECRET: "test",
    PUBLIC_BASE_URL: "https://test",
    DAILY_SCRUM_CHANNEL_ID: "CPUBLIC",
  },
  context,
);
const deployedHealthBody = await deployedHealth.json();
assert.equal(deployedHealthBody.configured, true);
assert.deepEqual(deployedHealthBody.capabilities, {
  bugDeliveryClock: {
    role: "bug_delivery",
    activityArming: true,
    dueDeadlineArming: true,
    cronBackup: true,
  },
});
assert.equal(healthBindingCalls, 0, "deployed health must remain side-effect free");
assert.equal(signedEffects.length, 0, "deployed health must not schedule background effects");
assert.equal(healthStorageCalls, 0, "health must not access Neon storage");
assert.equal(healthBucketCalls, 0, "health must not access R2 storage");
assert.equal(healthSlackCalls, 0, "health must not call Slack");
globalThis.fetch = originalFetch;
signedArms.length = 0;

function signedRequest(path, body) {
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${signedAt}:${body}`)
    .digest("hex")}`;
  return new Request(`https://test${path}`, {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(signedAt),
      "x-slack-signature": signature,
    },
    body,
  });
}

const eventBody = JSON.stringify({ type: "url_verification", challenge: "verified" });
assert.equal(
  (await handleRequest(signedRequest("/slack/events", eventBody), runtime, context)).status,
  200,
);
const interactionBody = "payload=%7Bbad";
assert.equal(
  (await handleRequest(signedRequest("/slack/interactions", interactionBody), runtime, context))
    .status,
  200,
);
await Promise.all(signedEffects);
assert.deepEqual(signedArms, [
  { reason: "activity", observedAt: signedAt * 1_000 },
  { reason: "activity", observedAt: signedAt * 1_000 },
]);

console.log(
  "PASS clocks: durable global bug tick re-arms before isolated maintenance; existing channel schedule remains separate.",
);
