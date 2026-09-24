import assert from "node:assert/strict";
import { inspectWelcomeGuideSource } from "../src/community-guide-publish.ts";

let fetches = 0;
globalThis.fetch = async () => { fetches += 1; throw new Error("Slack history must not be read"); };
const release = await inspectWelcomeGuideSource({
  SLACK_TEAM_ID: "TQA",
  COMMUNITY_WELCOME_CHANNEL_ID: "CQA",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_GUIDE_FILE_IDS: "FLOGO1,FDAILY2",
  GUIDE_ADMIN_DATABASE_URL: "unused",
});
assert.equal(release.version, "v0.0.61");
assert.equal(release.origin, "repo");
assert.equal(fetches, 0);
assert.deepEqual(release.orderedFileIds, ["FLOGO1", "FDAILY2"]);
console.log("PASS bot-owned guide release needs no mutable Slack source");
