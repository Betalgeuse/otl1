import assert from "node:assert/strict";
import { mock } from "bun:test";
import { StoreError } from "../src/store-types.ts";

const storeFailure = async () => {
  throw new StoreError("unavailable");
};
const mockBoth = (name, implementation) => {
  mock.module(`../src/${name}.ts`, () => implementation);
  mock.module(`../src/${name}`, () => implementation);
};
mockBoth("community-interest-due", { runInterestDue: storeFailure });
mockBoth("community-interest-reconcile", {
  reconcileInterestIntake: async () => ({ possiblyMore: false, retryNeeded: false, nextCursor: null }),
});
mockBoth("community-referral-reconcile", {
  reconcileInvitePrivateIntake: async () => ({ possiblyMore: false, nextCursor: null }),
});
mockBoth("community-referral-store", {
  CommunityReferralStore: class {},
});
mockBoth("community-retention-schedule", {
  runRetentionQueues: async () => ({ possiblyMore: false, failed: false }),
});
mockBoth("community-membership-due", {
  nextMembershipDue: async () => null,
});

const { runMembershipDue } = await import("../src/community-membership-schedule.ts");
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.join(" "));
try {
  await runMembershipDue(
    {
      COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
      DATABASE_MAINTENANCE: "false",
      LIFECYCLE_MODE: "disabled",
      REFERRALS_ENABLED: "false",
      INVITE_PRIVATE_OBJECTS: { async delete() {} },
      SLACK_TEAM_ID: "TQA",
      COMMUNITY_ADMIN_ID: "UADMIN",
    },
    { async queryJson() { return null; } },
    "CPUBLIC",
    Date.parse("2026-09-20T00:00:00.000Z"),
  );
} finally {
  console.error = originalError;
}

assert.equal(errors.length, 1);
const event = JSON.parse(errors[0]);
assert.equal(event.event, "community.membership.queue.failed");
assert.equal(event.queue, "interest");
assert.equal(event.errorType, "StoreError");
assert.equal(event.errorCode, "unavailable");
assert.equal(Object.hasOwn(event, "message"), false);
console.log("PASS membership queue failure exposes sanitized StoreError code");
