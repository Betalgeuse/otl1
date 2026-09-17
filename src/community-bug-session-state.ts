import { deliverBugHandoff } from "./community-bug-delivery-messages";
import type { ParsedBugReport } from "./community-bug-facts";
import type { BugDialogueInput } from "./community-bug-schema";
import { isBugField } from "./community-bug-schema";
import { CommunityBugStore } from "./community-bug-store";
import type { BugDraftRead } from "./community-bug-types";
import type { CommunityContext } from "./community-runtime";
import { NeonStore } from "./store";

export function bugDialogueInput(draft: BugDraftRead, parsed: ParsedBugReport): BugDialogueInput {
  return {
    bugId: draft.bugId,
    expectedRevision: draft.revision,
    currentRevision: draft.revision,
    source: { kind: draft.source.kind, opaqueRef: draft.source.opaqueRef },
    messages: parsed.messages,
    candidates: parsed.candidates,
    askedQuestions: draft.questions.map((question) => ({
      field: isBugField(question.fieldName) ? question.fieldName : "actual",
      askedAt: question.askedAt,
    })),
    questionCount: draft.questions.length,
    ...(draft.needsInfoStartedAt ? { needsInfoStartedAt: draft.needsInfoStartedAt } : {}),
    now: new Date().toISOString(),
  };
}

export async function exhaustBugReport(
  context: CommunityContext,
  draft: BugDraftRead,
  digest: string,
  packetRevision = draft.packetRevision,
): Promise<void> {
  await new CommunityBugStore(new NeonStore(context.env.DATABASE_URL)).transition({
    bugId: draft.bugId,
    toState: "needs_info_exhausted",
    actors: ["scheduler"],
    guard: { exhausted: true },
    evidence: { conversationDigest: digest, exhaustionReason: "question_or_time_limit" },
    expectedRevision: draft.revision,
    idempotencyKey: `exhausted:${context.key}`,
  });
  await deliverBugHandoff(context, {
    bugId: draft.bugId,
    reporterId: draft.reporterId,
    packetRevision,
  });
}
