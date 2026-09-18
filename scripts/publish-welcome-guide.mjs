import {
  executeWelcomeGuideCommand,
  replaceWelcomeGuideForUser,
} from "../src/community-guide.ts";

const required = [
  "SLACK_TEAM_ID",
  "SLACK_BOT_TOKEN",
  "DATABASE_URL",
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
  DATABASE_URL: process.env.DATABASE_URL,
  COMMUNITY_WELCOME_CHANNEL_ID: process.env.COMMUNITY_WELCOME_CHANNEL_ID,
  COMMUNITY_BOT_USER_ID: process.env.COMMUNITY_BOT_USER_ID,
  COMMUNITY_ADMIN_ID: process.env.COMMUNITY_ADMIN_ID,
  COMMUNITY_GUIDE_SOURCE_TS: process.env.COMMUNITY_GUIDE_SOURCE_TS,
  COMMUNITY_GUIDE_SOURCE_EDITED_TS: process.env.COMMUNITY_GUIDE_SOURCE_EDITED_TS,
  COMMUNITY_GUIDE_FILE_IDS: process.env.COMMUNITY_GUIDE_FILE_IDS,
  COMMUNITY_GUIDE_VERSION: process.env.COMMUNITY_GUIDE_VERSION,
  COMMUNITY_GUIDE_CONTENT_HASH: process.env.COMMUNITY_GUIDE_CONTENT_HASH,
  BOARD_SIGNING_SECRET: "unused",
  PUBLIC_BASE_URL: "unused",
};

const release = await executeWelcomeGuideCommand({ kind: "publish", apply }, env);
if (!replaceUser || !apply) {
  console.log(JSON.stringify({
    mode: replaceUser ? "targeted-repair" : "publish",
    ...release,
    ...(replaceUser ? { userId: replaceUser } : {}),
  }));
} else {
  const delivery = await replaceWelcomeGuideForUser(replaceUser, env);
  console.log(JSON.stringify({
    mode: "targeted-repair",
    applied: delivery.delivered,
    version: delivery.version,
    contentHash: delivery.contentHash,
    userId: replaceUser,
    ...(delivery.messageTs ? { messageTs: delivery.messageTs } : {}),
    next: delivery.delivered ? "browser-verify-then-retire-stale-message" : "already-delivered",
  }));
}
