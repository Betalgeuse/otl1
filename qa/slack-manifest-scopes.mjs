import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { personEmail } from "../src/community-referral-slack-person.ts";

const run = promisify(execFile);
const generated = await run(
  process.execPath,
  ["scripts/slack-manifest.mjs", "https://example.invalid"],
  { encoding: "utf8" },
);
const manifest = JSON.parse(generated.stdout);
const scopes = manifest.oauth_config.scopes.bot;
assert.equal(new Set(scopes).size, scopes.length);
assert.ok(scopes.includes("users:read"));
assert.ok(scopes.includes("users:read.email"));

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      user: {
        id: "UQA",
        team_id: "TQA",
        is_bot: false,
        deleted: false,
        is_app_user: false,
        is_stranger: false,
        profile: { email: "Member@Example.com" },
      },
    });
  assert.equal(
    await personEmail({ workspaceId: "TQA", userId: "UQA" }, "xoxb"),
    "member@example.com",
  );
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      user: {
        id: "UQA",
        team_id: "TQA",
        is_bot: false,
        deleted: false,
        is_app_user: false,
        is_stranger: false,
        profile: {},
      },
    });
  await assert.rejects(
    personEmail({ workspaceId: "TQA", userId: "UQA" }, "xoxb"),
    /Slack 계정 이메일/,
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "PASS Slack email scope remains narrowly justified by active invitation recipient binding",
);
