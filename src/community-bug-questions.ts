import {
  BUG_ENUM_QUESTIONS,
  BUG_FIELD_ORDER,
  BUG_FREE_QUESTIONS,
  type BugField,
  type BugQuestion,
  type DraftBugPacket,
} from "./community-bug-schema";

const CORRECTION_TEXT = {
  actual: "아직 실제로 일어난 일을 확인하지 못했어요. 화면에 보인 결과를 그대로 알려주세요.",
  expected: "원래 나와야 했던 결과를 한 문장으로 다시 알려주세요.",
  steps: "사용자 동작이 없었다면 그렇게 적고, 문제를 일으킨 자동 실행이나 트리거를 알려주세요.",
  location: "문제가 보인 채널, 화면 또는 기능 이름을 다시 알려주세요.",
  occurredAt: "가장 최근에 실제로 발생한 날짜와 시각을 알려주세요. 예: 2026-09-17 오후 6시",
  frequency: "발생 빈도를 ‘항상’, ‘가끔’, ‘한 번’ 중 하나로 알려주세요.",
  impact: "영향을 ‘불편’, ‘기능 사용 불가’, ‘잘못된 데이터’, ‘보안·개인정보’ 중 하나로 알려주세요.",
} as const;

function question(field: BugField, correction: boolean): BugQuestion {
  if (field === "frequency" || field === "impact")
    return {
      field,
      kind: "single_select",
      ...BUG_ENUM_QUESTIONS[field],
      ...(correction ? { text: CORRECTION_TEXT[field] } : {}),
    };
  return {
    field,
    kind: "free_text",
    text: correction ? CORRECTION_TEXT[field] : BUG_FREE_QUESTIONS[field],
  };
}

export function nextBugQuestion(
  packet: DraftBugPacket,
  contradictions: readonly string[],
  askedFields: readonly BugField[],
): BugQuestion {
  const latest = askedFields.at(-1);
  if (latest && packet[latest].status === "unknown") return question(latest, true);
  const conflictField = contradictions.includes("actual_equals_expected") ? "actual" : undefined;
  if (conflictField) return question(conflictField, askedFields.includes(conflictField));
  const unasked = BUG_FIELD_ORDER.find(
    (field) => packet[field].status === "unknown" && !askedFields.includes(field),
  );
  if (unasked) return question(unasked, false);
  const missing = BUG_FIELD_ORDER.find((field) => packet[field].status === "unknown");
  return question(missing ?? "actual", true);
}
