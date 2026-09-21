import assert from "node:assert/strict";
import {
  handleReferralIntakeRequest,
  signReferralServiceRequest,
} from "../src/community-referral-intake.ts";
import { handleReferralTeamJoin } from "../src/community-referral-join.ts";
import { referralSlackPort } from "../src/community-referral-slack.ts";

const secret = "direct-join-service-secret-0123456789";
const pepper = Buffer.alloc(32, 9).toString("base64url");
const nonces = new Set();
const starts = [];
const store = {
  async claimServiceNonce(digest) {
    if (nonces.has(digest)) return false;
    nonces.add(digest);
    return true;
  },
  async startDirectJoin(input) {
    starts.push(input);
    return { kind: "accepted", requestId: input.requestId };
  },
};
const payload = {
  referralToken: "D".repeat(32),
  submissionKey: "direct-join-001",
  consentVersion: "invite-consent-v1",
  consentedAt: new Date().toISOString(),
  email: "Person@Example.com",
};

async function directRequest(nonce, body = JSON.stringify(payload)) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/internal/referrals/direct-join";
  const signature = await signReferralServiceRequest(
    { method: "POST", path, body, timestamp, nonce },
    secret,
  );
  return handleReferralIntakeRequest(
    new Request(`https://core.invalid${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-otl-timestamp": String(timestamp),
        "x-otl-nonce": nonce,
        "x-otl-signature": signature,
      },
      body,
    }),
    { SITE_CORE_HMAC_SECRET: secret, SLACK_TEAM_ID: "TQA", INVITE_EMAIL_PEPPER: pepper },
    store,
  );
}

const accepted = await directRequest("direct-join-nonce-001");
assert.equal(accepted.status, 202);
assert.deepEqual(await accepted.json(), { accepted: true });
assert.equal(starts.length, 1);
assert.equal(starts[0].emailDigest.length, 64);
assert.equal("email" in starts[0], false);
assert.equal("privateRef" in starts[0], false);

const malformed = await directRequest(
  "direct-join-nonce-002",
  JSON.stringify({ ...payload, displayName: "website must not collect this" }),
);
assert.equal(malformed.status, 400);

const effects = [];
const joinStore = {
  async observeJoinedMember() {},
  async attributeJoin(input) {
    return input.eventId === "Ev-match"
      ? { kind: "attributed", receiptId: "RCP-DIRECT", newlyAttributed: true }
      : input.eventId === "Ev-duplicate"
        ? { kind: "attributed", receiptId: "RCP-DIRECT", newlyAttributed: false }
        : { kind: "unmatched" };
  },
};
const slack = {
  async person(userId) {
    return {
      id: userId,
      teamId: "TQA",
      email: "person@example.com",
      isBot: false,
      isApp: false,
      deleted: false,
    };
  },
  async postJoinIntroduction(input) {
    effects.push(input);
    return "1.1";
  },
};
const env = { SLACK_TEAM_ID: "TQA", INVITE_EMAIL_PEPPER: pepper };
assert.equal(
  await handleReferralTeamJoin(
    { teamId: "TQA", eventId: "Ev-match", userId: "UNEW" },
    env,
    joinStore,
    slack,
  ),
  true,
);
assert.equal(effects.length, 1);
assert.equal(effects[0].userId, "UNEW");
assert.equal(effects[0].blocks[0].accessory.action_id, "community_introduction");
await handleReferralTeamJoin(
  { teamId: "TQA", eventId: "Ev-duplicate", userId: "UNEW" },
  env,
  joinStore,
  slack,
);
await handleReferralTeamJoin(
  { teamId: "TQA", eventId: "Ev-unmatched", userId: "ULEAK" },
  env,
  joinStore,
  slack,
);
assert.equal(effects.length, 1);

const originalFetch = globalThis.fetch;
const slackCalls = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  slackCalls.push({ method: url.pathname.split("/").at(-1), body });
  if (url.pathname.endsWith("conversations.open"))
    return Response.json({ ok: true, channel: { id: "DINTRO" } });
  return Response.json({ ok: true, ts: "2.2" });
};
try {
  const realPort = referralSlackPort({ SLACK_BOT_TOKEN: "xoxb-test" });
  await realPort.postJoinIntroduction({
    userId: "UNEW",
    effectKey: "referral-introduction:RCP-DIRECT",
    text: "intro",
    blocks: effects[0].blocks,
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.deepEqual(
  slackCalls.map((call) => call.method),
  ["conversations.open", "chat.postMessage"],
);
assert.equal(slackCalls[0].body.users, "UNEW");
assert.equal(slackCalls[1].body.channel, "DINTRO");
assert.match(slackCalls[1].body.client_msg_id, /^[0-9a-f-]{36}$/);

console.log(
  "PASS direct referral: signed-start=202 no-private-payload=1 strict-input=1 exact-attribution-prompt=1 duplicate-prompt=0 unmatched-prompt=0",
);
