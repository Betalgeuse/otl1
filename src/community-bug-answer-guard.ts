import {
  bugDeliveryKey,
  deliverBugQuestion,
  questionDeliveryFromRead,
} from "./community-bug-delivery";
import { CommunityBugDeliveryStore } from "./community-bug-delivery-store";
import type { BugDraftRead, BugQuestionRead } from "./community-bug-types";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { NeonStore } from "./store";

export async function restoreUnseenBugQuestion(
  context: CommunityContext,
  draft: BugDraftRead,
  question: BugQuestionRead,
): Promise<boolean> {
  const input = questionDeliveryFromRead(draft.bugId, draft.reporterId, question);
  if (!input) return false;
  const destination = "reporter_thread" as const;
  const deliveryKey = bugDeliveryKey(
    draft.bugId,
    question.askedPacketRevision,
    "question",
    destination,
  );
  const deliveries = new CommunityBugDeliveryStore(new NeonStore(context.env.DATABASE_URL));
  const delivery = await deliveries.get({
    teamId: draft.teamId,
    bugId: draft.bugId,
    reporterId: draft.reporterId,
    deliveryKey,
  });
  if (delivery?.status === "sent") return false;
  await deliverBugQuestion(context, input);
  await ephemeral(context, {
    text: "질문 전달을 복구하고 있어요. 질문이 보이면 다시 답해 주세요.",
  });
  return true;
}
