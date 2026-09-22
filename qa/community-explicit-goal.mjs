import assert from "node:assert/strict";
import { parseExplicitGoal, sameGoalText } from "../src/community-explicit-goal.ts";

const date = "2026-09-17";
const cases = [
  [
    "원씽: 파이프라인 업데이트 완료 (진짜)\n사유: 합성 검증 사유",
    "파이프라인 업데이트 완료 (진짜)",
  ],
  [
    "원띵: 텐서연산 공부\n사유 : 연구에 쓰이는데 아직은 미숙함",
    "텐서연산 공부",
  ],
  [
    "• 원띵: 관심있는 랩실 위해 CV 수정 및 컨택메일 작성\n• 사유: 연구 경험을 쌓기 위해서",
    "관심있는 랩실 위해 CV 수정 및 컨택메일 작성",
  ],
  [" 원싱 : 보고서 마무리 ", "보고서 마무리"],
  ["ONE THING: Read chapter 4", "Read chapter 4"],
  ["one   thing : 테스트 정리", "테스트 정리"],
  ["목표： 발표 자료 완료", "발표 자료 완료"],
  ["원씽: 코드 수정 완료\n사유: 합성 검증", "코드 수정 완료"],
  ["9/17 원씽: 오늘 범위 끝내기", "오늘 범위 끝내기"],
  ["2026-09-17 (목): 목표: 회고 초안 완료", "회고 초안 완료"],
  ["9/18 원씽: 다른 날짜 목표", null],
  ["후기: 완료. 합성 후기", null],
  ["회고: 완료. 합성 회고", null],
  ["완료했어요", null],
  ["원씽 완료했어요", null],
  ["> 원씽: 인용된 목표", null],
  ["원씽: \n사유: 목표가 비어 있음", null],
  [`원씽: 짧은 목표\n사유: ${"가".repeat(1000)}`, null],
];

for (const [text, expected] of cases)
  assert.equal(parseExplicitGoal(text, date, date), expected, text);

assert.equal(sameGoalText("  보고서  마무리 ", "보고서 마무리"), true);
assert.equal(sameGoalText("Ａ 보고서", "A 보고서"), true);
assert.equal(sameGoalText("보고서 마무리", "보고서 완료"), false);

console.log(
  "PASS explicit goal fields outrank title verbs, isolate the goal line, preserve date safety, and compare normalized exact repeats",
);
