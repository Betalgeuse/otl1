import assert from "node:assert/strict";
import { mock } from "bun:test";
import { canonicalGuideContent } from "../src/community-guide-content.ts";

const deliveries = new Map();
const versions = new Map();
const posts = [];
let latest = null;
let publishCalls = 0;

mock.module("../src/store.ts", () => ({
  NeonStore: class {
    async queryJson(_sql, params) {
      const op = params[0];
      const payload = JSON.parse(params[1]);
      if (op === "publish") {
        publishCalls += 1;
        const existing = versions.get(payload.version);
        if (existing && existing.hash !== payload.hash) throw new Error("Guide version conflict");
        if (!existing) {
          versions.set(payload.version, payload);
          latest = payload;
        }
        return payload.hash;
      }
      if (op === "latest" || op === "repair_latest") return latest;
      const key = `${payload.userId}:${payload.version}:${payload.hash}`;
      if (op === "claim" || op === "repair_claim") {
        if (deliveries.has(key)) return false;
        deliveries.set(key, { status: "claimed", reason: payload.reason });
        return true;
      }
      const current = deliveries.get(key);
      if (!current || current.status !== "claimed") return false;
      deliveries.set(key, { ...current, status: payload.status, messageTs: payload.messageTs });
      return true;
    }
  }
}));

const {
  deliverWelcomeGuide,
  executeWelcomeGuideCommand,
  inspectWelcomeGuideSource,
  publishWelcomeGuide,
  replaceWelcomeGuideForUser,
} = await import("../src/community-guide.ts");

const files = ["FLOGO1", "FDAILY2"];
let body = "v0.0.55 안내 <#CDAILY> <!channel>";
let author = "UADMIN";
let sourceTs = "123.456";
let editedTs = "123.789";
let sourceFiles = files.map((id) => ({ id }));
let historyReads = 0;
let failPosts = false;
let postAuthor = "UBOTPROFILE";
const authorizationHeaders = [];

globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  authorizationHeaders.push(new Headers(options?.headers).get("Authorization"));
  if (parsed.pathname.endsWith("users.info")) {
    const user = parsed.searchParams.get("user");
    return Response.json({ ok: true, user: { id: user, is_bot: user === "UBOT", deleted: false } });
  }
  if (parsed.pathname.endsWith("conversations.history")) {
    historyReads += 1;
    return Response.json({
      ok: true,
      messages: [{ ts: sourceTs, user: author, text: body, files: sourceFiles, edited: { ts: editedTs } }],
    });
  }
  if (parsed.pathname.endsWith("chat.postMessage")) {
    if (failPosts) return Response.json({ ok: false, error: "channel_not_found" });
    const post = JSON.parse(options.body);
    posts.push(post);
    return Response.json({
      ok: true,
      ts: `456.${posts.length}`,
      message: { user: postAuthor, bot_id: "BGUIDE" },
    });
  }
  throw new Error("unexpected endpoint");
};

async function releaseEnv(version = "v0.0.55") {
  const canonical = await canonicalGuideContent(body, files);
  return {
    SLACK_TEAM_ID: "TQA",
    SLACK_BOT_TOKEN: "xoxb-guide-bot",
    SLACK_USER_TOKEN: "xoxp-admin-must-not-be-used",
    COMMUNITY_BOT_USER_ID: "UBOTPROFILE",
    DATABASE_URL: "fake",
    GUIDE_DATABASE_URL: "fake",
    GUIDE_ADMIN_DATABASE_URL: "fake",
    BOARD_SIGNING_SECRET: "unused",
    PUBLIC_BASE_URL: "unused",
    COMMUNITY_WELCOME_CHANNEL_ID: "CWELCOME",
    COMMUNITY_ADMIN_ID: "UADMIN",
    COMMUNITY_GUIDE_SOURCE_TS: sourceTs,
    COMMUNITY_GUIDE_SOURCE_EDITED_TS: editedTs,
    COMMUNITY_GUIDE_FILE_IDS: files.join(","),
    COMMUNITY_GUIDE_VERSION: version,
    COMMUNITY_GUIDE_CONTENT_HASH: canonical.hash,
  };
}

const env55 = await releaseEnv();
const inspected = await inspectWelcomeGuideSource(env55);
assert.equal(inspected.hash, env55.COMMUNITY_GUIDE_CONTENT_HASH);
assert.equal(inspected.editedTs, "123.789");
assert.doesNotMatch(inspected.body, /<!channel>/);
assert.match(inspected.body, /@channel/);

