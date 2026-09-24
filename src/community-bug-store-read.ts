import type { BugFrequency, BugImpact, ConfirmedIssuePacket } from "./community-bug-schema";
import { BUG_STATES, type BugDraftRead, BugStoreError } from "./community-bug-types";
import type { Json } from "./input";

type JsonObject = { readonly [key: string]: Json };

function object(value: Json): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BugStoreError("response");
  }
  return Object.fromEntries(Object.entries(value));
}

function textField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new BugStoreError("response");
  return field;
}

function numberField(value: JsonObject, key: string): number {
  const field = value[key];
  const parsed = typeof field === "string" ? Number(field) : field;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new BugStoreError("response");
  }
  return parsed;
}

function nullableText(value: JsonObject, key: string): string | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string") throw new BugStoreError("response");
  return field;
}

function bugState(value: string): BugDraftRead["state"] {
  for (const state of BUG_STATES) if (value === state) return state;
  throw new BugStoreError("response");
}

function bugFrequency(value: string): BugFrequency {
  for (const frequency of ["always", "sometimes", "once"] as const) {
    if (value === frequency) return frequency;
  }
  throw new BugStoreError("response");
}

function bugImpact(value: string): BugImpact {
  for (const impact of ["inconvenience", "blocked", "wrong_data", "security_privacy"] as const) {
    if (value === impact) return impact;
  }
  throw new BugStoreError("response");
}

export function parseConfirmedPacket(value: Json): ConfirmedIssuePacket {
  const row = object(value);
  const fields = object(row.fields ?? null);
  const confirmation = object(row.confirmation ?? null);
  const source = object(row.source ?? null);
  if (row.status !== "confirmed" || confirmation.reporterConfirmed !== true) {
    throw new BugStoreError("response");
  }
  if (row.schemaVersion === "feedback_packet.v1") {
    return {
      schemaVersion: "feedback_packet.v1",
      bugId: textField(row, "bugId"),
      status: "confirmed",
      revision: numberField(row, "revision"),
      fields: {
        actual: textField(fields, "actual"),
        expected: textField(fields, "expected"),
      },
      confirmation: {
        reporterConfirmed: true,
        confirmedAt: textField(confirmation, "confirmedAt"),
      },
      source: { kind: textField(source, "kind"), opaqueRef: textField(source, "opaqueRef") },
      evidenceDigest: textField(row, "evidenceDigest"),
      packetDigest: textField(row, "packetDigest"),
    };
  }
  if (row.schemaVersion !== "bug_packet.v1") throw new BugStoreError("response");
  const steps = fields.steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.some((step) => typeof step !== "string")) {
    throw new BugStoreError("response");
  }
  const first = steps[0];
  const second = steps[1];
  if (typeof first !== "string" || typeof second !== "string") throw new BugStoreError("response");
  return {
    schemaVersion: "bug_packet.v1",
    bugId: textField(row, "bugId"),
    status: "confirmed",
    revision: numberField(row, "revision"),
    fields: {
      actual: textField(fields, "actual"),
      expected: textField(fields, "expected"),
      steps: [first, second, ...steps.slice(2)],
      location: textField(fields, "location"),
      occurredAt: textField(fields, "occurredAt"),
      frequency: bugFrequency(textField(fields, "frequency")),
      impact: bugImpact(textField(fields, "impact")),
    },
    confirmation: {
      reporterConfirmed: true,
      confirmedAt: textField(confirmation, "confirmedAt"),
    },
    source: { kind: textField(source, "kind"), opaqueRef: textField(source, "opaqueRef") },
    evidenceDigest: textField(row, "evidenceDigest"),
    packetDigest: textField(row, "packetDigest"),
  };
}

function revisionStatus(value: string): BugDraftRead["currentRevision"]["status"] {
  for (const status of ["draft", "answered", "confirmed"] as const) {
    if (value === status) return status;
  }
  throw new BugStoreError("response");
}

function revisionSchema(value: string): BugDraftRead["currentRevision"]["schemaVersion"] {
  if (value === "bug_intake.v1" || value === "bug_packet.v1" || value === "feedback_packet.v1")
    return value;
  throw new BugStoreError("response");
}

export function parseBugDraftRead(value: Json): BugDraftRead {
  const row = object(value);
  const source = object(row.source ?? null);
  const revision = object(row.currentRevision ?? null);
  const sanitizedFields = object(row.sanitizedFields ?? null);
  const questionValues = row.questions;
  if (!Array.isArray(questionValues)) throw new BugStoreError("response");
  const channelId = source.channelId;
  const thread = source.thread;
  const confirmed = revision.confirmedPacket;
  if (confirmed === undefined) throw new BugStoreError("response");
  return {
    bugId: textField(row, "bugId"),
    teamId: textField(row, "teamId"),
    state: bugState(textField(row, "state")),
    revision: numberField(row, "revision"),
    packetRevision: numberField(row, "packetRevision"),
    needsInfoStartedAt: nullableText(row, "needsInfoStartedAt"),
    reporterId: textField(row, "reporterId"),
    sanitizedFields,
    source: {
      kind: textField(source, "kind"),
      opaqueRef: textField(source, "opaqueRef"),
      ...(typeof channelId === "string" ? { channelId } : {}),
      ...(typeof thread === "string" ? { thread } : {}),
    },
    currentRevision: {
      packetRevision: numberField(revision, "packetRevision"),
      schemaVersion: revisionSchema(textField(revision, "schemaVersion")),
      status: revisionStatus(textField(revision, "status")),
      latestOpaqueRef: textField(revision, "latestOpaqueRef"),
      objectDigest: textField(revision, "objectDigest"),
      envelopeDek: textField(revision, "envelopeDek"),
      kekVersion: textField(revision, "kekVersion"),
      nonce: textField(revision, "nonce"),
      evidenceDigest: nullableText(revision, "evidenceDigest"),
      packetDigest: nullableText(revision, "packetDigest"),
      confirmedPacket: confirmed === null ? null : parseConfirmedPacket(confirmed),
    },
    questions: questionValues.map((question) => {
      const item = object(question);
      const answered = item.answered;
      if (typeof answered !== "boolean") throw new BugStoreError("response");
      return {
        questionId: textField(item, "questionId"),
        fieldName: textField(item, "fieldName"),
        templateVersion: textField(item, "templateVersion"),
        questionText: textField(item, "questionText"),
        askedPacketRevision: numberField(item, "askedPacketRevision"),
        askedAt: textField(item, "askedAt"),
        answered,
        answerDigest: nullableText(item, "answerDigest"),
        answerOpaqueRef: nullableText(item, "answerOpaqueRef"),
        answerPacketRevision:
          item.answerPacketRevision === null ? null : numberField(item, "answerPacketRevision"),
        completeness: item.completeness ?? null,
      };
    }),
  };
}
