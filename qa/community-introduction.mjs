import assert from "node:assert/strict";
import { authorizeCommunityAction } from "../src/community-permissions.ts";
import { actionIdentity } from "../src/community-runtime.ts";

const { introductionModal, parseIntroduction, submitIntroduction } = await import(
  "../src/community-introduction.ts"
);
const calls = [];
let current = null;
let pending = null;
const prefillCandidate = "Test Member";
const store = {
  async introduction() {
    return current;
  },
  async introductionNameInput() {
    return current?.confirmedName ?? prefillCandidate;
  },
  async prepareIntroduction(input) {
    if (pending || input.expectedRevision !== (current?.revision ?? 0)) return null;
    pending = input;
    return (
      current ?? {
        teamId: input.teamId,
        userId: input.userId,
        intro: "",
        confirmedName: null,
        linkedin: null,
        details: null,
        channelId: null,
        messageTs: null,
        revision: 0,
      }
    );
  },
  async finishIntroduction(input) {
    if (!pending || pending.token !== input.token) return null;
    current = {
      teamId: input.teamId,
      userId: input.userId,
      intro: pending.intro,
      confirmedName: pending.confirmedName,
      linkedin: pending.linkedin,
      details: pending.details,
      channelId: input.channelId,
      messageTs: input.messageTs,
      revision: (current?.revision ?? 0) + 1,
    };
    pending = null;
    return current;
  },
  async introductions() {
    return current ? [current] : [];
  },
  async abortIntroduction(_teamId, _userId, token) {
    if (pending?.token !== token) return false;
    pending = null;
    return true;
  },
};
const env = {
  SLACK_BOT_TOKEN: "fake",
  COMMUNITY_INTRO_CHANNEL_ID: "CINTRO",
  COMMUNITY_INTRO_CANVAS_ID: "FINTRO01",
  COMMUNITY_INTRO_CANVAS_URL: "https://example.slack.com/docs/TQA/FINTRO01",
  SLACK_TEAM_ID: "TQA",
};
const emoji = {
  otl_cheer: "https://emoji.slack-edge.com/cheer.png",
  otl_wave: "https://emoji.slack-edge.com/wave.png",
  otl_star: "https://emoji.slack-edge.com/star.png",
  otl_dance: "https://emoji.slack-edge.com/dance.png",
};
const scope = { teamId: "TQA", channelId: "CINTRO", userId: "UNEW" };
const context = {
  env,
  scope,
  store,
  date: "2026-09-16",
  source: "1.000001",
  thread: "1.000001",
  key: "interaction:1",
};
const original = globalThis.fetch;
const originalError = console.error;
const errors = [];
let postedMessageCount = 0;
let reactionAttempt = 0;
let failReactionAt = 0;
let failDelete = false;
console.error = (value) => errors.push(String(value));
globalThis.fetch = async (url, options) => {
  const body = options.body ? JSON.parse(options.body) : null;
  const method = new URL(url).pathname.split("/").at(-1);
  calls.push({ method, body });
  if (method === "emoji.list") return Response.json({ ok: true, emoji });
  if (method === "chat.postMessage") {
    postedMessageCount += 1;
    const ts = `${postedMessageCount + 1}.000001`;
    return Response.json({ ok: true, ts, message_ts: ts });
  }
  if (method === "reactions.add") {
    reactionAttempt += 1;
    if (reactionAttempt === failReactionAt)
      return Response.json({ ok: false, error: "internal_error" });
  }
  if (method === "chat.delete" && failDelete)
    return Response.json({ ok: false, error: "internal_error" });
  return Response.json({ ok: true, ts: body?.ts ?? "2.000001", message_ts: "2.000001" });
};
try {
  const authEnv = {
    ...env,
    COMMUNITY_RELEASE_CHANNEL_ID: "CTOWN",
    COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
    COMMUNITY_CHANNEL_ID: "CADMIN",
    COMMUNITY_ADMIN_ID: "UADMIN",
  };
  const introAction = {
    team: { id: "TQA" },
    user: { id: "UNEW" },
    container: { channel_id: "CINTRO" },
  };
  assert.deepEqual(actionIdentity(introAction, authEnv, "community_introduction"), scope);
  authorizeCommunityAction("community_introduction_directory", scope, authEnv);
  assert.throws(() => actionIdentity(introAction, authEnv, "community_palette"), /사용할 수 없/);

  await introductionModal(context, "TRIGGER1");
  let modal = calls.at(-1).body.view;
  assert.equal(modal.title.text, "자기소개");
  assert.equal(modal.blocks[2].element.multiline, true);
  assert.equal(modal.blocks[2].element.max_length, 180);
  assert.match(modal.blocks[0].text.text, /공개/);
  assert.equal(modal.blocks[1].block_id, "confirmed_name");
  assert.equal(
    modal.blocks[1].element.initial_value,
    prefillCandidate,
    "a member without an intro can see a private name candidate",
  );
  assert.equal(modal.blocks[1].element.multiline, undefined);

  const values = {
    confirmed_name: { value: { value: "홍길동" } },
    intro: { value: { value: "데이터 제품을 만들고 커뮤니티 운영을 배우고 있어요." } },
    linkedin: {
      value: { value: "https://kr.linkedin.com/in/example-name/?trk=test#about" },
    },
    details: { value: { value: "https://example.com · @example" } },
  };
  assert.deepEqual(parseIntroduction(values), {
    confirmedName: "홍길동",
    intro: "데이터 제품을 만들고 커뮤니티 운영을 배우고 있어요.",
    linkedin: "https://kr.linkedin.com/in/example-name/",
    details: "https://example.com · @example",
  });
  const multiline = "첫 문장입니다.\n둘째 줄도 자유롭게 적습니다.";
  assert.deepEqual(parseIntroduction({ ...values, intro: { value: { value: multiline } } }), {
    confirmedName: "홍길동",
    intro: multiline,
    linkedin: "https://kr.linkedin.com/in/example-name/",
    details: "https://example.com · @example",
  });
  for (const intro of ["", "가".repeat(181)])
    assert.deepEqual(parseIntroduction({ ...values, intro: { value: { value: intro } } }), {
      errors: { intro: "자기소개는 1~180자로 적어 주세요." },
    });
  assert.deepEqual(parseIntroduction({ ...values, confirmed_name: { value: { value: "" } } }), {
    errors: { confirmed_name: "본명은 1~40자로 적어 주세요." },
  });
  assert.deepEqual(
    parseIntroduction({ ...values, linkedin: { value: { value: "https://example.com/in/fake" } } }),
    {
      errors: {
        linkedin: "본인 LinkedIn 프로필 주소를 https://linkedin.com/in/... 형식으로 입력해 주세요.",
      },
    },
  );
  assert.deepEqual(
    parseIntroduction({ ...values, details: { value: { value: "첫 줄\n둘째 줄" } } }),
    { errors: { details: "추가 공개 정보는 줄바꿈 없이 300자 이내로 적어 주세요." } },
  );

  await submitIntroduction(context, "VIEW1", parseIntroduction(values), 0);
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);
  const introductionPost = calls.find((call) => call.method === "chat.postMessage");
  assert.deepEqual(
    introductionPost.body.blocks[1].elements.map((element) => element.text.text),
    ["자기소개 쓰기", "자기소개 모두 보기"],
  );
  assert.equal(current.revision, 1);
  assert.equal(current.messageTs, "2.000001");
  const firstCanvas = calls.find((call) => call.method === "canvases.edit");
  assert.equal(firstCanvas.body.canvas_id, "FINTRO01");
  assert.match(firstCanvas.body.changes[0].document_content.markdown, /!\[\]\(@UNEW\).*홍길동/s);
  const reactions = calls.filter((call) => call.method === "reactions.add");
  assert.equal(reactions.length, 3, "a published introduction receives three custom reactions");
  assert.equal(new Set(reactions.map((call) => call.body.name)).size, 3);
  for (const reaction of reactions) {
    assert.ok(Object.hasOwn(emoji, reaction.body.name));
    assert.equal(reaction.body.channel, "CINTRO");
    assert.equal(reaction.body.timestamp, current.messageTs);
  }

  await introductionModal(context, "TRIGGER2");
  modal = calls.at(-1).body.view;
  assert.equal(modal.title.text, "자기소개 수정");
  assert.equal(modal.blocks[2].element.initial_value, current.intro);
  const edited = {
    confirmed_name: { value: { value: "홍길동" } },
    intro: { value: { value: "데이터 제품과 사람을 연결하는 일을 하고 있어요." } },
    linkedin: { value: { value: "" } },
    details: { value: { value: "https://portfolio.example" } },
  };
  await submitIntroduction(context, "VIEW2", parseIntroduction(edited), 1);
  const update = calls.find((call) => call.method === "chat.update");
  assert.equal(update.body.ts, "2.000001");
  assert.deepEqual(
    update.body.blocks[1].elements.map((element) => element.action_id),
    ["community_introduction", "community_introduction_directory"],
  );
  assert.equal(update.body.blocks[1].elements[1].url, env.COMMUNITY_INTRO_CANVAS_URL);
  assert.equal(current.revision, 2);
  assert.equal(current.intro, "데이터 제품과 사람을 연결하는 일을 하고 있어요.");
  assert.equal(current.details, "https://portfolio.example");
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.equal(
    calls.filter((call) => call.method === "reactions.add").length,
    3,
    "editing preserves the original three reactions instead of accumulating more",
  );

  await submitIntroduction(context, "STALE", parseIntroduction(edited), 1);
  assert.equal(current.revision, 2, "stale modal cannot overwrite a newer introduction");
  assert.match(calls.at(-1).body.text, /먼저 바뀌었어요/);

  current = null;
  pending = null;
  calls.length = 0;
  failReactionAt = reactionAttempt + 2;
  await submitIntroduction(context, "VIEW-PARTIAL", parseIntroduction(values), 0);
  assert.equal(
    calls.filter((call) => call.method === "reactions.add").length,
    2,
    "the provider fails after one reaction was added",
  );
  const compensation = calls.filter((call) => call.method === "chat.delete");
  assert.equal(compensation.length, 1, "a partially reacted introduction is deleted");
  assert.equal(compensation[0].body.channel, "CINTRO");
  assert.equal(compensation[0].body.ts, "3.000001");
  assert.equal(current, null, "a failed create is not finalized");
  assert.equal(pending, null, "a failed create clears its pending DB state");

  const retryStart = calls.length;
  failReactionAt = 0;
  await submitIntroduction(context, "VIEW-RETRY", parseIntroduction(values), 0);
  const retryCalls = calls.slice(retryStart);
  const retryReactions = retryCalls.filter((call) => call.method === "reactions.add");
  assert.equal(retryCalls.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.equal(retryReactions.length, 3, "retry creates three reactions from a clean state");
  assert.equal(new Set(retryReactions.map((call) => call.body.name)).size, 3);
  assert.equal(current.revision, 1);
  assert.equal(current.messageTs, "4.000001");

  current = null;
  pending = null;
  calls.length = 0;
  failReactionAt = reactionAttempt + 1;
  failDelete = true;
  await submitIntroduction(context, "VIEW-CLEANUP-FAIL", parseIntroduction(values), 0);
  assert.equal(current, null);
  assert.equal(pending?.token, "VIEW-CLEANUP-FAIL", "failed deletion retains pending state");
  assert.ok(
    errors.some((entry) => entry.includes('"event":"community.introduction.cleanup_failed"')),
    "a failed compensation is surfaced without payload data",
  );
  assert.ok(
    errors.every(
      (entry) => !entry.includes(env.SLACK_BOT_TOKEN) && !entry.includes(values.intro.value.value),
    ),
    "cleanup logs do not expose tokens or introduction text",
  );
  const blockedRetryStart = calls.length;
  await submitIntroduction(context, "VIEW-CLEANUP-RETRY", parseIntroduction(values), 0);
  assert.equal(
    calls.slice(blockedRetryStart).filter((call) => call.method === "chat.postMessage").length,
    0,
    "retry cannot duplicate a partially reacted message when deletion failed",
  );
  console.log(
    "PASS self-introduction: create/edit reactions, partial failure compensation, clean retry, cleanup failure logging",
  );
} finally {
  globalThis.fetch = original;
  console.error = originalError;
}