const dryRun = await executeWelcomeGuideCommand({ kind: "publish", apply: false }, env55);
assert.deepEqual(dryRun, { applied: false, version: "v0.0.55", contentHash: inspected.hash });
assert.equal(publishCalls, 0);
const applied = await executeWelcomeGuideCommand({ kind: "publish", apply: true }, env55);
assert.deepEqual(applied, { applied: true, version: "v0.0.55", contentHash: inspected.hash });
assert.equal(publishCalls, 1);
await publishWelcomeGuide(env55);
assert.equal(versions.size, 1);

body = "발행되지 않은 수정";
const event = { type: "member_joined_channel", channel: "CWELCOME", user: "UNEW" };
const readsBeforeJoin = historyReads;
await deliverWelcomeGuide(event, env55);
await deliverWelcomeGuide({ ...event, type: "message", subtype: "channel_join" }, env55);
assert.equal(posts.length, 1);
assert.doesNotMatch(posts[0].text, /발행되지 않은 수정/);
assert.deepEqual(posts[0].blocks.map((block) => block.slack_file?.id).filter(Boolean), files);
assert.equal(historyReads, readsBeforeJoin, "joins only read the immutable DB release");

body = "v0.0.56 수정 안내 <!channel>";
sourceTs = "124.456";
editedTs = "124.789";
const env56 = await releaseEnv("v0.0.56");
await publishWelcomeGuide(env56);
const repaired = await replaceWelcomeGuideForUser("UNEW", env56);
assert.equal(repaired.delivered, true);
assert.equal(repaired.version, "v0.0.56");
assert.equal(repaired.messageTs, "456.2");
assert.equal(
  deliveries.get(`UNEW:${repaired.version}:${repaired.contentHash}`).messageTs,
  "456.2",
);
assert.equal((await replaceWelcomeGuideForUser("UNEW", env56)).delivered, false);
assert.equal(posts.filter((post) => post.text.includes("<@UNEW>")).length, 2);
assert.deepEqual(posts.at(-1).blocks.map((block) => block.slack_file?.id).filter(Boolean), files);

const raceEvent = { ...event, user: "URACE" };
await Promise.all([deliverWelcomeGuide(raceEvent, env56), deliverWelcomeGuide(raceEvent, env56)]);
assert.equal(posts.filter((post) => post.text.includes("<@URACE>")).length, 1);
for (const post of posts) {
  assert.equal(post.channel, "CWELCOME");
  assert.equal(post.username, undefined);
  assert.equal(post.as_user, undefined);
  assert.equal(post.user, undefined);
}
assert.ok(authorizationHeaders.length > 0);
assert.deepEqual(new Set(authorizationHeaders), new Set(["Bearer xoxb-guide-bot"]));

failPosts = true;
await assert.rejects(deliverWelcomeGuide({ ...event, user: "UFAIL" }, env56));
failPosts = false;
await deliverWelcomeGuide({ ...event, user: "UFAIL" }, env56);
assert.equal(posts.some((post) => post.text.includes("<@UFAIL>")), false);

postAuthor = "UADMIN";
await assert.rejects(
  replaceWelcomeGuideForUser("UWRONG", env56),
  /OT1L 봇 게시자를 확인하지 못했습니다/,
);
assert.equal(
  deliveries.get(`UWRONG:${latest.version}:${latest.hash}`).status,
  "failed",
);
postAuthor = "UBOTPROFILE";

await assert.rejects(
  inspectWelcomeGuideSource({ ...env56, COMMUNITY_GUIDE_SOURCE_EDITED_TS: "124.790" }),
  /편집 시각/,
);
await assert.rejects(
  inspectWelcomeGuideSource({ ...env56, COMMUNITY_GUIDE_CONTENT_HASH: "0".repeat(64) }),
  /해시/,
);
author = "UOTHER";
await assert.rejects(inspectWelcomeGuideSource(env56), /관리자가 작성한/);
author = "UADMIN";
sourceFiles = [{ id: "FDAILY2" }, { id: "FLOGO1" }];
await assert.rejects(inspectWelcomeGuideSource(env56), /첨부 이미지/);

console.log("PASS immutable welcome publication, dry-run, exact source pinning, same-user correction, concurrency, ordered images, and fail-closed delivery");
