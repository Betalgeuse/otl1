import assert from "node:assert/strict";
import { targetDateContext } from "../src/community-temporal.ts";

const contextDate = "2026-09-17";
const today = "2026-09-17";
const cases = [
  ["9/17: 오늘 발표 자료 정리", "current", "2026-09-17"],
  ["9.17 ONE THING: 오늘 발표 자료 정리", "current", "2026-09-17"],
  ["2026-09-17 후기: 일부 완료했어요", "current", "2026-09-17"],
  ["9월 16일 완료 처리", "different", "2026-09-16"],
  ["어제 기록 수정", "different", "2026-09-16"],
  ["CS 교재 10.4, 10.10, 10.6-10.9 복습", "none", null],
  ["10:30에 발표 자료 정리", "none", null],
  ["https://example.test/9/16 문서 읽기", "none", null],
  ["v9.16 변경 사항 정리", "none", null],
  ["진행률 9.16% 달성하기", "none", null],
  ["어제 못 끝낸 보고서 마무리", "none", null],
  ["오늘 완료. 어제는 시간이 부족했어요", "none", null],
  ["'어제 기록 수정'은 사용 예시예요", "none", null],
  ["9/16: 목표 정리\n9/15: 완료 처리", "conflicting", null],
  ["지난 주 목표 완료\n9/16: 완료 처리", "conflicting", null],
];

for (const [text, kind, targetDate] of cases) {
  assert.deepEqual(targetDateContext(text, contextDate, today), { kind, targetDate }, text);
}

console.log(`PASS ${cases.length} target-date syntax cases distinguish headers from content`);

const { classifyCommunityIntent } = await import("../src/community-language.ts");
const goalCases = [
  "9/17: 오늘 발표 자료 정리",
  "CS 교재 10.4, 10.10, 10.6-10.9 복습",
  "어제 못 끝낸 보고서 마무리",
  "https://example.test/9/16 문서 읽기",
  "v9.16 변경 사항 정리",
];
for (const text of goalCases) {
  let calls = 0;
  const result = await classifyCommunityIntent(
    {
      async run() {
        calls += 1;
        return {
          response: JSON.stringify({
            intent: "goal",
            outcome: "unknown",
            goalText: text,
            hasReflection: false,
            needsConfirmation: false,
          }),
        };
      },
    },
    { goal: null, text, date: contextDate, today },
  );
  assert.equal(calls, 1, text);
  assert.equal(result.intent, "goal", text);
  assert.equal(result.goalText, text, text);
}

let reviewCalls = 0;
const review = await classifyCommunityIntent(
  {
    async run() {
      reviewCalls += 1;
      return {
        response: JSON.stringify({
          intent: "reflection",
          outcome: "partial",
          goalText: null,
          hasReflection: true,
          needsConfirmation: false,
        }),
      };
    },
  },
  {
    goal: "보고서 마무리",
    text: "일부 완료했어요. 어제보다 범위를 줄이니 진도가 났어요.",
    date: contextDate,
    today,
  },
);
assert.equal(reviewCalls, 1);
assert.equal(review.intent, "reflection");
assert.equal(review.outcome, "partial");

for (const text of ["9월 16일 완료 처리", "9/16: 목표 정리\n9/15: 완료 처리"]) {
  let calls = 0;
  const result = await classifyCommunityIntent(
    {
      async run() {
        calls += 1;
        throw new Error("unsafe target must stop before AI");
      },
    },
    { goal: "보고서 마무리", text, date: contextDate, today },
  );
  assert.equal(calls, 0, text);
  assert.equal(result.intent, "unclear", text);
}

console.log("PASS target-date guard calls AI only for current or incidental date content");
