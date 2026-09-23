export const BUG_PACKET_VERSION = "bug_packet.v1" as const;

export const BUG_FREQUENCIES = ["always", "sometimes", "once"] as const;
export type BugFrequency = (typeof BUG_FREQUENCIES)[number];

export const BUG_IMPACTS = ["inconvenience", "blocked", "wrong_data", "security_privacy"] as const;
export type BugImpact = (typeof BUG_IMPACTS)[number];

export type BugPacketFields = {
  readonly actual: string;
  readonly expected: string;
  readonly steps: readonly [string, string, ...string[]];
  readonly location: string;
  readonly occurredAt: string;
  readonly frequency: BugFrequency;
  readonly impact: BugImpact;
};

export type BugPacketSource = {
  readonly kind: string;
  readonly opaqueRef: string;
};

export type ConfirmedBugPacket = {
  readonly schemaVersion: typeof BUG_PACKET_VERSION;
  readonly bugId: string;
  readonly status: "confirmed";
  readonly revision: number;
  readonly fields: BugPacketFields;
  readonly confirmation: {
    readonly reporterConfirmed: true;
    readonly confirmedAt: string;
  };
  readonly source: BugPacketSource;
  readonly evidenceDigest: string;
  readonly packetDigest: string;
};

export type BugEvidence = {
  readonly field: keyof BugPacketFields;
  readonly messageId: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
};

export type BugField = keyof BugPacketFields;
export type UnknownBugFact = { readonly status: "unknown" };
export type KnownBugFact<T> = {
  readonly status: "known";
  readonly value: T;
  readonly evidence: readonly BugEvidence[];
};
export type BugFact<T> = UnknownBugFact | KnownBugFact<T>;

export type DraftBugPacket = {
  readonly actual: BugFact<string>;
  readonly expected: BugFact<string>;
  readonly steps: BugFact<readonly string[]>;
  readonly location: BugFact<string>;
  readonly occurredAt: BugFact<string>;
  readonly frequency: BugFact<BugFrequency>;
  readonly impact: BugFact<BugImpact>;
};

export type BugDialogueInput = {
  readonly bugId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly source: BugPacketSource;
  readonly messages: readonly { readonly id: string; readonly text: string; readonly at: string }[];
  readonly candidates?: readonly unknown[];
  readonly askedQuestions?: readonly { readonly field: BugField; readonly askedAt: string }[];
  readonly questionCount?: number;
  readonly needsInfoStartedAt?: string;
  readonly now: string;
  readonly reporterConfirmedAt?: string;
  readonly cancelledAt?: string;
};

export type BugQuestion =
  | {
      readonly field: Exclude<BugField, "frequency" | "impact">;
      readonly kind: "free_text";
      readonly text: string;
    }
  | {
      readonly field: "frequency" | "impact";
      readonly kind: "single_select";
      readonly text: string;
      readonly options: readonly string[];
    };

export type BugSafetyFlag = "prompt_like_text";
type DialogueBase = {
  readonly packet: DraftBugPacket;
  readonly contradictions: readonly string[];
  readonly safetyFlags: readonly BugSafetyFlag[];
};
export type BugDialogueResult =
  | (DialogueBase & { readonly status: "needs_info"; readonly question: BugQuestion })
  | (DialogueBase & { readonly status: "exhausted"; readonly handoff: true })
  | (DialogueBase & { readonly status: "cancelled"; readonly cancelledAt: string })
  | (DialogueBase & {
      readonly status: "stale";
      readonly expectedRevision: number;
      readonly currentRevision: number;
      readonly handoff: true;
    })
  | (DialogueBase & {
      readonly status: "awaiting_confirmation";
      readonly summary: { readonly fields: BugPacketFields; readonly source: BugPacketSource };
    })
  | {
      readonly status: "confirmed";
      readonly packet: ConfirmedBugPacket;
      readonly evidence: readonly BugEvidence[];
      readonly safetyFlags: readonly BugSafetyFlag[];
    };

