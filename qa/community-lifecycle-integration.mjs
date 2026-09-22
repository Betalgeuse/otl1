import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { handleRequest } = await import("../src/index.ts");
const { communityInteraction } = await import("../src/community-interactions.ts");
const { signLifecycleAction } = await import("../src/community-lifecycle-interactions.ts");
const { signReferralServiceRequest } = await import("../src/community-referral-intake.ts");

const env = {
  SLACK_TEAM_ID: "TTEST",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
  DATABASE_URL: "postgresql://user:pass@fake.neon.tech/test",
  PUBLIC_APPLICATIONS_ENABLED: "false",
  REFERRALS_ENABLED: "false",
};
const context = { waitUntil() {} };
const runtime = { env, store: {} };

// Given an unconfigured public intake, when the site calls the core service,
// then the core fails closed before the Slack-only 404 branch or any DB access.
const disabled = await handleRequest(
  new Request("https://core.invalid/internal/referrals/apply", { method: "POST", body: "{}" }),
  runtime,
  context,
);
assert.equal(disabled.status, 503);

// Given enabled public intake, when the signature is absent, then it is rejected
// by the site-service boundary without consuming a Slack request.
env.PUBLIC_APPLICATIONS_ENABLED = "true";
env.REFERRALS_ENABLED = "true";
const unsigned = await handleRequest(
  new Request("https://core.invalid/internal/referrals/resolve", { method: "POST", body: "{}" }),
  runtime,
  context,
);
assert.equal(unsigned.status, 401);
const secret = "service-test-secret";
env.SITE_CORE_HMAC_SECRET = secret;
const timestamp = Math.floor(Date.now() / 1000);
const path = "/internal/referrals/resolve";
const nonce = "nonce-for-body-tamper-0001";
const signature = await signReferralServiceRequest(
  { method: "POST", path, body: "{}", timestamp, nonce }, secret,
);
const tampered = await handleRequest(new Request(`https://core.invalid${path}`, {
  method: "POST", body: '{"referralToken":"tampered"}',
  headers: { "x-otl-timestamp": String(timestamp), "x-otl-nonce": nonce,
    "x-otl-signature": signature },
}), runtime, context);
assert.equal(tampered.status, 401);
console.log("PASS core referral routing: disabled=503 unsigned=401 body-tamper=401");

const actionSecret = "lifecycle-action-test-secret";
const actionValue = await signLifecycleAction({ actionId: "lifecycle_extend", teamId: "TTEST",
  channelId: "CPUBLIC", ownerId: "UOWNER", revision: 2, key: "notice:extend" }, actionSecret);
const actionEnv = { ...env, COMMUNITY_ENABLED: "true", LIFECYCLE_MODE: "enforce",
  LIFECYCLE_ACTION_SECRET: actionSecret, SLACK_BOT_TOKEN: "unused" };
const lifecyclePayload = {
  type: "block_actions", team: { id: "TTEST" }, user: { id: "UOWNER" },
  container: { channel_id: "DPRIVATE" },
  actions: [{ action_id: "lifecycle_extend", value: actionValue, action_ts: "123.456" }],
};
await assert.rejects(() => communityInteraction({ ...lifecyclePayload,
  team: { id: "TOTHER" } }, actionEnv, context.waitUntil));
await assert.rejects(() => communityInteraction({ ...lifecyclePayload,
  user: { id: "UOTHER" } }, actionEnv, context.waitUntil));
await assert.rejects(() => communityInteraction({ ...lifecyclePayload,
  container: { channel_id: "CPUBLIC" } }, actionEnv, context.waitUntil));
const invitePayload = { type: "block_actions", team: { id: "TTEST" },
  user: { id: "UOTHER" }, container: { channel_id: "DPRIVATE" },
  actions: [{ action_id: "community_invite_approve", value: JSON.stringify({ requestId: "REQ-12345678", revision: 0 }), action_ts: "123.456" }] };
