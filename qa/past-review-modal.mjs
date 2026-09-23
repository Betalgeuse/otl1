import assert from "node:assert/strict";
import { communityStatusMessage } from "../src/community-messages.ts";
import {
  openPastReviewModal,
  openPastReviewPickerModal,
  parsePastReviewSubmission,
  pastReviewBinding,
  pastReviewChange,
} from "../src/community-past-review.ts";

const day = {
  teamId: "TQA",
  channelId: "CPUBLIC",
  userId: "UQA",
  date: "2026-09-21",
  goal: "제안서 문제 정의 한 장 완성하기",
  outcome: "partial",
  reflection: "",
  resting: false,
  revision: 4,
};
const context = {
  env: { SLACK_BOT_TOKEN: "fake" },
  scope: { teamId: "TQA", channelId: "CPUBLIC", userId: "UQA" },
  store: {
    async day() {
      return day;
    },
    async history() {
      return [day];
    },
  },
  date: "2026-09-23",
  source: "1790000000.000001",
  thread: "1790000000.000001",
  key: "interaction:past-review",
};
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), body: JSON.parse(options.body) });
  return Response.json({ ok: true });
};
try {
  const binding = pastReviewBinding({ date: day.date, revision: day.revision });
  await openPastReviewPickerModal(context, "PICKER");
  const picker = calls[0].body.view;
  assert.equal(picker.callback_id, "community_past_review_submit");
  assert.match(picker.blocks[1].element.options[0].text.text, /9\/21.*제안서/);
  calls.length = 0;
  await openPastReviewModal(context, "TRIGGER", binding);
  const modal = calls[0].body.view;
  assert.equal(modal.callback_id, "community_past_review_submit");
  assert.match(modal.blocks[0].text.text, /2026-09-21.*제안서 문제 정의/s);
  assert.equal(modal.blocks[1].element.initial_option.value, "partial");
  assert.deepEqual(
    modal.blocks[1].element.options.map((option) => option.value),
    ["complete", "partial", "not_done"],
  );
  const submitted = parsePastReviewSubmission({
    private_metadata: modal.private_metadata,
    state: {
      values: {
        outcome: { value: { selected_option: { value: "complete" } } },
        reflection: { value: { value: "늦게라도 정리하니 다음 행동이 보였다." } },
      },
    },
  });
  assert.deepEqual(submitted, {
    date: day.date,
    revision: day.revision,
    outcome: "complete",
    reflection: "늦게라도 정리하니 다음 행동이 보였다.",
  });
  assert.deepEqual(pastReviewChange(context, submitted), {
    ...context.scope,
    date: day.date,
    key: "change:interaction:past-review",
    expectedRevision: 4,
    action: "reflection",
    text: submitted.reflection,
    outcome: "complete",
  });
  const invalid = parsePastReviewSubmission({
    private_metadata: modal.private_metadata,
    state: {
      values: {
        outcome: { value: { selected_option: { value: "partial" } } },
        reflection: { value: { value: "" } },
      },
    },
  });
  assert.deepEqual(invalid, { errors: { reflection: "후기는 1~2000자로 적어 주세요." } });
  const card = communityStatusMessage({
    userId: "UQA",
    date: "2026-09-23",
    goal: "오늘 목표",
    outcome: "unknown",
    reflection: null,
    rest: false,
    undoValue: null,
    earlierNotice: "이전 ONE THING도 돌아봐요.",
    earlierReviewChoices: [
      {
        label: "9/21 후기 남기기",
        actionId: "community_past_review",
        value: JSON.stringify({
          ownerId: "UQA",
          key: "past-review:2026-09-21",
          date: day.date,
          revision: 4,
        }),
      },
    ],
  });
  const reviewActions = card.blocks.find(
    (block) => block.type === "actions" && block.elements[0]?.action_id === "community_past_review",
  );
  assert.equal(reviewActions.elements[0].text.text, "9/21 후기 남기기");
  await assert.rejects(
    openPastReviewModal(
      {
        ...context,
        store: {
          async day() {
            return { ...day, revision: 5 };
          },
        },
      },
      "STALE",
      binding,
    ),
    /바뀐 기록/,
  );
  console.log("PASS past review modal: dated revision-bound outcome and reflection save path");
} finally {
  globalThis.fetch = originalFetch;
}
