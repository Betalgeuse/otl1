import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { handleRequest } = await import("../src/index.ts");

const body = "command=%2Fone&text=goal";
const timestamp = String(Math.floor(Date.now() / 1000));
const secret = "synthetic-secret";
const signature = `v0=${createHmac("sha256", secret)
  .update(`v0:${timestamp}:${body}`)
  .digest("hex")}`;
let effects = 0;
const response = await handleRequest(
  new Request("https://test/slack/commands", {
    method: "POST",
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body,
  }),
  {
    env: { SLACK_SIGNING_SECRET: secret },
    store: new Proxy(
      {},
      {
        get() {
          effects += 1;
          throw new Error("No retired command writes");
        },
      },
    ),
  },
  {
    waitUntil() {
      effects += 1;
    },
  },
);
assert.match((await response.json()).text, /슬래시 명령은 종료/);
assert.equal(effects, 0);
assert.equal(JSON.parse(readFileSync("slack-manifest.json", "utf8")).features.slash_commands, undefined);

const retiredModules = [
  "src/invitations/process.ts",
  "src/invitations/requests.ts",
  "src/invitations/store.ts",
  "src/invitations/tokens.ts",
];
assert.deepEqual(retiredModules.filter(existsSync), []);
const canonicalSources = [
  "src/index.ts",
  "src/requests.ts",
  "src/worker-entry.ts",
  "wrangler.jsonc",
  "scripts/export-public-config.mjs",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
assert.doesNotMatch(
  canonicalSources,
  /NeonInvitations|InvitationStore|processInvitation|invitationCommand|INVITATIONS_ENABLED|INVITE_SIGNING_SECRET|kind:\s*["']invitation["']|member_status|issue_invite|redeem_invite|check_invite|quota_used|invitedBy|\bremaining\b|\bfounder\b|\badmitted\b/,
);
console.log(
  "PASS /one retired: signed command changes no records; manifest and canonical runtime contain no monthly invitation path",
);
