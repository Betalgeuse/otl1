const CURRENT_OUTCOME =
  /^(?:완료|달성|부분\s*완료|일부\s*완료|절반|미완료|미완|못했어요|휴식|쉬었어요)(?:했어요|했습니다|했다)?(?=[\s.!。！,:：]|$)/u;
const EXPLICIT_DATE =
  /(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[./-]\d{1,2}|\d{1,2}월\s*\d{1,2}일)/u;
const RELATIVE_PAST = /어제|그제|지난주|지난 주/u;

export function isCurrentDateSafe(text: string): boolean {
  const normalized = text.trim();
  if (EXPLICIT_DATE.test(normalized)) return false;
  return !RELATIVE_PAST.test(normalized) || CURRENT_OUTCOME.test(normalized);
}
