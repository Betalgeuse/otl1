import type { CommunityIntent, CommunityInterpretation } from "./community-language";
import { type TargetDateContext, targetDateIsSafe } from "./community-temporal";

export type CommunityRecordDecision = {
  readonly intent: CommunityIntent;
  readonly outcome: CommunityInterpretation["outcome"];
  readonly goalText: string | null;
  readonly reflectionText: string | null;
  readonly needsConfirmation: boolean;
  readonly currentDateSafe: boolean;
};

const STATUS_ONLY =
  /^(?:오늘(?:은|도)?\s*)?(?:완료(?:했어요|했습니다|했다)?|달성(?:했어요|했습니다|했다)?|다\s*(?:했어요|했습니다|했다|끝냈어요|끝냈습니다)|끝냈(?:어요|습니다)|부분\s*완료(?:했어요|했습니다|했다)?|일부\s*완료(?:했어요|했습니다|했다)?|절반(?:\s*(?:했어요|했습니다|했다))?|미완료|미완|못\s*했어요|안\s*했어요|휴식|쉬었어요)[\s.!。！,:：]*$/u;

function potentialReflection(text: string): string | null {
  const original = text.trim();
  if (!original || /[?？]/.test(original)) return null;
  const withoutSignals = original
    .replace(/:[a-zA-Z0-9_+-]+:/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replaceAll("️", "")
    .trim();
  if (!withoutSignals || STATUS_ONLY.test(withoutSignals)) return null;
  return /[\p{L}\p{N}]/u.test(withoutSignals) ? original : null;
}

function decision(
  interpretation: CommunityInterpretation,
  reflectionText: string | null,
  currentDateSafe: boolean,
  needsConfirmation = interpretation.needsConfirmation,
): CommunityRecordDecision {
  return {
    intent: interpretation.intent,
    outcome: interpretation.outcome,
    goalText: interpretation.goalText,
    reflectionText,
    needsConfirmation,
    currentDateSafe,
  };
}

export function decideCommunityRecord(
  interpretation: CommunityInterpretation,
  text: string,
  target: TargetDateContext,
): CommunityRecordDecision {
  const currentDateSafe = targetDateIsSafe(target);
  const candidate = currentDateSafe ? potentialReflection(text) : null;
  switch (interpretation.intent) {
    case "completion": {
      const reflectionText = interpretation.hasReflection ? text.trim() : candidate;
      return decision(
        interpretation,
        reflectionText,
        currentDateSafe,
        interpretation.needsConfirmation ||
          (reflectionText !== null && !interpretation.hasReflection),
      );
    }
    case "reflection":
      return decision(interpretation, text.trim(), currentDateSafe);
    case "unclear":
      return decision(interpretation, candidate, currentDateSafe);
    case "goal":
    case "rest":
    case "ignore":
      return decision(interpretation, null, currentDateSafe);
    default:
      return exhaustive(interpretation.intent);
  }
}

function exhaustive(value: never): never {
  throw new TypeError(String(value));
}
