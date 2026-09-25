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
    const key = `${input.userId}:${input.key}`;
    if (!records.has(key)) records.set(key, { ...input, status: "pending" });
    return records.get(key);
  }
  async claimRecord(input) {
    const record = records.get(`${input.userId}:${input.key}`);
    if (record?.status !== "pending") return false;
    record.status = "claimed";
    return true;
  }
  async finishRecord(input, status) {
    records.get(`${input.userId}:${input.key}`).status = status;
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
const {
  remindMissingIntroductions,
  sendDailyIntroductionReminders,
  showIntroductionDirectory,
  welcomeIntroductionMember,
} = await import("../src/community-introduction-channel.ts");

const env = {
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "fake",
  DATABASE_URL: "postgresql://test:test@test.neon.tech/db",
  COMMUNITY_INTRO_CHANNEL_ID: "CINTRO",
  COMMUNITY_INTRO_CANVAS_ID: "FINTRO01",
  COMMUNITY_INTRO_CANVAS_URL: "https://example.slack.com/docs/TQA/FINTRO01",
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
    ["community_introduction", "community_introduction_directory", "community_bug_open"],
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
    (call) => call.method === "chat.postEphemeral" && call.body.text.includes("자기소개 모음"),
  );
  assert.match(directory.body.text, /https:\/\/example\.slack\.com\/docs\/TQA\/FINTRO01/);
  assert.equal(
    calls.filter((call) => call.method === "canvases.edit").length,
    0,
    "viewing the directory is read-only and cannot re-mention members through a Canvas rewrite",
  );
  assert.deepEqual(
    directory.body.blocks[1].elements.map((element) => element.text.text),
    ["자기소개 쓰기", "자기소개 모두 보기", "피드백 남기기"],
  );

  await remindMissingIntroductions(context);
  const reminder = calls.find(
    (call) => call.method === "chat.postMessage" && call.body.text.includes("아직 자기소개"),
  );
  assert.match(reminder.body.text, /<@UNEW>/);
  assert.doesNotMatch(reminder.body.text, /<@UHAS>|<@UBOT>/);

  assert.equal(
    await sendDailyIntroductionReminders(env, context.store, "2026-09-16", "10:00"),
    1,
  );
  assert.equal(
    await sendDailyIntroductionReminders(env, context.store, "2026-09-16", "10:01"),
    0,
  );
  const directReminders = calls.filter(
    (call) => call.method === "chat.postMessage" && call.body.channel === "UNEW",
  );
  assert.equal(directReminders.length, 1, "daily retries do not duplicate the DM");
  assert.match(directReminders[0].body.text, /자기소개를 남겨주세요/);
  assert.equal(
    directReminders[0].body.blocks[1].elements[0].action_id,
    "community_introduction",
  );
  console.log(
    "PASS introduction channel: join prompt, owner action, readable Canvas directory, missing-member mention, daily missing-member DM",
  );
} finally {
  globalThis.fetch = original;
}
