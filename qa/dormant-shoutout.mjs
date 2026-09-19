import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { communityInteraction } = await import("../src/community-interactions.ts");

const env = {
  COMMUNITY_ENABLED: "true",
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "test",
  DATABASE_URL: "postgresql://user:pass@qa.neon.tech/db",
  COMMUNITY_CHANNEL_ID: "CADMIN",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
};
const records = new Map();
const claimed = new Set();
const posts = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).endsWith("/sql")) {
    const { params } = JSON.parse(options.body);
    const [operation, raw] = params;
    const payload = JSON.parse(raw);
    let value;
    switch (operation) {
      case "members":
        value = ["UACTOR", "UACTIVE"];
        break;
      case "put_record":
        value = { ...payload, status: "pending" };
        records.set(payload.key, value);
        break;
      case "claim_record":
        value = records.has(payload.key) && !claimed.has(payload.key);
        if (value) claimed.add(payload.key);
        break;
      case "finish_record":
        value = claimed.has(payload.key);
        break;
      default:
        throw new Error(`Unexpected store operation: ${operation}`);
    }
    return Response.json({ rows: [[JSON.stringify(value)]] });
  }
  assert.equal(String(url), "https://slack.com/api/chat.postMessage");
  posts.push(JSON.parse(options.body));
  return Response.json({ ok: true, ts: `12.${posts.length}` });
};

const submission = (target, id) => ({
  type: "view_submission",
  team: { id: "TQA" },
  user: { id: "UACTOR" },
  view: {
    id,
    callback_id: "community_shoutout_submit",
    private_metadata: JSON.stringify({
      userId: "UACTOR",
      channelId: "CPUBLIC",
      source: "10.000001",
      thread: "10.000001",
      date: "2026-09-18",
    }),
    state: {
      values: {
        target: { value: { selected_user: target } },
        message: { value: { value: "수고했어요" } },
      },
    },
  },
});
try {
  const denied = [];
  const dormant = await communityInteraction(submission("UDORM", "VDORM"), env, (effect) => denied.push(effect));
  assert.equal((await dormant.json()).response_action, "errors");
  assert.equal(denied.length, 0);
  assert.equal(records.size, 0);
  assert.equal(posts.length, 0);

  const dormantActor = await communityInteraction(
    { ...submission("UACTIVE", "VACTOR"), user: { id: "UDORM" }, view: {
      ...submission("UACTIVE", "VACTOR").view,
      private_metadata: JSON.stringify({ userId: "UDORM", channelId: "CPUBLIC", source: "10.000001", thread: "10.000001", date: "2026-09-18" }),
    } },
    env,
    () => { throw new Error("dormant actor scheduled an effect"); },
  );
  assert.equal((await dormantActor.json()).response_action, "errors");
  assert.equal(records.size, 0);

  const accepted = [];
  const active = await communityInteraction(submission("UACTIVE", "VACTIVE"), env, (effect) => accepted.push(effect));
  assert.deepEqual(await active.json(), { response_action: "clear" });
  await Promise.all(accepted);
  assert.equal(records.size, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /<@UACTIVE>/);
  const replay = [];
  assert.deepEqual(
    await (await communityInteraction(submission("UACTIVE", "VACTIVE"), env, (effect) => replay.push(effect))).json(),
    { response_action: "clear" },
  );
  await Promise.all(replay);
  assert.equal(records.size, 1);
  assert.equal(posts.length, 1);
  console.log("PASS shoutout consumer: dormant target denied privately with zero effects; active target posted once");
} finally {
  globalThis.fetch = originalFetch;
}
