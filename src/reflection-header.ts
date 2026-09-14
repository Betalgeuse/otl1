import { InputError, date as parseDate } from "./input";

type HeaderOutcome = "complete" | "partial" | "not_done" | "rest";
export type ReflectionHeader = {
  readonly date: string | null;
  readonly outcome: HeaderOutcome;
  readonly text: string;
};
const DATE = String.raw`(?:\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{1,2}[/.]\d{1,2}|\d{1,2}월\s*\d{1,2}일)`;
const DATE_PREFIX = new RegExp(String.raw`^(?:\[(${DATE})\]|(${DATE}))(?=\s|[:：]|$)\s*[:：]?\s*`);
const EXTRA_DATE = new RegExp(
  String.raw`(?:^|\n)\s*(?:[-*]\s+)?\[?${DATE}\]?\s*(?:[:：]|(?:후기|회고)\s*[:：])`,
);
const STATUSES: readonly (readonly [RegExp, HeaderOutcome])[] = [
  [/^(?:일부\s*완료|부분\s*완료|절반)/, "partial"],
  [/^(?:미완료|미완|못했어요)/, "not_done"],
  [/^(?:휴식|쉬었어요)/, "rest"],
  [/^(?:완료(?:했어요|했습니다|했다)?|달성(?:했어요|했습니다|했다)?)/, "complete"],
];

function headerDate(token: string, today: string): string {
  const numbers = token.match(/\d+/g) ?? [];
  const parts = numbers.length === 2 ? [today.slice(0, 4), ...numbers] : numbers;
  const value = parseDate(
    `${parts[0]}-${parts[1]?.padStart(2, "0")}-${parts[2]?.padStart(2, "0")}`,
  );
  if (value > today) throw new InputError("후기 날짜는 오늘까지의 날짜로 알려주세요.");
  return value;
}

export function parseReflectionHeader(text: string, today: string): ReflectionHeader | null {
  const original = text.trim();
  if (
    !original ||
    original.length > 1000 ||
    /[>"“”「」`]|<@|친구가|동료가|[가-힣]+님이|인용|번역해|ignore|system|분류|출력|규칙.*무시/i.test(
      original,
    )
  )
    return null;
  let rest = original
    .replace(/\r\n?/g, "\n")
    .replace(/^[-*]\s+/, "")
    .replaceAll("**", "");
  const before = DATE_PREFIX.exec(rest);
  if (before) rest = rest.slice(before[0].length);
  const marker = /^(?:후기|회고)[ \t]*(?:[:：][ \t]*|\n\s*)/.exec(rest);
  if (!marker) return null;
  rest = rest.slice(marker[0].length).trimStart();
  const after = DATE_PREFIX.exec(rest);
  if (after) rest = rest.slice(after[0].length);
  if ((before && after) || EXTRA_DATE.test(rest))
    throw new InputError("후기는 한 번에 한 날짜씩 남겨주세요.");
  const dateToken = before?.[1] ?? before?.[2] ?? after?.[1] ?? after?.[2];
  const date = dateToken ? headerDate(dateToken, today) : null;
  for (const [pattern, outcome] of STATUSES) {
    const status = pattern.exec(rest);
    if (!status) continue;
    const tail = rest.slice(status[0].length);
    if (tail && !/^[ \t]*(?:[.!。！,:：]|\n|$)/.test(tail)) return null;
    if (/^[ \t]*[?？]/.test(tail)) return null;
    if (/^[\s.!。！,:：]*(?:예정|아니|아님|아직|사실\s*아직|못|하지\s*못|미완|취소)/.test(tail))
      return null;
    return { date, outcome, text: original };
  }
  return null;
}
