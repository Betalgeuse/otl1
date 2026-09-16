import assert from "node:assert/strict";
import { authorizeCommunityAction } from "../src/community-permissions.ts";
import { actionIdentity } from "../src/community-runtime.ts";

const { introductionModal, parseIntroduction, submitIntroduction } = await import(
  "../src/community-introduction.ts"
);
const calls = [];
let current = null;
let pending = null;
const store = {
  async introduction() {
    return current;
  },
  async prepareIntroduction(input) {
    if (pending || input.expectedRevision !== (current?.revision ?? 0)) return null;
    pending = input;
    return (
      current ?? {
        teamId: input.teamId,
        userId: input.userId,
        intro: "",
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
      linkedin: pending.linkedin,
      details: pending.details,
      channelId: input.channelId,
      messageTs: input.messageTs,
      revision: (current?.revision ?? 0) + 1,
    };
    pending = null;
    return current;
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
  SLACK_TEAM_ID: "TQA",
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
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  const method = new URL(url).pathname.split("/").at(-1);
  calls.push({ method, body });
  return Response.json({ ok: true, ts: "2.000001", message_ts: "2.000001" });
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
  assert.equal(modal.blocks[1].element.multiline, false);
  assert.equal(modal.blocks[1].element.max_length, 180);
  assert.match(modal.blocks[0].text.text, /한 문장/);
  assert.match(modal.blocks[0].text.text, /공개/);

  const values = {
    intro: { value: { value: "데이터 제품을 만들고 커뮤니티 운영을 배우고 있어요." } },
    linkedin: {
      value: { value: "https://kr.linkedin.com/in/example-name/?trk=test#about" },
    },
    details: { value: { value: "https://example.com · @example" } },
  };
  assert.deepEqual(parseIntroduction(values), {
    intro: "데이터 제품을 만들고 커뮤니티 운영을 배우고 있어요.",
    linkedin: "https://kr.linkedin.com/in/example-name/",
    details: "https://example.com · @example",
  });
  for (const intro of [
    "첫 문장입니다. 두 번째 문장입니다.",
    "첫 문장입니다.둘째 문장입니다.",
    "첫 줄입니다.\n둘째 줄입니다.",
  ])
    assert.deepEqual(parseIntroduction({ ...values, intro: { value: { value: intro } } }), {
      errors: { intro: "자기소개는 줄바꿈 없이 한 문장, 180자 이내로 적어 주세요." },
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
  assert.equal(current.revision, 1);
  assert.equal(current.messageTs, "2.000001");

  await introductionModal(context, "TRIGGER2");
  modal = calls.at(-1).body.view;
  assert.equal(modal.title.text, "자기소개 수정");
  assert.equal(modal.blocks[1].element.initial_value, current.intro);
  const edited = {
    intro: { value: { value: "데이터 제품과 사람을 연결하는 일을 하고 있어요." } },
    linkedin: { value: { value: "" } },
    details: { value: { value: "https://portfolio.example" } },
  };
  await submitIntroduction(context, "VIEW2", parseIntroduction(edited), 1);
  const update = calls.find((call) => call.method === "chat.update");
  assert.equal(update.body.ts, "2.000001");
  assert.equal(current.revision, 2);
  assert.equal(current.intro, "데이터 제품과 사람을 연결하는 일을 하고 있어요.");
  assert.equal(current.details, "https://portfolio.example");
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);

  await submitIntroduction(context, "STALE", parseIntroduction(edited), 1);
  assert.equal(current.revision, 2, "stale modal cannot overwrite a newer introduction");
  assert.match(calls.at(-1).body.text, /먼저 바뀌었어요/);
  console.log(
    "PASS self-introduction: one sentence, optional canonical LinkedIn, same-message edit, stale revision block",
  );
} finally {
  globalThis.fetch = original;
}
