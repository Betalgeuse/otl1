import { armBugDeliveryClock } from "./community-bug-clock-client";
import { bugQuestionTemplate, deliverBugQuestion } from "./community-bug-delivery";
import { deliverBugSummary } from "./community-bug-delivery-messages";
import { advanceBugDialogue } from "./community-bug-dialogue";
import { readBugPrivateReport } from "./community-bug-private-report";
import { bugDialogueInput, exhaustBugReport } from "./community-bug-session-state";
import { CommunityBugStore } from "./community-bug-store";
import type { BugDraftRead } from "./community-bug-types";
import type { CommunityContext } from "./community-runtime";
import { NeonStore } from "./store";

export async function resumeBugDialogue(
  context: CommunityContext,
  draft: BugDraftRead,
): Promise<boolean> {
  const result = await advanceBugDialogue(
    bugDialogueInput(draft, await readBugPrivateReport(context, draft)),
  );
  if (result.status === "exhausted") {
    await exhaustBugReport(context, draft, draft.currentRevision.objectDigest);
    return true;
  }
  if (result.status === "awaiting_confirmation") {
    await deliverBugSummary(context, {
      bugId: draft.bugId,
      reporterId: draft.reporterId,
      packetRevision: draft.packetRevision,
      revision: draft.revision,
      label: draft.bugId,
      fields: result.summary.fields,
    });
    return true;
  }
  if (result.status !== "needs_info") return true;
  const number = draft.questions.length + 1;
  const questionId = `${draft.bugId}:q${number}:${result.question.field}`;
  const templateId = bugQuestionTemplate(result.question.field);
  await new CommunityBugStore(new NeonStore(context.env.DATABASE_URL)).transition({
    bugId: draft.bugId,
    toState: "needs_info",
    actors: ["reporter", "deterministic_worker"],
    guard: { stillIncomplete: true },
    evidence: {
      answerRevision: draft.packetRevision,
      completenessResult: result.status,
      questionId,
      fieldName: result.question.field,
      templateVersion: templateId,
      questionText: result.question.text,
    },
    expectedRevision: draft.revision,
    idempotencyKey: `resume:${draft.bugId}:${draft.packetRevision}:${number}`,
  });
  const observedAt = Date.now();
  const nextDue = draft.needsInfoStartedAt
    ? Date.parse(draft.needsInfoStartedAt) + 86_400_000
    : observedAt + 86_400_000;
  await armBugDeliveryClock(context.env, { reason: "due", observedAt, nextDue });
  await deliverBugQuestion(context, {
    bugId: draft.bugId,
    reporterId: draft.reporterId,
    packetRevision: draft.packetRevision,
    questionId,
    fieldName: result.question.field,
    templateId,
    question: result.question,
  });
  return true;
}
