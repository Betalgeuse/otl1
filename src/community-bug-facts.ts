import type {
  BugDialogueInput,
  BugField,
  BugPacketFields as ConfirmedFields,
  DraftBugPacket,
} from "./community-bug-schema";
import { isBugFrequency, isBugImpact } from "./community-bug-schema";
import type { BugDraftRead, BugPacketFields } from "./community-bug-types";

const PRIVATE_TEXT = "[비공개]";
const ENCRYPTED_TEXT = "[암호화 보관]";
const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/giu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /(?<!\d)(?:\+?82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}(?!\d)/gu,
  /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|passwd|비밀번호|암호|토큰)(?:\s*[:=]\s*|\s+)[^\s,;]+/giu,
] as const;

export type BugCandidate = {
  readonly field: BugField;
  readonly messageId: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  readonly value: string | readonly string[];
};
export type ParsedBugReport = {
  readonly messages: BugDialogueInput["messages"];
  readonly candidates: readonly BugCandidate[];
};

export function containsSensitiveBugText(value: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function redactBugDbText(value: string): string {
  let redacted = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, PRIVATE_TEXT);
  }
  return redacted;
}

export function bugFieldsForDatabase(
  fields: BugPacketFields,
  privateIncident: boolean,
): BugPacketFields {
  if (privateIncident)
    return {
      actual: "비공개 버그 제보",
      expected: null,
      steps: [],
      location: null,
      occurredAt: null,
      frequency: fields.frequency,
      impact: "security_privacy",
    };
  return {
    actual: fields.actual === null ? null : redactBugDbText(fields.actual),
    expected: fields.expected === null ? null : redactBugDbText(fields.expected),
    steps: fields.steps.map((step) =>
      typeof step === "string" ? redactBugDbText(step) : PRIVATE_TEXT,
    ),
    location: fields.location === null ? null : redactBugDbText(fields.location),
    occurredAt: fields.occurredAt,
    frequency: fields.frequency,
    impact: fields.impact,
  };
}

export function initialBugFieldsForDatabase(
  fields: BugPacketFields,
  privateIncident: boolean,
): BugPacketFields {
  if (privateIncident) return bugFieldsForDatabase(fields, true);
  return {
    actual: fields.actual === null ? null : ENCRYPTED_TEXT,
    expected: null,
    steps: [],
    location: null,
    occurredAt: null,
    frequency: fields.frequency,
    impact: fields.impact,
  };
}

export function bugCandidate(field: BugField, id: string, text: string): BugCandidate {
  return { field, messageId: id, start: 0, end: text.length, quote: text, value: text };
}

export function parsedBugDraft(draft: BugDraftRead): ParsedBugReport {
  const messages: Array<ParsedBugReport["messages"][number]> = [];
  const candidates: BugCandidate[] = [];
  const add = (field: BugField, text: string, value: BugCandidate["value"] = text) => {
    const id = `stored:${field}:${messages.length}`;
    messages.push({ id, text, at: new Date().toISOString() });
    candidates.push({ ...bugCandidate(field, id, text), value });
  };
  for (const field of ["actual", "expected", "location", "occurredAt"] as const) {
    const value = draft.sanitizedFields[field];
    if (typeof value === "string" && value) add(field, value);
  }
  const steps = draft.sanitizedFields.steps;
  if (Array.isArray(steps))
    for (const step of steps) if (typeof step === "string" && step) add("steps", step, [step]);
  const frequency = draft.sanitizedFields.frequency;
  if (frequency === "always") add("frequency", "항상", frequency);
  if (frequency === "sometimes") add("frequency", "가끔", frequency);
  if (frequency === "once") add("frequency", "한 번", frequency);
  const impact = draft.sanitizedFields.impact;
  if (impact === "inconvenience") add("impact", "불편", impact);
  if (impact === "blocked") add("impact", "진행할 수 없어요", impact);
  if (impact === "wrong_data") add("impact", "데이터가 잘못됐어요", impact);
  if (impact === "security_privacy") add("impact", "보안 또는 개인정보", impact);
  return { messages, candidates };
}

export function appendBugAnswer(
  parsed: ParsedBugReport,
  field: BugField,
  id: string,
  answer: string,
): ParsedBugReport {
  const values =
    field === "steps"
      ? answer
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean)
      : [answer];
  const messages = [...parsed.messages];
  const candidates = [...parsed.candidates];
  for (const [index, value] of values.entries()) {
    const messageId = `${id}:${index}`;
    messages.push({ id: messageId, text: value, at: new Date().toISOString() });
    candidates.push({ ...bugCandidate(field, messageId, value), value: answerValue(field, value) });
  }
  return { messages, candidates };
}

function answerValue(field: BugField, value: string): BugCandidate["value"] {
  if (field === "steps") return [value];
  if (field === "frequency") {
    if (/항상|매번/.test(value)) return "always";
    if (/가끔|종종|간헐/.test(value)) return "sometimes";
    if (/한\s*번|1회/.test(value)) return "once";
  }
  if (field === "impact") {
    if (/개인정보|보안|노출/.test(value)) return "security_privacy";
    if (/할 수 없|막혔|차단/.test(value)) return "blocked";
    if (/데이터|값/.test(value)) return "wrong_data";
    if (/불편|느림|번거/.test(value)) return "inconvenience";
  }
  return value;
}

export function storedBugFields(input: DraftBugPacket): BugPacketFields {
  const known = <T>(
    field: { readonly status: "unknown" } | { readonly status: "known"; readonly value: T },
  ) => (field.status === "known" ? field.value : null);
  return {
    actual: known(input.actual),
    expected: known(input.expected),
    steps: known(input.steps) ?? [],
    location: known(input.location),
    occurredAt: known(input.occurredAt),
    frequency: known(input.frequency),
    impact: known(input.impact),
  };
}

export function confirmedFieldsFromSanitized(
  sanitizedFields: Readonly<Record<string, unknown>>,
): ConfirmedFields | null {
  const { actual, expected, location, occurredAt, frequency, impact } = sanitizedFields;
  const steps = sanitizedFields.steps;
  if (
    typeof actual !== "string" ||
    typeof expected !== "string" ||
    typeof location !== "string" ||
    typeof occurredAt !== "string" ||
    typeof frequency !== "string" ||
    !isBugFrequency(frequency) ||
    typeof impact !== "string" ||
    !isBugImpact(impact) ||
    !Array.isArray(steps)
  )
    return null;
  const strings = steps.filter((step): step is string => typeof step === "string");
  const [first, second, ...rest] = strings;
  if (!first || !second) return null;
  return {
    actual,
    expected,
    steps: [first, second, ...rest],
    location,
    occurredAt,
    frequency,
    impact,
  };
}

export function confirmedFieldsFromDraft(draft: BugDraftRead): ConfirmedFields | null {
  return confirmedFieldsFromSanitized(draft.sanitizedFields);
}
