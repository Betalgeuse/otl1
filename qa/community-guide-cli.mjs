import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { canonicalGuideContent } from "../src/community-guide-content.ts";
import { WELCOME_GUIDE_RELEASE } from "../src/community-guide-release.ts";

const run = promisify(execFile);
const contentHash = (await canonicalGuideContent(WELCOME_GUIDE_RELEASE.body, ["FLOGO1", "FDAILY2"]))
  .hash;
const env = {
  ...process.env,
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "xoxb-secret-must-not-print",
  GUIDE_ADMIN_DATABASE_URL: "postgresql://secret-must-not-print",
  COMMUNITY_WELCOME_CHANNEL_ID: "CWELCOME1",
  COMMUNITY_BOT_USER_ID: "UBOTPROFILE",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_GUIDE_FILE_IDS: "FLOGO1,FDAILY2",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC001",
  COMMUNITY_FEEDBACK_CHANNEL_ID: "CFEEDBACK1",
  COMMUNITY_RELEASE_CHANNEL_ID: "CTOWNHALL1",
  COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS: "CDEVELOP01,CENGLISH01,CINVEST001",
  COMMUNITY_GUIDE_CANVAS_ID: "FCANVAS01",
  COMMUNITY_GUIDE_CANVAS_URL: "https://example.slack.com/docs/TQA/FCANVAS01",
  COMMUNITY_GUIDE_ANCHOR_TS: "1790000000.100000",
};
const preload = new URL("./fixtures/welcome-guide-fetch.mjs", import.meta.url).pathname;
const applyPreload = new URL("./fixtures/welcome-guide-apply.mjs", import.meta.url).pathname;

const dryRun = await run("bun", ["--preload", preload, "scripts/publish-welcome-guide.mjs"], {
  env,
  encoding: "utf8",
});
assert.deepEqual(JSON.parse(dryRun.stdout), {
  mode: "publish",
  version: "v0.0.58",
  contentHash,
  publicationCount: 0,
});
assert.doesNotMatch(dryRun.stdout, /secret-must-not-print|안내|xoxb|postgresql/);

const repairDryRun = await run(
  "bun",
  ["--preload", preload, "scripts/publish-welcome-guide.mjs", "--replace-user", "UNEW"],
  { env, encoding: "utf8" },
);
const targetDigest = createHash("sha256").update("guide-target:UNEW").digest("hex");
assert.deepEqual(JSON.parse(repairDryRun.stdout), {
  mode: "targeted-repair",
  version: "v0.0.58",
  contentHash,
  targetDigest,
  deliveryCount: 0,
});
assert.doesNotMatch(repairDryRun.stdout + repairDryRun.stderr, /UNEW|123\.456/);
const repairApplied = await run(
  "bun",
  [
    "--preload",
    applyPreload,
    "scripts/publish-welcome-guide.mjs",
    "--replace-user",
    "UNEW",
    "--apply",
  ],
  { env, encoding: "utf8" },
);
assert.deepEqual(JSON.parse(repairApplied.stdout), {
  mode: "targeted-repair",
  version: "v0.0.58",
  contentHash,
  targetDigest,
  messageDigest: createHash("sha256").update("guide-message:456.789").digest("hex"),
  deliveryCount: 1,
});
assert.doesNotMatch(repairApplied.stdout + repairApplied.stderr, /UNEW|456\.789|123\.456/);
await assert.rejects(
  run(
    "bun",
    ["--preload", preload, "scripts/publish-welcome-guide.mjs", "--replace-user", "not-a-user"],
    { env, encoding: "utf8" },
  ),
  /Invalid replacement user ID/,
);

console.log(
  "PASS welcome publisher defaults to credential-safe dry-run and targeted repair requires --apply to mutate",
);
