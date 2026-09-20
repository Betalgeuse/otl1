import { mock } from "bun:test";
import assert from "node:assert/strict";

const records = new Map();
const intros = [
  {
    teamId: "TQA",
    userId: "UHAS",
    intro: "제품을 만드는 일을 하고 있어요.",
    linkedin: "https://linkedin.com/in/has-intro/",
    details: "https://example.com",
    channelId: "CINTRO",
    messageTs: "1.000001",
    revision: 1,
  },
];
class FakeStore {
  async putRecord(input) {
    if (!records.has(input.userId)) records.set(input.userId, { ...input, status: "pending" });
    return records.get(input.userId);
  }
  async claimRecord(input) {
    const record = records.get(input.userId);
    if (record?.status !== "pending") return false;
    record.status = "claimed";
    return true;
  }
  async finishRecord(input, status) {
    records.get(input.userId).status = status;
    return true;
  }
  async introduction(_teamId, userId) {
    return intros.find((intro) => intro.userId === userId) ?? null;
  }
  async introductions() {
    return intros;
  }
}
mock.module("../src/community-store.ts", () => ({ CommunityStore: FakeStore }));
const { remindMissingIntroductions, showIntroductionDirectory, welcomeIntroductionMember } =
  await import("../src/community-introduction-channel.ts");

const env = {
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "fake",
  DATABASE_URL: "postgresql://test:test@test.neon.tech/db",
  COMMUNITY_INTRO_CHANNEL_ID: "CINTRO",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_BOT_USER_ID: "UBOT",
};
const calls = [];
const original = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = parsed.pathname.split("/").at(-1);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ method, body, query: parsed.searchParams });
  if (method === "users.info") {
    const id = parsed.searchParams.get("user");
    return Response.json({
      ok: true,
      user: { id, is_bot: id === "UBOT", is_app_user: false, deleted: false },
    });
  }
  if (method === "conversations.members")
    return Response.json({
      ok: true,
      members: ["UNEW", "UHAS", "UBOT"],
      response_metadata: { next_cursor: "" },
    });
  return Response.json({ ok: true, ts: "2.000001", message_ts: "2.000001" });
};
try {
  const join = {
    type: "member_joined_channel",
    channel: "CINTRO",
    user: "UNEW",
    event_ts: "2.000001",
  };
  assert.equal(await welcomeIntroductionMember(join, env), true);
  assert.equal(await welcomeIntroductionMember(join, env), true);
  const welcomes = calls.filter(
    (call) => call.method === "chat.postMessage" && call.body.text.includes("<@UNEW>"),
  );
  assert.equal(welcomes.length, 1, "duplicate join events do not repeat the prompt");
  assert.match(welcomes[0].body.text, /아직 소개가 없어요/);
  assert.deepEqual(
    welcomes[0].body.blocks[1].elements.map((element) => element.action_id),
    ["community_introduction", "community_introduction_directory"],
  );
  assert.equal(
    JSON.parse(welcomes[0].body.blocks[1].elements[0].value).ownerId,
    "actor",
    "new public introduction prompts are scoped to whoever clicks them",
  );

  const context = {
    env,
    store: new FakeStore(),
    scope: { teamId: "TQA", channelId: "CINTRO", userId: "UADMIN" },
    date: "2026-09-16",
    source: "3.000001",
    thread: "3.000001",
    key: "test",
  };
  await showIntroductionDirectory(context);
  const directory = calls.find(
    (call) => call.method === "chat.postEphemeral" && call.body.text.includes("우리의 자기소개"),
  );
  assert.match(directory.body.text, /<@UHAS>/);
  assert.match(directory.body.text, /LinkedIn/);
  assert.match(directory.body.text, /https:\/\/example\.com/);

  await remindMissingIntroductions(context);
  const reminder = calls.find(
    (call) => call.method === "chat.postMessage" && call.body.text.includes("아직 자기소개"),
  );
  assert.match(reminder.body.text, /<@UNEW>/);
  assert.doesNotMatch(reminder.body.text, /<@UHAS>|<@UBOT>/);
  console.log(
    "PASS introduction channel: join prompt, owner action, private directory, missing-member mention",
  );
} finally {
  globalThis.fetch = original;
}
