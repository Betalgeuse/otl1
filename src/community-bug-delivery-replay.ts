import { deliverBugQuestion, questionDeliveryFromRead } from "./community-bug-delivery";
import { CommunityBugDueDeliveryStore } from "./community-bug-delivery-due-store";
import {
  deliverBugHandoff,
  deliverBugSummary,
  deliverPrivateBugOutbox,
} from "./community-bug-delivery-messages";
import { confirmedFieldsFromDraft } from "./community-bug-facts";
import { CommunityBugStore } from "./community-bug-store";
import type { CommunityContext } from "./community-runtime";
import { NeonStore } from "./store";

export async function replayBugDelivery(context: CommunityContext): Promise<boolean> {
  const store = new CommunityBugStore(new NeonStore(context.env.DATABASE_URL));
  const draft = await store.findActiveDraft({
    teamId: context.scope.teamId,
    reporterId: context.scope.userId,
    sourceOpaqueRef: `slack:${context.scope.teamId}:${context.scope.channelId}:${context.thread}`,
  });
  if (!draft) return false;
  if (
    draft.state === "private_incident" ||
    draft.sanitizedFields.privacy === true ||
    draft.sanitizedFields.impact === "security_privacy"
  ) {
    if (draft.state !== "private_incident") {
      await new CommunityBugDueDeliveryStore(
        new NeonStore(context.env.DATABASE_URL),
      ).reconcilePrivate({
        teamId: context.scope.teamId,
        limit: 25,
        now: new Date().toISOString(),
      });
      const reconciled = await store.getDraft({
        teamId: context.scope.teamId,
        bugId: draft.bugId,
        reporterId: draft.reporterId,
      });
      if (reconciled.state !== "private_incident") return true;
    }
    await deliverPrivateBugOutbox(context, {
      bugId: draft.bugId,
      reporterId: draft.reporterId,
      packetRevision: draft.packetRevision,
    });
    return true;
  }
  if (draft.state === "needs_info_exhausted") {
    await deliverBugHandoff(context, {
      bugId: draft.bugId,
      reporterId: draft.reporterId,
      packetRevision: draft.packetRevision,
    });
    return true;
  }
  const question = draft.questions.findLast((item) => !item.answered);
  if (question) {
    const input = questionDeliveryFromRead(draft.bugId, draft.reporterId, question);
    if (!input) return false;
    await deliverBugQuestion(context, input);
    return true;
  }
  const fields = confirmedFieldsFromDraft(draft);
  if (!fields) return false;
  await deliverBugSummary(context, {
    bugId: draft.bugId,
    reporterId: draft.reporterId,
    packetRevision: draft.packetRevision,
    revision: draft.revision,
    label: draft.bugId,
    fields,
  });
  return true;
}
