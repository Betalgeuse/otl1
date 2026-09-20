import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const issueInputs = [];
const links = new Map();
const unavailableMembers = new Set(["UUNAVAILABLE"]);
const ephemeralEffects = [];

mock.module("../src/community-referral-store.ts", () => ({
  CommunityReferralStore: class {
    async issueLink(input) {
      issueInputs.push(input);
      if (unavailableMembers.has(input.userId)) return { kind: "unavailable" };
      const existing = links.get(input.userId);
      if (existing) return { kind: "issued", linkId: existing.linkId, created: false, remaining: 1 };
      const issued = { linkId: input.linkId };
      links.set(input.userId, issued);
      return { kind: "issued", linkId: issued.linkId, created: true, remaining: 1 };
    }
  },
}));

mock.module("../src/community-referral-slack.ts", () => ({
  referralSlackPort: () => ({
    async postEphemeral(input) {
      ephemeralEffects.push(input);
      return "1.000001";
    },
  }),
}));

const { canonicalGuideContent, guideBlocks } = await import("../src/community-guide-content.ts");
const { communityInteraction } = await import("../src/community-interactions.ts");

const guide = await canonicalGuideContent("환영 안내", ["FLOGO1", "FDAILY2"]);
const blocks = guideBlocks("UNEW", guide);
const inviteAction = blocks
  .find((block) => block.type === "actions")
  ?.elements.find((element) => element.action_id === "community_referral_link");

// Given a bot-delivered welcome guide, when a member reads it,
// then the guide exposes one actor-scoped invitation action without changing guide content.
assert.ok(inviteAction);
assert.deepEqual(JSON.parse(inviteAction.value), { ownerId: "actor", key: "referral_link" });

const env = {
  COMMUNITY_ENABLED: "true",
  REFERRALS_ENABLED: "true",
  PUBLIC_APPLICATIONS_ENABLED: "true",
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "xoxb-test",
  DATABASE_URL: "postgresql://user:pass@qa.neon.tech/test",
  PUBLIC_APPLICATION_ORIGIN: "https://otl1.hyuk.me",
  REFERRAL_TOKEN_SECRET: "referral-secret-for-stable-member-links",
  COMMUNITY_WELCOME_CHANNEL_ID: "CWELCOME",
  COMMUNITY_CHANNEL_ID: "CADMIN",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_ADMIN_ID: "UADMIN",
};

function click(userId, changes = {}) {
  return {
    type: "block_actions",
    team: { id: "TQA" },
    user: { id: userId },
    container: { channel_id: "CWELCOME" },
    actions: [
      {
        action_id: "community_referral_link",
        value: inviteAction.value,
        action_ts: "1700000000.123456",
      },
    ],
    ...changes,
  };
}

async function press(payload, configuredEnv = env) {
  const pending = [];
  const response = await communityInteraction(payload, configuredEnv, (effect) => pending.push(effect));
  assert.equal(response?.status, 200);
  await Promise.all(pending);
}

// Given someone else's welcome guide, when UMEMBER presses its invitation action,
// then only UMEMBER receives a stable private member-specific link.
await press(click("UMEMBER"));
assert.equal(issueInputs.at(-1)?.userId, "UMEMBER");
assert.equal(ephemeralEffects.at(-1)?.userId, "UMEMBER");
assert.equal(ephemeralEffects.at(-1)?.channelId, "CWELCOME");
const memberLink = ephemeralEffects.at(-1)?.text;
assert.match(memberLink, /^https:\/\/otl1\.hyuk\.me\/r\/[A-Za-z0-9_-]{32}/);

// Given the same member presses again, when the stable link already exists,
// then it is returned privately without minting a different token.
await press(click("UMEMBER"));
assert.equal(ephemeralEffects.at(-1)?.text, memberLink);
assert.equal(issueInputs.at(-1)?.userId, "UMEMBER");

// Given another active member presses the same shared guide button,
// when the action is handled, then that member cannot receive UMEMBER's link.
await press(click("UOTHER"));
assert.equal(issueInputs.at(-1)?.userId, "UOTHER");
assert.notEqual(ephemeralEffects.at(-1)?.text, memberLink);
assert.match(ephemeralEffects.at(-1)?.text, /^https:\/\/otl1\.hyuk\.me\/r\/[A-Za-z0-9_-]{32}/);

// Given the database reports an unavailable member, when they press the button,
// then no invitation token is exposed in the private explanation.
await press(click("UUNAVAILABLE"));
assert.equal(issueInputs.at(-1)?.userId, "UUNAVAILABLE");
assert.doesNotMatch(ephemeralEffects.at(-1)?.text, /\/r\//);

// Given either referral capability is off, when a member presses the button,
// then the action is acknowledged and privately explains that a link is unavailable without DB issuance.
const issuedBeforeDisabledPress = issueInputs.length;
await press(click("UDISABLED"), { ...env, REFERRALS_ENABLED: "false" });
assert.equal(issueInputs.length, issuedBeforeDisabledPress);
assert.equal(ephemeralEffects.at(-1)?.userId, "UDISABLED");
assert.doesNotMatch(ephemeralEffects.at(-1)?.text, /\/r\//);
await press(click("UDISABLED"), { ...env, PUBLIC_APPLICATIONS_ENABLED: "false" });
assert.equal(issueInputs.length, issuedBeforeDisabledPress);
assert.doesNotMatch(ephemeralEffects.at(-1)?.text, /\/r\//);

// Given a forged workspace or a different channel, when it replays the action,
// then authorization rejects it before a link or private Slack effect is created.
for (const forged of [
  click("UFORGED", { team: { id: "TOTHER" } }),
  click("UFORGED", { container: { channel_id: "CPUBLIC" } }),
  click("UFORGED", {
    actions: [
      {
        action_id: "community_referral_link",
        value: JSON.stringify({ ownerId: "UVICTIM", key: "referral_link" }),
        action_ts: "1700000000.123456",
      },
    ],
  }),
]) {
  const issuesBefore = issueInputs.length;
  const ephemeralsBefore = ephemeralEffects.length;
  await assert.rejects(() => communityInteraction(forged, env, () => {}), /사용할 수 없/);
  assert.equal(issueInputs.length, issuesBefore);
  assert.equal(ephemeralEffects.length, ephemeralsBefore);
}

assert.ok(ephemeralEffects.every((effect) => effect.channelId === "CWELCOME"));
console.log("PASS welcome invitation: actor-scoped guide action, stable private links, feature-off denial, and forged scope rejection");
