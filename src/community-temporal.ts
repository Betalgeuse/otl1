export type TargetDateContext = {
  readonly kind: "none" | "current" | "different" | "conflicting";
  readonly targetDate: string | null;
};

const DATE_TOKEN =
  "(?:\\d{4}[-./]\\d{1,2}[-./]\\d{1,2}|\\d{1,2}[./-]\\d{1,2}|\\d{1,2}월\\s*\\d{1,2}일)";
const RECORD_CUE =
  "(?:ONE\\s*THING|원씽|원띵|원싱|목표|후기|회고|기록|완료|달성|부분\\s*완료|일부\\s*완료|미완료|휴식|쉬었|다\\s*했)";
const EXPLICIT_TARGET = new RegExp(
  `^\\s*(?![>'"“”‘’])(${DATE_TOKEN})(?:\\s*[.(]?[월화수목금토일](?:요일)?[.)]?)?\\s*(?::|${RECORD_CUE})`,
  "iu",
);
const STANDALONE_DATE = new RegExp(`^\\s*(${DATE_TOKEN})\\s*$`, "iu");
const RECORD_HEADER = new RegExp(`^\\s*[-*•]?\\s*${RECORD_CUE}\\s*[:：]`, "iu");
const RELATIVE_TARGET = new RegExp(`^\\s*(?![>'"“”‘’])(어제|그제)\\s+${RECORD_CUE}`, "u");
const HISTORICAL_TARGET = new RegExp(`^\\s*(?![>'"“”‘’])지난\\s*주\\s+${RECORD_CUE}`, "u");

function validDate(value: string): string | null {
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

function absoluteDate(token: string, referenceDate: string): string | null {
  const parts = token.match(/\d+/g) ?? [];
  const year = parts.length === 3 ? (parts[0] ?? "") : referenceDate.slice(0, 4);
  const month = parts.length === 3 ? (parts[1] ?? "") : (parts[0] ?? "");
  const day = parts.length === 3 ? (parts[2] ?? "") : (parts[1] ?? "");
  return validDate(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
}

function relativeDate(token: string, today: string): string {
  const days = token === "어제" ? 1 : 2;
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export function targetDateContext(
  text: string,
  contextDate: string,
  today: string,
): TargetDateContext {
  const targets = new Set<string>();
  let unresolvedHistorical = false;
  let invalid = false;
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const standaloneDate = STANDALONE_DATE.exec(line);
    if (standaloneDate?.[1] && RECORD_HEADER.test(lines[index + 1] ?? "")) {
      const target = absoluteDate(standaloneDate[1], contextDate);
      if (target) targets.add(target);
      else invalid = true;
      continue;
    }
    if (HISTORICAL_TARGET.test(line)) {
      unresolvedHistorical = true;
      continue;
    }
    const explicit = EXPLICIT_TARGET.exec(line);
    if (explicit?.[1]) {
      const target = absoluteDate(explicit[1], contextDate);
      if (target) targets.add(target);
      else invalid = true;
      continue;
    }
    const relative = RELATIVE_TARGET.exec(line);
    if (relative?.[1]) targets.add(relativeDate(relative[1], today));
  }
  if (invalid || targets.size > 1 || (unresolvedHistorical && targets.size > 0))
    return { kind: "conflicting", targetDate: null };
  if (unresolvedHistorical) return { kind: "different", targetDate: null };
  const targetDate = targets.values().next().value;
  if (typeof targetDate !== "string") return { kind: "none", targetDate: null };
  return {
    kind: targetDate === contextDate ? "current" : "different",
    targetDate,
  };
}

export function targetDateIsSafe(context: TargetDateContext): boolean {
  return context.kind === "none" || context.kind === "current";
}
