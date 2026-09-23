import { mock } from "bun:test";
import assert from "node:assert/strict";

const deliveries = new Map();
const posts = [];
const canvasEdits = [];
const messageUpdates = [];
const pinAdds = [];
let latest;
let publishCalls = 0;
let failPosts = false;
let postAuthor = "UBOTPROFILE";
let historyReads = 0;

mock.module("../src/store.ts", () => ({
  NeonStore: class {
    async queryJson(_sql, params) {
      const op = params[0];
      const payload = JSON.parse(params[1]);
      if (op === "publish") {
        publishCalls += 1;
        if (latest && latest.hash !== payload.hash) throw new Error("Guide version conflict");
        latest = payload;
        return payload.hash;
      }
      if (op === "latest" || op === "repair_latest") return latest;
      const key = `${payload.userId}:${payload.version}:${payload.hash}`;
      if (op === "claim" || op === "repair_claim") {
        if (deliveries.has(key)) return false;
        deliveries.set(key, { status: "claimed" });
        return true;
      }
      const current = deliveries.get(key);
      if (!current || current.status !== "claimed") return false;
      deliveries.set(key, { ...current, status: payload.status, messageTs: payload.messageTs });
      return true;
    }
  },
}));

const {
  deliverWelcomeGuide,
  executeWelcomeGuideCommand,
  inspectWelcomeGuideSource,
  publishWelcomeGuide,
  replaceWelcomeGuideForUser,
} = await import("../src/community-guide.ts");

const env = {
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "xoxb-guide-bot",
  COMMUNITY_BOT_USER_ID: "UBOTPROFILE",
  GUIDE_DATABASE_URL: "runtime",
  GUIDE_ADMIN_DATABASE_URL: "admin",
  COMMUNITY_WELCOME_CHANNEL_ID: "CWELCOME1",
  COMMUNITY_GUIDE_CANVAS_ID: "FCANVAS01",
  COMMUNITY_GUIDE_CANVAS_URL: "https://example.slack.com/docs/TQA/FCANVAS01",
  COMMUNITY_GUIDE_ANCHOR_TS: "1790000000.100000",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_GUIDE_FILE_IDS: "FLOGO1,FDAILY2",
  COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC001",
  COMMUNITY_FEEDBACK_CHANNEL_ID: "CFEEDBACK1",
  COMMUNITY_RELEASE_CHANNEL_ID: "CTOWNHALL1",
  COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS: "CDEVELOP01,CENGLISH01,CINVEST001",
};

globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("conversations.history")) {
    historyReads += 1;
    throw new Error("mutable Slack guide source must not be fetched");
  }
  if (parsed.pathname.endsWith("users.info")) {
    const user = parsed.searchParams.get("user");
    return Response.json({ ok: true, user: { id: user, is_bot: false, deleted: false } });
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
  if (parsed.pathname.endsWith("canvases.edit")) {
    canvasEdits.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  }
  if (parsed.pathname.endsWith("chat.update")) {
    messageUpdates.push(JSON.parse(options.body));
    return Response.json({ ok: true, ts: "1790000000.100000", channel: "CWELCOME1" });
  }
  if (parsed.pathname.endsWith("pins.add")) {
    pinAdds.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  }
  throw new Error("unexpected endpoint");
};

const inspected = await inspectWelcomeGuideSource(env);
assert.equal(inspected.version, "v0.0.60");
assert.equal(inspected.origin, "repo");
assert.deepEqual(inspected.orderedFileIds, ["FLOGO1", "FDAILY2"]);
assert.match(inspected.body, /친구 초대하기 버튼/);
assert.equal(
  (await executeWelcomeGuideCommand({ kind: "publish", apply: false }, env)).applied,
  false,
);
assert.equal(publishCalls, 0);
assert.equal(
  (await executeWelcomeGuideCommand({ kind: "publish", apply: true }, env)).applied,
  true,
);
assert.equal(publishCalls, 1);
assert.equal(canvasEdits.length, 1);
assert.equal(canvasEdits[0].canvas_id, "FCANVAS01");
assert.equal(canvasEdits[0].changes[0].operation, "replace");
assert.doesNotMatch(canvasEdits[0].changes[0].document_content.markdown, /^#/);
assert.equal(messageUpdates.length, 1);
assert.equal(messageUpdates[0].ts, "1790000000.100000");
assert.equal(messageUpdates[0].blocks[0].accessory.url, env.COMMUNITY_GUIDE_CANVAS_URL);
assert.deepEqual(pinAdds, [{ channel: "CWELCOME1", timestamp: "1790000000.100000" }]);
assert.equal(
  canvasEdits[0].changes[0].document_content.markdown.includes("![](#CPUBLIC001)"),
  true,
);
assert.equal(canvasEdits[0].changes[0].document_content.markdown.includes("<#CPUBLIC001>"), false);
assert.match(canvasEdits[0].changes[0].document_content.markdown, /^## \*\*ONE THING\*\*/m);
assert.doesNotMatch(canvasEdits[0].changes[0].document_content.markdown, /^[\s]*(?:•|◦|▪︎)/m);
await publishWelcomeGuide(env);
assert.equal(latest.origin, "repo");
assert.equal(latest.sourceTs, undefined);
assert.equal(latest.editedTs, undefined);

const event = { type: "member_joined_channel", channel: "CWELCOME1", user: "UNEW" };
await deliverWelcomeGuide(event, env);
await deliverWelcomeGuide({ ...event, type: "message", subtype: "channel_join" }, env);
assert.equal(posts.length, 1);
const sectionText = posts[0].blocks
  .filter((block) => block.type === "section")
  .map((block) => block.text.text)
  .join("");
assert.equal(sectionText.includes("<@UNEW>"), true);
assert.equal(posts[0].text.includes(latest.body), false);
assert.equal(posts[0].text.includes(env.COMMUNITY_GUIDE_CANVAS_URL), true);
assert.equal(posts[0].blocks[0].accessory.url, env.COMMUNITY_GUIDE_CANVAS_URL);
assert.equal(
  posts[0].blocks.find((block) => block.type === "actions")?.elements[0]?.action_id,
  "community_referral_link",
);
assert.deepEqual(posts[0].blocks.map((block) => block.slack_file?.id).filter(Boolean), []);
const repaired = await replaceWelcomeGuideForUser("UREPAIR", env);
assert.equal(repaired.delivered, true);
assert.equal((await replaceWelcomeGuideForUser("UREPAIR", env)).delivered, false);
const race = { ...event, user: "URACE" };
await Promise.all([deliverWelcomeGuide(race, env), deliverWelcomeGuide(race, env)]);
assert.equal(posts.filter((post) => post.text.includes("<@URACE>")).length, 1);
failPosts = true;
await assert.rejects(deliverWelcomeGuide({ ...event, user: "UFAIL" }, env));
failPosts = false;
await deliverWelcomeGuide({ ...event, user: "UFAIL" }, env);
assert.equal(
  posts.some((post) => post.text.includes("<@UFAIL>")),
  false,
);
postAuthor = "UADMIN";
await assert.rejects(
  replaceWelcomeGuideForUser("UWRONG", env),
  /OT1L 봇 게시자를 확인하지 못했습니다/,
);
assert.equal(deliveries.get(`UWRONG:${latest.version}:${latest.hash}`).status, "failed");
assert.equal(historyReads, 0);
console.log(
  "PASS repo-owned guide publish, no Slack source read, bot-only delivery, invitation button, idempotent join/repair",
);
