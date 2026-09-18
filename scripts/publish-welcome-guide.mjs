import { createHash } from "node:crypto";
import { executeWelcomeGuideCommand, replaceWelcomeGuideForUser } from "../src/community-guide.ts";

const required = [
  "SLACK_TEAM_ID",
  "SLACK_BOT_TOKEN",
  "GUIDE_ADMIN_DATABASE_URL",
  "COMMUNITY_WELCOME_CHANNEL_ID",
  "COMMUNITY_BOT_USER_ID",
  "COMMUNITY_ADMIN_ID",
  "COMMUNITY_GUIDE_SOURCE_TS",
  "COMMUNITY_GUIDE_SOURCE_EDITED_TS",
  "COMMUNITY_GUIDE_FILE_IDS",
  "COMMUNITY_GUIDE_VERSION",
  "COMMUNITY_GUIDE_CONTENT_HASH",
];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const replaceAt = args.indexOf("--replace-user");
const replaceUser = replaceAt >= 0 ? args[replaceAt + 1] : undefined;
const recognized = new Set(["--apply", "--replace-user", replaceUser]);
if (args.some((arg) => !recognized.has(arg)) || (replaceAt >= 0 && !replaceUser))
  throw new Error("Usage: bun scripts/publish-welcome-guide.mjs [--apply] [--replace-user U...]");
if (replaceUser && !/^[UW][A-Z0-9]+$/.test(replaceUser))
  throw new Error("Invalid replacement user ID");

const env = {
  SLACK_TEAM_ID: process.env.SLACK_TEAM_ID,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  GUIDE_ADMIN_DATABASE_URL: process.env.GUIDE_ADMIN_DATABASE_URL,
  COMMUNITY_WELCOME_CHANNEL_ID: process.env.COMMUNITY_WELCOME_CHANNEL_ID,
  COMMUNITY_BOT_USER_ID: process.env.COMMUNITY_BOT_USER_ID,
  COMMUNITY_ADMIN_ID: process.env.COMMUNITY_ADMIN_ID,
  COMMUNITY_GUIDE_SOURCE_TS: process.env.COMMUNITY_GUIDE_SOURCE_TS,
  COMMUNITY_GUIDE_SOURCE_EDITED_TS: process.env.COMMUNITY_GUIDE_SOURCE_EDITED_TS,
  COMMUNITY_GUIDE_FILE_IDS: process.env.COMMUNITY_GUIDE_FILE_IDS,
  COMMUNITY_GUIDE_VERSION: process.env.COMMUNITY_GUIDE_VERSION,
  COMMUNITY_GUIDE_CONTENT_HASH: process.env.COMMUNITY_GUIDE_CONTENT_HASH,
};

const release = await executeWelcomeGuideCommand({ kind: "publish", apply }, env);
if (!replaceUser || !apply) {
  const targetDigest = replaceUser
    ? createHash("sha256").update(`guide-target:${replaceUser}`).digest("hex")
    : undefined;
  console.log(
    JSON.stringify({
      mode: replaceUser ? "targeted-repair" : "publish",
      version: release.version,
      contentHash: release.contentHash,
      ...(replaceUser
        ? { targetDigest, deliveryCount: 0 }
        : { publicationCount: release.applied ? 1 : 0 }),
    }),
  );
} else {
  const delivery = await replaceWelcomeGuideForUser(replaceUser, env);
  const targetDigest = createHash("sha256").update(`guide-target:${replaceUser}`).digest("hex");
  const messageDigest = delivery.messageTs
    ? createHash("sha256").update(`guide-message:${delivery.messageTs}`).digest("hex")
    : undefined;
  console.log(
    JSON.stringify({
      mode: "targeted-repair",
      version: delivery.version,
      contentHash: delivery.contentHash,
      targetDigest,
      ...(messageDigest ? { messageDigest } : {}),
      deliveryCount: delivery.delivered ? 1 : 0,
    }),
  );
}
