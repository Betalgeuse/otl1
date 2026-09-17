import { nextBugQuestion } from "./community-bug-questions";
import {
  BUG_FREQUENCIES,
  BUG_IMPACTS,
  type BugDialogueInput,
  type BugDialogueResult,
  type BugEvidence,
  type BugFact,
  type BugField,
  type BugFrequency,
  type BugImpact,
  type BugPacketFields,
  type BugSafetyFlag,
  bugSafetyFlags,
  canonicalBugEvidence,
  confirmedBugPacket,
  type DraftBugPacket,
  isBugField,
  isBugFrequency,
  isBugImpact,
  isRecord,
  normalizeOccurredAt,
  type UnknownBugFact,
} from "./community-bug-schema";

const UNKNOWN: UnknownBugFact = { status: "unknown" };

function evidenceFrom(candidate: unknown, input: BugDialogueInput): BugEvidence | null {
  if (!isRecord(candidate)) return null;
  const { field, messageId, start, end, quote } = candidate;
  if (
    !isBugField(field) ||
    typeof messageId !== "string" ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    typeof quote !== "string" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  )
    return null;
  const message = input.messages.find((item) => item.id === messageId);
  if (!message || end > message.text.length || message.text.slice(start, end) !== quote)
    return null;
  return { field, messageId, start, end, quote };
}

function enumValue(
  field: "frequency" | "impact",
  candidate: Record<string, unknown>,
  quote: string,
): BugFrequency | BugImpact | null {
  const value = candidate.value;
  if (field === "frequency") {
    if (!BUG_FREQUENCIES.some((item) => item === value)) return null;
    if (value === "always" && /항상|매번|언제나|매일|정기적으로/.test(quote)) return value;
    if (value === "sometimes" && /가끔|때때로|간헐|종종/.test(quote)) return value;
    if (value === "once" && /한\s*번|1회|이번에만/.test(quote)) return value;
    return null;
  }
  if (!BUG_IMPACTS.some((item) => item === value)) return null;
  if (value === "blocked" && /할 수 없|진행.{0,6}못|막혔|차단/.test(quote)) return value;
  if (value === "wrong_data" && /데이터.{0,8}(틀|잘못)|값.{0,8}잘못/.test(quote)) return value;
  if (value === "security_privacy" && /개인정보|이메일.{0,8}보|보안|노출/.test(quote)) return value;
  if (value === "inconvenience" && /불편|번거|느림|느려/.test(quote)) return value;
  return null;
}

function draft(input: BugDialogueInput): {
  readonly packet: DraftBugPacket;
  readonly contradictions: readonly string[];
  readonly evidence: readonly BugEvidence[];
  readonly safetyFlags: readonly BugSafetyFlag[];
} {
  const accepted = (input.candidates ?? []).flatMap((candidate) => {
    const evidence = evidenceFrom(candidate, input);
    if (!evidence || !isRecord(candidate)) return [];
    if (evidence.field === "frequency" || evidence.field === "impact") {
      const value = enumValue(evidence.field, candidate, evidence.quote);
      return value === null ? [] : [{ evidence, value }];
    }
    if (evidence.field === "occurredAt") {
      const value = normalizeOccurredAt(evidence.quote, input.now);
      return value === null ? [] : [{ evidence, value }];
    }
    if (evidence.field === "steps") {
      const value = candidate.value;
      const normalized = normalizedScheduledStep(evidence.quote);
      return Array.isArray(value) &&
        value.length === 1 &&
        (value[0] === evidence.quote || value[0] === normalized)
        ? [{ evidence, value: normalized ?? evidence.quote }]
        : [];
    }
    return candidate.value === evidence.quote ? [{ evidence, value: evidence.quote }] : [];
  });
  const fact = (field: BugField): BugFact<string> => {
    const matches = accepted.filter((item) => item.evidence.field === field);
    const values = [...new Set(matches.map((item) => item.value))];
    if (values.length !== 1) return UNKNOWN;
    const value = values[0];
    if (value === undefined) return UNKNOWN;
    return { status: "known", value, evidence: matches.map((item) => item.evidence) };
  };
  const steps = [
    ...new Map(
      accepted.filter((item) => item.evidence.field === "steps").map((item) => [item.value, item]),
    ).values(),
  ].toSorted((left, right) => {
    const leftMessage = input.messages.findIndex((item) => item.id === left.evidence.messageId);
    const rightMessage = input.messages.findIndex((item) => item.id === right.evidence.messageId);
    return leftMessage - rightMessage || left.evidence.start - right.evidence.start;
  });
  const stepFact: BugFact<readonly string[]> =
    steps.length >= 2
      ? {
          status: "known",
          value: steps.map((item) => item.value),
          evidence: steps.map((item) => item.evidence),
        }
      : UNKNOWN;
  const frequencyValue = fact("frequency");
  const impactValue = fact("impact");
  const frequencyFact: BugFact<BugFrequency> =
    frequencyValue.status === "known" && isBugFrequency(frequencyValue.value)
      ? { status: "known", value: frequencyValue.value, evidence: frequencyValue.evidence }
      : UNKNOWN;
  const impactFact: BugFact<BugImpact> =
    impactValue.status === "known" && isBugImpact(impactValue.value)
      ? { status: "known", value: impactValue.value, evidence: impactValue.evidence }
      : UNKNOWN;
  const packet: DraftBugPacket = {
    actual: fact("actual"),
    expected: fact("expected"),
    steps: stepFact,
    location: fact("location"),
    occurredAt: fact("occurredAt"),
    frequency: frequencyFact,
    impact: impactFact,
  };
  const contradictions: string[] = [];
  for (const field of [
    "actual",
    "expected",
    "location",
    "occurredAt",
    "frequency",
    "impact",
  ] as const) {
    if (
      new Set(accepted.filter((item) => item.evidence.field === field).map((item) => item.value))
        .size > 1
    )
      contradictions.push(`multiple_values:${field}`);
  }
  if (
    packet.actual.status === "known" &&
    packet.expected.status === "known" &&
    packet.actual.value === packet.expected.value
  )
    contradictions.push("actual_equals_expected");
  const evidence = accepted.map((item) => item.evidence);
  return { packet, contradictions, evidence, safetyFlags: bugSafetyFlags(evidence) };
}

