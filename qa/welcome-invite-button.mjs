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

const { canonicalGuideContent, guideBlocks, renderGuideChannels } = await import("../src/community-guide-content.ts");
const { WELCOME_GUIDE_RELEASE } = await import("../src/community-guide-release.ts");
const { communityInteraction } = await import("../src/community-interactions.ts");

const guide = await canonicalGuideContent("환영 안내", ["FLOGO1", "FDAILY2"]);
const blocks = guideBlocks("UNEW", guide, guide.body);
const channelEnv = {
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC001",
  COMMUNITY_FEEDBACK_CHANNEL_ID: "CFEEDBACK1",
  COMMUNITY_RELEASE_CHANNEL_ID: "CTOWNHALL1",
  COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS: "CDEVELOP01,CENGLISH01,CINVEST001",
};
const rendered = renderGuideChannels(WELCOME_GUIDE_RELEASE.body, channelEnv);
const expectedIds = ["CPUBLIC001", "CFEEDBACK1", "CTOWNHALL1", "CDEVELOP01", "CENGLISH01", "CINVEST001"];
assert.equal((WELCOME_GUIDE_RELEASE.body.match(/<#[CG]/g) ?? []).length, 0);
for (const id of expectedIds) assert.ok(rendered.includes(`<#${id}>`));
assert.equal((rendered.match(/<#[CG]/g) ?? []).length, 8);
assert.equal(rendered.includes("#chapter-developers"), false);
assert.equal(rendered.includes("#chapter-english"), false);
assert.equal(rendered.includes("#chapter-investment"), false);
const unrelated = "https://example.com/#daily-scrum: and #chapter-english in prose";
assert.ok(renderGuideChannels(`${WELCOME_GUIDE_RELEASE.body}\n${unrelated}`, channelEnv).endsWith(unrelated));
const renderedBlocks = guideBlocks("UNEW", guide, rendered);
assert.equal(renderedBlocks.filter((block) => block.type === "section").map((block) => block.text.text).join(""), `<@UNEW> 어서 오세요!!! 처음 오셨다면 이 안내부터 함께 읽어주세요.\n\n${rendered}`);
assert.ok(renderedBlocks.filter((block) => block.type === "section").every((block) => block.text.text.length <= 2900));
const headerLength = "<@UNEW> 어서 오세요!!! 처음 오셨다면 이 안내부터 함께 읽어주세요.\n\n".length;
const filler = "A".repeat(2900 - headerLength - rendered.indexOf("<#") - 3);
const longBlocks = guideBlocks("UNEW", guide, `${filler}${rendered}`)
  .filter((block) => block.type === "section").map((block) => block.text.text);
assert.equal(longBlocks.join(""), `<@UNEW> 어서 오세요!!! 처음 오셨다면 이 안내부터 함께 읽어주세요.\n\n${filler}${rendered}`);
assert.ok(longBlocks.every((text) => text.length <= 2900 && !/<#[^>]*$/.test(text)));
for (const bad of [undefined, "", "CDEVELOP01,CENGLISH01", "CDEVELOP01,CENGLISH01,CENGLISH01", "FINVALID01,CENGLISH01,CINVEST001"])
  assert.throws(() => renderGuideChannels(WELCOME_GUIDE_RELEASE.body, { ...channelEnv, COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS: bad }), /안내 채널/);
assert.throws(() => renderGuideChannels(WELCOME_GUIDE_RELEASE.body, { ...channelEnv, COMMUNITY_RELEASE_CHANNEL_ID: "CFEEDBACK1" }), /안내 채널/);
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

// Link issuance depends on referrals, while the temporary shared-Slack bypass
// keeps member invite pages usable with attributed applications paused.
const issuedBeforeDisabledPress = issueInputs.length;
await press(click("UDISABLED"), { ...env, REFERRALS_ENABLED: "false" });
assert.equal(issueInputs.length, issuedBeforeDisabledPress);
assert.equal(ephemeralEffects.at(-1)?.userId, "UDISABLED");
assert.doesNotMatch(ephemeralEffects.at(-1)?.text, /\/r\//);
await press(click("UBYPASS"), { ...env, PUBLIC_APPLICATIONS_ENABLED: "false" });
assert.equal(issueInputs.length, issuedBeforeDisabledPress + 1);
assert.equal(issueInputs.at(-1)?.userId, "UBYPASS");
assert.match(ephemeralEffects.at(-1)?.text, /^https:\/\/otl1\.hyuk\.me\/r\/[A-Za-z0-9_-]{32}/);

// Public daily-scrum member surfaces may expose the same actor-scoped invite action.
await press(click("UPUBLIC", { container: { channel_id: "CPUBLIC" } }));
assert.equal(issueInputs.at(-1)?.userId, "UPUBLIC");
assert.equal(ephemeralEffects.at(-1)?.channelId, "CPUBLIC");
assert.match(ephemeralEffects.at(-1)?.text, /^https:\/\/otl1\.hyuk\.me\/r\/[A-Za-z0-9_-]{32}/);

// Given a forged workspace or a different channel, when it replays the action,
// then authorization rejects it before a link or private Slack effect is created.
for (const forged of [
  click("UFORGED", { team: { id: "TOTHER" } }),
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

assert.ok(ephemeralEffects.every((effect) => ["CWELCOME", "CPUBLIC"].includes(effect.channelId)));
console.log("PASS welcome invitation: actor-scoped guide action, stable private links, feature-off denial, and forged scope rejection");
