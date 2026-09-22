import assert from "node:assert/strict";
import siteWorker from "../site/src/index.ts";

const referralToken = "A".repeat(32);
const slackInvite = "https://join.slack.com/t/otl1/shared_invite/zt-synthetic-token";
const calls = [];
const assets = {
  async fetch(request) {
    if (new URL(request.url).pathname !== "/referral.html") return new Response("not found", { status: 404 });
    return new Response(await Bun.file("site/dist/referral.html").text(), { headers: { "content-type": "text/html" } });
  },
};
const core = {
  async fetch(request) {
    const body = await request.text();
    calls.push({ path: new URL(request.url).pathname, body });
    if (new URL(request.url).pathname.endsWith("resolve")) return Response.json({ available: true });
    if (body.includes("rejected@example.com")) return Response.json({ accepted: false }, { status: 202 });
    return Response.json({ accepted: true }, { status: 202 });
  },
};
const baseEnv = {
  ASSETS: assets,
  CORE: core,
  RATE_LIMITER: { async limit() { return { success: true }; } },
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET: "synthetic-turnstile-secret",
  SITE_CORE_HMAC_SECRET: "synthetic-hmac-secret-with-enough-entropy",
  SLACK_SHARED_INVITE_URL: slackInvite,
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ success: true, hostname: "example.com" });
const form = (email = "person@example.com") => {
  const value = new FormData();
  value.set("email", email);
  value.set("consent", "invite-consent-v1");
  value.set("submissionKey", "submission-direct-join-1234");
  value.set("cf-turnstile-response", "synthetic-turnstile-token");
  return value;
};
const call = (env, body = form()) => siteWorker.fetch(new Request(`https://otl1.hyuk.me/r/${referralToken}/apply`, { method: "POST", body }), env);

try {
  const page = await siteWorker.fetch(new Request(`https://otl1.hyuk.me/r/${referralToken}`), baseEnv);
  const html = await page.text();
  assert.doesNotMatch(html, /name="displayName"|name="intent"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="consent"/);
  assert.match(html, />Slack에서 함께하기</);
  assert.match(html, /class="slack-mark"[^>]*aria-hidden="true"/);

  const accepted = await call(baseEnv);
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), slackInvite);
  assert.equal(accepted.headers.get("set-cookie"), null);
  const direct = calls.filter((entry) => entry.path === "/internal/referrals/direct-join");
  assert.equal(direct.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(direct[0].body)).sort(), ["consentVersion", "consentedAt", "email", "referralToken", "submissionKey"]);

  const rejected = await call(baseEnv, form("rejected@example.com"));
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("location"), null);

  for (const invalid of [
    undefined,
    "http://join.slack.com/t/otl1/shared_invite/token",
    "https://evil.example/t/otl1/shared_invite/token",
    "https://join.slack.com/t/otl1/shared_invite/token?next=https://evil.example",
    "https://join.slack.com/t/otl1/shared_invite/token#fragment",
    "https://user:pass@join.slack.com/t/otl1/shared_invite/token",
    "https://join.slack.com.evil.example/t/otl1/shared_invite/token",
    "https://join.slack.com/not-a-shared-invite",
  ]) {
    const response = await call({ ...baseEnv, SLACK_SHARED_INVITE_URL: invalid });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
  }

  assert.doesNotMatch(JSON.stringify(calls), /join\.slack\.com|zt-synthetic-token/);
  console.log("PASS site direct join: email-only form, signed Core start, safe 303, fail-closed invite URL, no receipt cookie or secret leak");
} finally {
  globalThis.fetch = originalFetch;
}