await assert.rejects(() => communityInteraction(invitePayload, actionEnv, context.waitUntil));
await assert.rejects(() => communityInteraction({ ...invitePayload,
  user: { id: "UADMIN" }, container: { channel_id: "CPUBLIC" } }, actionEnv, context.waitUntil));
console.log("PASS private actions: cross-team, non-owner, non-DM and non-admin denied before effects");
const { referralSlackPort } = await import("../src/community-referral-slack.ts");
const strictPortEnv = new Proxy({ SLACK_BOT_TOKEN: "xoxb-test" }, {
  get(target, property) {
    if (property !== "SLACK_BOT_TOKEN") throw new Error(`unexpected port binding: ${String(property)}`);
    return target.SLACK_BOT_TOKEN;
  },
});
const savedFetch = globalThis.fetch;
let portAuthorization = null;
globalThis.fetch = async (_url, options) => {
  portAuthorization = options.headers.Authorization;
  return Response.json({ ok: true, message_ts: "1.1" });
};
try {
  assert.equal(await referralSlackPort(strictPortEnv).postEphemeral({
    channelId: "CPUBLIC", userId: "UOWNER", text: "Synthetic private link",
  }), "1.1");
} finally { globalThis.fetch = savedFetch; }
assert.equal(portAuthorization, "Bearer xoxb-test");
console.log("PASS referral Slack port reads only the bot token");


// Given the rollout flags at their shipped defaults, a due tick has no DB or
// Slack effect even if the optional bindings are absent.
const { runMembershipDue } = await import("../src/community-membership-schedule.ts");
let disabledQueries = 0;
const disabledTick = await runMembershipDue({ ...actionEnv, LIFECYCLE_MODE: "disabled",
  REFERRALS_ENABLED: "false", COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC" },
  { async queryJson() { disabledQueries += 1; throw new Error("disabled path queried DB"); } },
  "CPUBLIC", Date.now());
assert.equal(disabledQueries, 0);
assert.equal(disabledTick.nextDue, null);
console.log("PASS default-off membership tick: zero DB and effects");
const { readFile } = await import("node:fs/promises");
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
assert.equal(config.vars.REVIEW_THREAD_V2, "true");
assert.equal(config.vars.REFERRALS_ENABLED, "true");
for (const name of ["GARDEN_RECONCILIATION", "PUBLIC_APPLICATIONS_ENABLED"])
  assert.equal(config.vars[name], "false");
assert.equal(config.vars.LIFECYCLE_MODE, "disabled");
assert.ok(config.r2_buckets.some((binding) => binding.binding === "INVITE_PRIVATE_OBJECTS"));
const example = await readFile(new URL("../.dev.vars.example", import.meta.url), "utf8");
const generated = await readFile(new URL("../worker-configuration.d.ts", import.meta.url), "utf8");
for (const name of ["SITE_CORE_HMAC_SECRET", "INVITE_EMAIL_PEPPER", "INVITE_PRIVATE_KEK",
  "INVITE_PRIVATE_KEK_VERSION", "REFERRAL_TOKEN_SECRET", "LIFECYCLE_ACTION_SECRET"]) {
  assert.ok(example.split("\n").includes(`${name}=`));
  assert.match(generated, new RegExp(`\\b${name}: string;`));
}
assert.doesNotMatch(generated, /--env-file \/tmp\//);
console.log("PASS binding contract: public garden routing on, unfinished flags off, dedicated R2, blank secret names, canonical generated types");


const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { resolve } = await import("node:path");
const exec = promisify(execFile);
for (const scenario of ["qa/garden-route-provenance.mjs", "qa/referral-pagination.mjs",
  "qa/referral-retention-pg.mjs", "qa/community-runtime-pg.mjs"]) {
  const result = await exec("bun", [scenario], { cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  if (result.stdout.trim()) process.stdout.write(result.stdout);
}
