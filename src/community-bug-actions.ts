import { isBugFrequency, isBugImpact } from "./community-bug-schema";
import { InputError } from "./input";

export type BugAnswerAction =
  | { readonly field: "frequency"; readonly option: string }
  | { readonly field: "impact"; readonly option: string };

const ACTIONS = [
  { field: "frequency", option: "always", id: "community_bug_answer:frequency:always" },
  { field: "frequency", option: "sometimes", id: "community_bug_answer:frequency:sometimes" },
  { field: "frequency", option: "once", id: "community_bug_answer:frequency:once" },
  { field: "impact", option: "inconvenience", id: "community_bug_answer:impact:inconvenience" },
  { field: "impact", option: "blocked", id: "community_bug_answer:impact:blocked" },
  { field: "impact", option: "wrong_data", id: "community_bug_answer:impact:wrong_data" },
  {
    field: "impact",
    option: "security_privacy",
    id: "community_bug_answer:impact:security_privacy",
  },
] as const satisfies readonly (BugAnswerAction & { readonly id: string })[];

export function bugAnswerActionId(field: "frequency" | "impact", option: string): string {
  const match = ACTIONS.find((item) => item.field === field && item.option === option);
  if (!match) throw new InputError("버그 제보 선택지를 확인할 수 없어요.");
  return match.id;
}

export function parseBugAnswerActionId(value: string): BugAnswerAction | null {
  const match = ACTIONS.find((item) => item.id === value);
  if (!match) return null;
  if (match.field === "frequency" && isBugFrequency(match.option)) {
    return { field: match.field, option: match.option };
  }
  if (match.field === "impact" && isBugImpact(match.option)) {
    return { field: match.field, option: match.option };
  }
  return null;
}
