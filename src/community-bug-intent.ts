export type BugMessageIntent =
  | { readonly kind: "entry" }
  | { readonly kind: "report"; readonly report: string };

const SOFTWARE_OBJECT =
  /댓글|답글|메시지|등록|버튼|알림|봇|슬랙|slack|저장|수정|삭제|업로드|다운로드|로그인|화면|페이지|링크|이모지|잔디/iu;
const FAILURE_SYMPTOM =
  /안\s*(?:보이|보여|떠|나오|오|와|되|돼|됩|열리|눌리|저장)|못\s*(?:보|하|열|누르|저장|등록|수정|삭제)|반응(?:이|은)?\s*없|응답(?:이|은)?\s*없|작동(?:하지\s*않|이?\s*안\s*되)|오류|에러|멈|먹통|깨지|튕기|유실|누락|사라|실패/iu;
const ONE_THING_RECORD_GRAMMAR =
  /완료|부분\s*완료|미완료|쉬었|휴식|후기|회고|(?:목표|원\s*씽|원싱|one\s*thing)/iu;

function isMeaningfulProductFailure(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  const meaningfulLength = compact.replace(/[^0-9A-Za-z가-힣]/g, "").length;
  return meaningfulLength >= 6 && SOFTWARE_OBJECT.test(compact) && FAILURE_SYMPTOM.test(compact);
}

export function parseBugIntakeCandidate(
  text: string,
  allowNatural = false,
): BugMessageIntent | null {
  const trimmed = text.trim();
  if (/^피드백\s*:?[\s]*$/u.test(trimmed)) return { kind: "entry" };
  if (/^버그\s*제보\s*:?\s*$/u.test(trimmed)) return { kind: "entry" };
  if (/^버그\s*제보\s+계속$/u.test(trimmed)) return null;
  const explicit = /^(?:버그\s*제보\s*:\s*|버그\s*제보\s+|버그\s*:\s*)(\S.+)$/su.exec(trimmed);
  if (explicit?.[1]) return { kind: "report", report: explicit[1] };
  const feedback = /^피드백\s*:\s*(\S.+)$/su.exec(trimmed);
  if (feedback?.[1]) return { kind: "report", report: feedback[1] };
  if (!allowNatural) return null;
  const prefixed = /^(?:문제|오류)\s*:\s*(\S.*)$/su.exec(trimmed);
  if (prefixed?.[1])
    return isMeaningfulProductFailure(prefixed[1]) ? { kind: "report", report: prefixed[1] } : null;
  if (ONE_THING_RECORD_GRAMMAR.test(trimmed) || !isMeaningfulProductFailure(trimmed)) return null;
  return { kind: "report", report: trimmed };
}

export function isBugReportMessage(text: string, allowNatural = false): boolean {
  return parseBugIntakeCandidate(text, allowNatural) !== null;
}
