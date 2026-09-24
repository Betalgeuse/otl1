import { armBugDeliveryClock } from "./community-bug-clock-client";
import { bugQuestionTemplate, deliverBugQuestion } from "./community-bug-delivery";
import { deliverBugSummary, deliverPrivateBugOutbox } from "./community-bug-delivery-messages";
import { advanceBugDialogue } from "./community-bug-dialogue";
import {
  containsSensitiveBugText,
  initialBugFieldsForDatabase,
  type ParsedBugReport,
  storedBugFields,
} from "./community-bug-facts";
import { randomBugIdentity, writeBugPrivateObject } from "./community-bug-private";
import { CommunityBugStore } from "./community-bug-store";
import type { BugDraft } from "./community-bug-types";
import {
  confirmCompactFeedback,
  type FeedbackAnalysis,
  postFeedbackAdminReview,
  publishFeedbackAnalysis,
} from "./community-feedback";
import { canonicalFeedbackContext, feedbackBugIdentity } from "./community-feedback-route";
import type { CommunityContext } from "./community-runtime";
import { InputError } from "./input";
import { NeonStore, StoreError } from "./store";

export async function startBugReport(
  context: CommunityContext,
  parsed: ParsedBugReport,
  feedbackAnalysis?: FeedbackAnalysis,
): Promise<{ readonly context: CommunityContext; readonly draft: BugDraft }> {
  const routeToFeedback = feedbackAnalysis !== undefined;
  const identity = routeToFeedback
    ? await feedbackBugIdentity(context)
    : {
        bugId: randomBugIdentity("BUG"),
        sourceOpaqueRef: `slack:${context.scope.teamId}:${context.scope.channelId}:${context.thread}`,
      };
  const bugId = identity.bugId;
  const source = { kind: "slack_thread", opaqueRef: identity.sourceOpaqueRef };
  const dialogue = await advanceBugDialogue({
    bugId,
    expectedRevision: 1,
    currentRevision: 1,
    source,
    messages: parsed.messages,
    candidates: parsed.candidates,
    now: new Date().toISOString(),
  });
  if (dialogue.status === "confirmed") throw new InputError("이미 확인된 제보예요.");
  const privateIncident =
    (dialogue.packet.impact.status === "known" &&
      dialogue.packet.impact.value === "security_privacy") ||
    parsed.messages.some((message) => containsSensitiveBugText(message.text));
  const sourceOpaqueRef = privateIncident
    ? `slack:${context.scope.teamId}:${context.scope.channelId}:${context.thread}`
    : identity.sourceOpaqueRef;
  const databaseFields = initialBugFieldsForDatabase(
    storedBugFields(dialogue.packet),
    privateIncident,
  );
  const store = new CommunityBugStore(new NeonStore(context.env.DATABASE_URL));
  const encrypted = await writeBugPrivateObject(context, bugId, 1, { parsed });
  const deliveryContext =
    privateIncident || !routeToFeedback
      ? context
      : await canonicalFeedbackContext(context, parsed, bugId);
  const createInput = {
    ...encrypted,
    bugId,
    teamId: context.scope.teamId,
    publicAlias: randomBugIdentity("B"),
    reporterId: context.scope.userId,
    source: "slack" as const,
    sourceOpaqueRef,
    sourceChannelId: deliveryContext.scope.channelId,
    sourceThread: deliveryContext.thread,
    idempotencyKey: routeToFeedback
      ? sourceOpaqueRef
      : `slack:${context.scope.teamId}:${context.scope.channelId}:${context.scope.userId}:${context.source}`,
    sanitizedFields: {
      title: privateIncident ? "비공개 버그 제보" : "Slack 버그 제보",
      ...databaseFields,
      privacy: privateIncident,
    },
  };
  let draft: BugDraft;
  try {
    draft = await store.createDraft(createInput);
  } catch (error) {
    try {
      draft = await store.createDraft(createInput);
    } catch (reconciliationError) {
      if (
        error instanceof StoreError &&
        reconciliationError instanceof StoreError &&
        error.code === "access" &&
        reconciliationError.code === "access"
      )
        await context.env.BUG_PRIVATE_OBJECTS?.delete(encrypted.opaqueRef);
      throw error;
    }
  }
  if (draft.bugId !== bugId) await context.env.BUG_PRIVATE_OBJECTS?.delete(encrypted.opaqueRef);
  if (privateIncident) {
    await deliverPrivateBugOutbox(context, {
      bugId: draft.bugId,
      reporterId: context.scope.userId,
      packetRevision: draft.packetRevision,
    });
    const observedAt = Date.now();
    await armBugDeliveryClock(context.env, {
      reason: "due",
      observedAt,
      nextDue: observedAt + 1_000,
    });
    return { context, draft };
  }
  if (feedbackAnalysis) {
    await publishFeedbackAnalysis(deliveryContext, {
      feedbackId: draft.bugId,
      analysis: feedbackAnalysis,
    });
    if (feedbackAnalysis.ready) {
      await confirmCompactFeedback(deliveryContext, {
        draft,
        parsed,
        sourceOpaqueRef,
        reporterId: context.scope.userId,
        fromState: "new",
      });
      await postFeedbackAdminReview(deliveryContext, {
        feedbackId: draft.bugId,
        packetRevision: draft.packetRevision + 1,
      });
      return { context: deliveryContext, draft };
    }
    const field = feedbackAnalysis.questionField ?? "expected";
    const text =
      feedbackAnalysis.question ??
      (field === "actual"
        ? "지금 어떤 점이 가장 불편한지 한 가지 사례로 알려주실래요?"
        : "이 의견이 반영되면 사용자가 무엇을 할 수 있게 되면 좋을까요?");
    const question = { field, kind: "free_text" as const, text };
    const questionId = `${draft.bugId}:q1:${field}`;
    const templateId = "question.feedback-context.v1";
    await store.transition({
      bugId: draft.bugId,
      toState: "needs_info",
      actors: ["deterministic_worker"],
      guard: { missingRequiredField: true },
      evidence: {
        reasonCodes: [`missing:${field}`],
        questionId,
        fieldName: field,
        templateVersion: templateId,
        questionText: text,
      },
      expectedRevision: draft.revision,
      idempotencyKey: `question:${context.key}`,
    });
    await deliverBugQuestion(deliveryContext, {
      bugId: draft.bugId,
      reporterId: context.scope.userId,
      packetRevision: draft.packetRevision,
      questionId,
      fieldName: field,
      templateId,
      question,
    });
    return { context: deliveryContext, draft };
  }
  if (dialogue.status === "awaiting_confirmation") {
    await deliverBugSummary(deliveryContext, {
      bugId: draft.bugId,
      reporterId: context.scope.userId,
      packetRevision: draft.packetRevision,
      revision: draft.revision,
      label: draft.publicAlias,
      fields: dialogue.summary.fields,
    });
    return { context: deliveryContext, draft };
  }
  if (dialogue.status !== "needs_info") throw new InputError("운영자 확인이 필요해요.");
  const questionId = `${draft.bugId}:q1:${dialogue.question.field}`;
  const templateId = bugQuestionTemplate(dialogue.question.field);
  await store.transition({
    bugId: draft.bugId,
    toState: "needs_info",
    actors: ["deterministic_worker"],
    guard: { missingRequiredField: true },
    evidence: {
      reasonCodes: [`missing:${dialogue.question.field}`],
      questionId,
      fieldName: dialogue.question.field,
      templateVersion: templateId,
      questionText: dialogue.question.text,
    },
    expectedRevision: draft.revision,
    idempotencyKey: `question:${context.key}`,
  });
  const observedAt = Date.now();
  await armBugDeliveryClock(context.env, {
    reason: "due",
    observedAt,
    nextDue: observedAt + 86_400_000,
  });
  await deliverBugQuestion(deliveryContext, {
    bugId: draft.bugId,
    reporterId: context.scope.userId,
    packetRevision: draft.packetRevision,
    questionId,
    fieldName: dialogue.question.field,
    templateId,
    question: dialogue.question,
  });
  return { context: deliveryContext, draft };
}
