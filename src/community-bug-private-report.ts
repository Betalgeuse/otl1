import type { ParsedBugReport } from "./community-bug-facts";
import { readBugPrivateObject } from "./community-bug-private";
import { isBugField } from "./community-bug-schema";
import type { BugDraftRead, EncryptedObjectRef } from "./community-bug-types";
import type { CommunityContext } from "./community-runtime";
import { InputError, list, object, string } from "./input";

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InputError("버그 비공개 기록 형식이 올바르지 않아요.");
  return value;
}

function parsePrivateReport(value: unknown): ParsedBugReport {
  const root = object(value);
  const parsed = object(root.parsed);
  const messages = list(parsed.messages).map((value) => {
    const message = object(value);
    return { id: string(message.id), text: string(message.text), at: string(message.at) };
  });
  const candidates = list(parsed.candidates).map((value) => {
    const candidate = object(value);
    const field = string(candidate.field);
    if (!isBugField(field)) throw new InputError("버그 비공개 기록 형식이 올바르지 않아요.");
    const rawValue = candidate.value;
    const parsedValue = Array.isArray(rawValue) ? rawValue.map(string) : string(rawValue);
    return {
      field,
      messageId: string(candidate.messageId),
      start: number(candidate.start),
      end: number(candidate.end),
      quote: string(candidate.quote),
      value: parsedValue,
    };
  });
  return { messages, candidates };
}

export async function readBugPrivateReport(
  context: CommunityContext,
  draft: BugDraftRead,
): Promise<ParsedBugReport> {
  const revision = draft.currentRevision;
  return readBugPrivateReportRevision(context, {
    bugId: draft.bugId,
    packetRevision: revision.packetRevision,
    schemaVersion: revision.schemaVersion,
    opaqueRef: revision.latestOpaqueRef,
    objectDigest: revision.objectDigest,
    envelopeDek: revision.envelopeDek,
    kekVersion: revision.kekVersion,
    nonce: revision.nonce,
  });
}

export async function readBugPrivateReportRevision(
  context: CommunityContext,
  revision: PrivateBugRevision,
): Promise<ParsedBugReport> {
  return parsePrivateReport(
    await readBugPrivateObject(context, {
      bugId: revision.bugId,
      revision: revision.packetRevision,
      schemaVersion: revision.schemaVersion,
      opaqueRef: revision.opaqueRef,
      objectDigest: revision.objectDigest,
      envelopeDek: revision.envelopeDek,
      kekVersion: revision.kekVersion,
      nonce: revision.nonce,
    }),
  );
}
export type PrivateBugRevision = EncryptedObjectRef & {
  readonly bugId: string;
  readonly packetRevision: number;
  readonly schemaVersion: "bug_intake.v1" | "bug_packet.v1";
};
