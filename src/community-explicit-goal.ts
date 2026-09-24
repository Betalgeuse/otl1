import { targetDateContext, targetDateIsSafe } from "./community-temporal";

const DATE_HEADER =
  "(?:오늘(?:은)?|(?:\\d{4}[-./])?\\d{1,2}[-./]\\d{1,2}|\\d{1,2}월\\s*\\d{1,2}일)";
const WEEKDAY = "(?:\\s*[.(]?[월화수목금토일](?:요일)?[.)]?)?";
const MARKER = "(?:원\\s*[띵씽싱]|ONE\\s+THING|목표)";
const EXPLICIT_GOAL = new RegExp(
  `^\\s*(?:${DATE_HEADER}${WEEKDAY}\\s*:?\\s*)?${MARKER}\\s*[:：]\\s*(.*?)\\s*$`,
  "iu",
);

export function normalizeGoalText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function sameGoalText(current: string, candidate: string): boolean {
  return normalizeGoalText(current) === normalizeGoalText(candidate);
}

export function parseExplicitGoal(text: string, contextDate: string, today: string): string | null {
  if (text.length > 1000) return null;
  if (!targetDateIsSafe(targetDateContext(text, contextDate, today))) return null;
  const firstLine = (text.split(/\r?\n/u, 1)[0] ?? "").replace(/^\s*[-*•]\s*/u, "");
  const goal = EXPLICIT_GOAL.exec(firstLine)?.[1]?.trim() ?? "";
  return goal && goal.length <= 200 ? goal : null;
}

export function resolveExplicitGoal(
  text: string,
  input: {
    readonly contextDate: string;
    readonly serviceDate: string;
    readonly calendarDate: string;
  },
): { readonly date: string; readonly goal: string } | null {
  const target = targetDateContext(text, input.contextDate, input.serviceDate);
  const resolvedDate =
    target.kind === "different" && target.targetDate === input.calendarDate
      ? input.calendarDate
      : input.contextDate;
  const goal = parseExplicitGoal(text, resolvedDate, input.serviceDate);
  return goal === null ? null : { date: resolvedDate, goal };
}
