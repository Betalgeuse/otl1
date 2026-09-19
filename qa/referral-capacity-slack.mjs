import assert from "node:assert/strict";
import { mock } from "bun:test";
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { handleRequest } = await import("../src/index.ts");
const { sign } = await import("../src/signing.ts");

const env = {
  COMMUNITY_ENABLED: "true", REFERRALS_ENABLED: "true", SLACK_TEAM_ID: "TQA",
  COMMUNITY_CHANNEL_ID: "CADMIN", COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC", COMMUNITY_ADMIN_ID: "UADMIN",
  SLACK_SIGNING_SECRET: "capacity-signing-secret", SLACK_BOT_TOKEN: "synthetic-token",
  REFERRAL_ADMIN_DATABASE_URL: "postgresql://otl_referral_admin_login:synthetic@fake.neon.tech/test",
  DATABASE_URL: "postgresql://runtime:synthetic@fake.neon.tech/test",
};
const queries = [];
const posts = [];
let stale = false;
let staleReads = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://fake.neon.tech/sql") {
    assert.equal(init.headers["Neon-Connection-String"], env.REFERRAL_ADMIN_DATABASE_URL);
    const query = JSON.parse(init.body);
    queries.push(query);
    if (query.query.includes("referral_capacity_admin_execute")) {
      if (stale && query.params[0] === "set_member") return Response.json({ error: "conflict" }, { status: 409 });
      return Response.json({ rows: [[JSON.stringify({ maximum: 2, used: 1, joined: 1, reserved: 0, remaining: 1, revision: stale && ++staleReads > 1 ? 5 : 4 })]] });
    }
    throw new Error("unexpected SQL operation");
  }
  if (String(url) === "https://slack.com/api/chat.postMessage") {
    posts.push(JSON.parse(init.body));
    return Response.json({ ok: true, ts: "123.456" });
  }
  throw new Error("unexpected outbound request");
};
const event = (user, channel, text) => ({ type: "event_callback", team_id: "TQA",
  event_id: `Ev${crypto.randomUUID().replaceAll("-", "")}`,
  event: { type: "message", channel, user, text, ts: String(Date.now() / 1000) } });
const signed = async (payload, bad = false) => {
  const body = JSON.stringify(payload);
  const time = String(Math.floor(Date.now() / 1000));
  const signature = bad ? "v0=bad" : `v0=${await sign(`v0:${time}:${body}`, env.SLACK_SIGNING_SECRET)}`;
  const pending = [];
  const response = await handleRequest(new Request("https://core.invalid/slack/events", {
    method: "POST", body, headers: { "x-slack-request-timestamp": time, "x-slack-signature": signature },
  }), { env, store: {} }, { waitUntil(promise) { pending.push(promise); } });
  return { response, completed: await Promise.allSettled(pending) };
};
try {
  assert.equal((await signed(event("UADMIN", "CADMIN", "초대 한도 <@UOWNER> 보기"), true)).response.status, 401);
  for (const payload of [event("UOTHER", "CADMIN", "초대 한도 <@UOWNER> 3"),
    event("UADMIN", "CPUBLIC", "초대 한도 <@UOWNER> 3")]) {
    const result = await signed(payload);
    assert.ok(result.completed.some((entry) => entry.status === "rejected"));
  }
  assert.equal(queries.length, 0);
  assert.equal(posts.length, 0);
  const inspected = await signed(event("UADMIN", "CADMIN", "초대 한도 <@UOWNER> 보기"));
  assert.ok(inspected.completed.every((entry) => entry.status === "fulfilled"));
  assert.equal(posts[0].channel, "UADMIN");
  assert.match(posts[0].text, /남음 1명/);
  const set = await signed(event("UADMIN", "CADMIN", "초대 한도 <@UOWNER> 3"));
  assert.ok(set.completed.every((entry) => entry.status === "fulfilled"));
  assert.equal(queries.length, 3);
  assert.equal(queries[2].params[0], "set_member");
  assert.equal(JSON.parse(queries[2].params[1]).userId, "UOWNER");
  assert.equal(JSON.parse(queries[2].params[1]).expectedRevision, 4);
  assert.equal(posts[1].channel, "UADMIN");
  stale = true;
  const conflict = await signed(event("UADMIN", "CADMIN", "초대 한도 <@UOWNER> 3"));
  assert.ok(conflict.completed.every((entry) => entry.status === "fulfilled"));
  assert.equal(posts[2].channel, "UADMIN");
  assert.match(posts[2].text, /동시에 변경/);
  console.log("CAPACITY_SIGNED_SLACK=PASS forged=401 wrong_actor_denied=1 public_denied=1 private_read=1 private_set=1");
} finally {
  globalThis.fetch = originalFetch;
}