export const BUG_FIELD_ORDER = [
  "actual",
  "expected",
  "steps",
  "location",
  "occurredAt",
  "frequency",
  "impact",
] as const;
export const BUG_FREE_QUESTIONS = {
  actual: "실제로 어떤 일이 일어났나요? 화면에 보인 문구도 그대로 알려주세요.",
  expected: "원래는 어떤 결과가 나와야 했나요?",
  steps:
    "문제가 보이기 직전에 한 동작이나 자동 실행이 있었나요? 사용자 동작이 없었다면 그렇게 알려주세요.",
  location: "어느 화면이나 기능에서 문제가 생겼나요?",
  occurredAt: "문제가 생긴 시각을 알려주세요.",
} as const;
export const BUG_ENUM_QUESTIONS = {
  frequency: { text: "이 문제는 얼마나 자주 생기나요?", options: BUG_FREQUENCIES },
  impact: { text: "이 문제로 어떤 영향을 받고 있나요?", options: BUG_IMPACTS },
} as const;

export function isBugField(value: unknown): value is BugField {
  return BUG_FIELD_ORDER.some((item) => item === value);
}

export function isBugFrequency(value: string): value is BugFrequency {
  return value === "always" || value === "sometimes" || value === "once";
}

export function isBugImpact(value: string): value is BugImpact {
  return (
    value === "inconvenience" ||
    value === "blocked" ||
    value === "wrong_data" ||
    value === "security_privacy"
  );
}

export function bugSafetyFlags(evidence: readonly BugEvidence[]): readonly BugSafetyFlag[] {
  return evidence.some((item) =>
    /ignore\s+rules|system\s+prompt|mark\s+confirmed|규칙.{0,4}무시|프롬프트|확인됨으로/i.test(
      item.quote,
    ),
  )
    ? ["prompt_like_text"]
    : [];
}

const ISO_KST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]09:00)$/;

export function normalizeOccurredAt(value: string, now: string): string | null {
  if (ISO_KST.test(value) && Number.isFinite(Date.parse(value))) {
    if (value.endsWith("+09:00")) return value;
    return new Date(Date.parse(value) + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");
  }
  const match = /^오늘\s*(오전|오후)?\s*(\d{1,2})시(?:\s*(\d{1,2})분)?$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(now))) return null;
  const period = match[1];
  const rawHour = Number(match[2]);
  const minute = Number(match[3] ?? "0");
  if (minute > 59 || (period ? rawHour < 1 || rawHour > 12 : rawHour > 23)) return null;
  const hour = period === "오전" ? rawHour % 12 : period === "오후" ? (rawHour % 12) + 12 : rawHour;
  const date = new Date(Date.parse(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  const scalar = JSON.stringify(value);
  if (scalar === undefined) throw new TypeError("Canonical JSON value is unsupported");
  return scalar;
}

export function canonicalBugEvidence(input: readonly BugEvidence[]): readonly BugEvidence[] {
  return [...new Map(input.map((item) => [JSON.stringify(item), item])).values()].toSorted(
    (left, right) =>
      `${left.field}\u0000${left.messageId}\u0000${left.start}\u0000${left.end}\u0000${left.quote}`.localeCompare(
        `${right.field}\u0000${right.messageId}\u0000${right.start}\u0000${right.end}\u0000${right.quote}`,
      ),
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function confirmedBugPacket(input: {
  readonly bugId: string;
  readonly revision: number;
  readonly fields: BugPacketFields;
  readonly confirmedAt: string;
  readonly source: BugPacketSource;
  readonly evidence: readonly BugEvidence[];
}): Promise<ConfirmedBugPacket> {
  if (
    !/^BUG-[A-Z0-9]{8,32}$/.test(input.bugId) ||
    !Number.isInteger(input.revision) ||
    input.revision < 1
  ) {
    throw new TypeError("Confirmed bug packet identity is invalid");
  }
  const evidence = canonicalBugEvidence(input.evidence);
  const evidenceDigest = await sha256(canonicalJson(evidence));
  const unsigned = {
    schemaVersion: BUG_PACKET_VERSION,
    bugId: input.bugId,
    status: "confirmed" as const,
    revision: input.revision,
    fields: input.fields,
    confirmation: { reporterConfirmed: true as const, confirmedAt: input.confirmedAt },
    source: input.source,
    evidenceDigest,
  };
  return { ...unsigned, packetDigest: await sha256(canonicalJson(unsigned)) };
}
