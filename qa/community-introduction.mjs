import assert from "node:assert/strict";
import { authorizeCommunityAction } from "../src/community-permissions.ts";
import { actionIdentity } from "../src/community-runtime.ts";

const calls = [];
const { introductionModal, parseIntroduction, submitIntroduction } = await import(
  "../src/community-introduction.ts"
);
const records = new Map();
const posts = [];
const identity = (x) => `${x.channelId}:${x.userId}:${x.key}`;
const store = {
  async getRecord(x) {
    return records.get(identity(x)) ?? null;
  },
  async putRecord(x) {
    const key = identity(x);
    if (!records.has(key)) records.set(key, { ...x, status: "pending" });
    return records.get(key);
  },
  async claimRecord(x) {
    const record = records.get(identity(x));
    if (record?.status !== "pending") return false;
    record.status = "claimed";
    return true;
  },
  async finishRecord(x, status) {
    records.get(identity(x)).status = status;
    return true;
  },
};
const env = { SLACK_BOT_TOKEN: "fake", COMMUNITY_INTRO_CHANNEL_ID: "CINTRO" };
const scope = { teamId: "TQA", channelId: "CTOWN", userId: "UNEW" };
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
  const target = String(url);
  if (target.endsWith("/views.open")) {
    calls.push({ kind: "view", token: options.headers.Authorization, payload: body });
    return Response.json({ ok: true, view: { id: "VMODAL" } });
  }
  posts.push({ url: target, body });
  return Response.json({ ok: true, ts: "2.000001", message_ts: "2.000001" });
};
try {
  const authEnv = {
    ...env,
    SLACK_TEAM_ID: "TQA",
    COMMUNITY_RELEASE_CHANNEL_ID: "CTOWN",
    COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
    COMMUNITY_CHANNEL_ID: "CADMIN",
    COMMUNITY_ADMIN_ID: "UADMIN",
  };
  const releaseAction = {
    team: { id: "TQA" },
    user: { id: "UNEW" },
    container: { channel_id: "CTOWN" },
  };
  assert.deepEqual(actionIdentity(releaseAction, authEnv, "community_introduction"), scope);
  authorizeCommunityAction("community_introduction", scope, authEnv);
  assert.throws(() => actionIdentity(releaseAction, authEnv, "community_palette"), /사용할 수 없/);
  await introductionModal(context, "TRIGGER");
  const modal = calls[0].payload.view;
  assert.equal(modal.callback_id, "community_introduction_submit");
  assert.equal(modal.blocks[2].optional, true);
  assert.match(modal.blocks[0].text.text, /공개/);
  assert.match(JSON.stringify(modal), /LinkedIn/);
  const values = {
    intro: { value: { value: "요즘은 데이터 제품을 만들고 있어요." } },
    linkedin: { value: { value: "https://kr.linkedin.com/in/example-name/?trk=test#about" } },
  };
  assert.deepEqual(parseIntroduction(values), {
    intro: "요즘은 데이터 제품을 만들고 있어요.",
    linkedin: "https://kr.linkedin.com/in/example-name/",
  });
  assert.deepEqual(
    parseIntroduction({ ...values, linkedin: { value: { value: null } } }),
    { intro: "요즘은 데이터 제품을 만들고 있어요.", linkedin: null },
  );
  assert.deepEqual(
    parseIntroduction({ ...values, linkedin: { value: { value: "https://example.com/in/fake" } } }),
    {
      errors: {
        linkedin: "본인 LinkedIn 프로필 주소를 https://linkedin.com/in/... 형식으로 입력해 주세요.",
      },
    },
  );
  assert.deepEqual(parseIntroduction({ ...values, intro: { value: { value: " " } } }), {
    errors: { intro: "자기소개를 한 줄 이상 적어 주세요." },
  });
  await submitIntroduction(context, "VIEW1", parseIntroduction(values));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.channel, "CINTRO");
  assert.match(posts[0].body.text, /<@UNEW>/);
  assert.match(posts[0].body.text, /linkedin\.com\/in\/example-name/);
  assert.equal(records.get("CINTRO:UNEW:self-introduction").status, "sent");
  await submitIntroduction(context, "VIEW2", parseIntroduction(values));
  assert.equal(posts.length, 1, "fixed member record suppresses duplicate introduction posts");
  calls.length = 0;
  await introductionModal(context, "TRIGGER2");
  assert.equal(calls.length, 0, "an existing record never reopens a modal that cannot be reclaimed");
  console.log(
    "PASS self-introduction modal: one short public intro, optional canonical LinkedIn, owner record, duplicate suppression",
  );
} finally {
  globalThis.fetch = original;
}
