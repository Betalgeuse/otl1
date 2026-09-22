import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
let enrolled = 0;
let armed = 0;
let lookups = 0;
let observed;
mock.module("../src/community-store.ts", () => ({
  CommunityStore: class {
    async observeMemberJoin(value) {
      observed = value;
      enrolled += 1;
      return {};
    }
  },
}));
const { enrollReminderMember } = await import("../src/community-enrollment.ts");
const env = {
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "fake",
  DATABASE_URL: "postgresql://user:pass@qa.neon.tech/db",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_CLOCK: {
    getByName() {
      return {
        async refresh() {
          armed += 1;
          return { next: 1 };
        },
      };
    },
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  lookups += 1;
  const id = new URL(url).searchParams.get("user");
  return Response.json({
    ok: true,
    user: {
      id,
      is_bot: id === "UBOT",
      is_app_user: false,
      deleted: false,
      real_name: "Member Name",
    },
  });
};
try {
  await enrollReminderMember(
    { type: "message", subtype: "channel_join", channel: "COTHER", user: "UMEMBER" },
    env,
  );
  assert.equal(lookups, 0);
  await enrollReminderMember(
    { type: "member_joined_channel", channel: "CPUBLIC", user: "UBOT", event_ts: "1789700400.123" },
    env,
  );
  assert.equal(enrolled, 0);
  await enrollReminderMember(
    {
      type: "member_joined_channel",
      channel: "CPUBLIC",
      user: "UMEMBER",
      event_ts: "1789700400.123",
    },
    env,
  );
  assert.equal(enrolled, 1);
  assert.equal(observed.member.userId, "UMEMBER");
  assert.equal(observed.member.displayName, "Member Name");
  assert.equal(observed.observedAt, new Date(1789700400123).toISOString());
  assert.equal(armed, 1);
  console.log(
    "PASS verified human join atomically restores current membership/profile while preserving reminder preferences and arms clock",
  );
} finally {
  globalThis.fetch = originalFetch;
}
await enrollReminderMember(
  { type: "message", channel: "CPUBLIC", user: "UMEMBER", text: "hello" },
  env,
);
assert.equal(enrolled, 1);