function normalizedScheduledStep(quote: string): string | null {
  if (/동작(?:은|이)?\s*없/.test(quote)) return "사용자 동작 없음";
  if (/(?:원\s*씽\s*)?후기\s*(?:수집|collect)\s*(?:trigger|트리거)?/i.test(quote))
    return "ONE THING 후기 수집 트리거 실행";
  return null;
}

function fields(packet: DraftBugPacket): BugPacketFields | null {
  if (
    packet.actual.status === "unknown" ||
    packet.expected.status === "unknown" ||
    packet.steps.status === "unknown" ||
    packet.location.status === "unknown" ||
    packet.occurredAt.status === "unknown" ||
    packet.frequency.status === "unknown" ||
    packet.impact.status === "unknown"
  )
    return null;
  const [first, second, ...rest] = packet.steps.value;
  if (first === undefined || second === undefined) return null;
  return {
    actual: packet.actual.value,
    expected: packet.expected.value,
    steps: [first, second, ...rest],
    location: packet.location.value,
    occurredAt: packet.occurredAt.value,
    frequency: packet.frequency.value,
    impact: packet.impact.value,
  };
}

export async function advanceBugDialogue(input: BugDialogueInput): Promise<BugDialogueResult> {
  const { packet, contradictions, evidence, safetyFlags } = draft(input);
  const context = { packet, contradictions, safetyFlags };
  if (input.cancelledAt) return { ...context, status: "cancelled", cancelledAt: input.cancelledAt };
  if (input.expectedRevision !== input.currentRevision)
    return {
      ...context,
      status: "stale",
      expectedRevision: input.expectedRevision,
      currentRevision: input.currentRevision,
      handoff: true,
    };
  const complete = contradictions.length === 0 ? fields(packet) : null;
  if (complete) {
    if (!input.reporterConfirmedAt || !Number.isFinite(Date.parse(input.reporterConfirmedAt))) {
      return {
        ...context,
        status: "awaiting_confirmation",
        summary: { fields: complete, source: input.source },
      };
    }
    return {
      status: "confirmed",
      safetyFlags,
      evidence: canonicalBugEvidence(evidence),
      packet: await confirmedBugPacket({
        bugId: input.bugId,
        revision: input.currentRevision,
        fields: complete,
        confirmedAt: input.reporterConfirmedAt,
        source: input.source,
        evidence,
      }),
    };
  }
  const cutoff = Date.parse(input.now) - 24 * 60 * 60 * 1000;
  const recent = (input.askedQuestions ?? []).filter((item) => {
    const at = Date.parse(item.askedAt);
    return Number.isFinite(at) && at >= cutoff && at <= Date.parse(input.now);
  });
  const questionCount = input.questionCount ?? recent.length;
  const startedAt = input.needsInfoStartedAt ? Date.parse(input.needsInfoStartedAt) : Number.NaN;
  const expired = Number.isFinite(startedAt) && startedAt <= Date.parse(input.now) - 86_400_000;
  if (questionCount >= 5 || recent.length >= 5 || expired)
    return { ...context, status: "exhausted", handoff: true };
  const question = nextBugQuestion(
    packet,
    contradictions,
    recent.map((item) => item.field),
  );
  return { ...context, status: "needs_info", question };
}
