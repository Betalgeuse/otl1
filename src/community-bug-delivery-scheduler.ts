import {
  BUG_DELIVERY_WORKER_ID,
  bugQuestionForField,
  failClaimedBugDelivery,
  sendClaimedBugDelivery,
} from "./community-bug-delivery";
import { CommunityBugDueDeliveryStore } from "./community-bug-delivery-due-store";
import { confirmedFieldsFromSanitized } from "./community-bug-facts";
import { isBugField } from "./community-bug-schema";
import { bugConfirmationPayload, bugQuestionPayload } from "./community-bug-slack";
import type { CommunityContext, CommunityEnv } from "./community-runtime";
import { CommunityStore } from "./community-store";
import type { Json } from "./input";
import { NeonStore } from "./store";

const BATCH_LIMIT = 10 as const;

function contextFor(
  env: CommunityEnv,
  store: CommunityStore,
  teamId: string,
  channelId: string,
  reporterId: string,
  thread: string,
  scheduledTime: number,
): CommunityContext {
  return {
    env,
    store,
    scope: { teamId, channelId, userId: reporterId },
    date: new Date(scheduledTime + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10),
    thread,
    source: thread,
    key: `bug-delivery-scheduler:${scheduledTime}`,
  };
}

function render(
  due: Awaited<ReturnType<CommunityBugDueDeliveryStore["claim"]>>[number],
  context: CommunityContext,
): Json | null {
  const delivery = due.delivery;
  switch (delivery.deliveryKind) {
    case "question": {
      if (!delivery.questionId || !delivery.fieldName || !isBugField(delivery.fieldName))
        return null;
      return bugQuestionPayload(
        context,
        delivery.bugId,
        delivery.questionId,
        delivery.packetRevision,
        bugQuestionForField(delivery.fieldName),
      );
    }
    case "summary": {
      const fields = confirmedFieldsFromSanitized(due.sanitizedFields);
      return fields
        ? bugConfirmationPayload(
            context,
            delivery.bugId,
            delivery.bugId,
            due.reportRevision,
            fields,
          )
        : null;
    }
    case "receipt":
      return { text: `접수됨 ${delivery.bugId}` };
    case "admin_handoff":
      return {
        text:
          delivery.destination === "admin_channel"
            ? `비공개 버그 인계 ${delivery.bugId}`
            : `비공개 접수 ${delivery.bugId}`,
      };
  }
}

export async function runDueBugDeliveries(
  env: CommunityEnv,
  scheduledTime: number,
): Promise<number> {
  console.log(
    JSON.stringify({
      event: "community.bug.delivery.scheduler.start",
      scheduledTime,
      claimed: 0,
      sent: 0,
      failed: 0,
    }),
  );
  const db = new NeonStore(env.DATABASE_URL);
  const leaseToken = crypto.randomUUID();
  const due = await new CommunityBugDueDeliveryStore(db).claim({
    workerId: BUG_DELIVERY_WORKER_ID,
    leaseToken,
    limit: BATCH_LIMIT,
    now: new Date(scheduledTime).toISOString(),
  });
  const communityStore = new CommunityStore(db);
  let sent = 0;
  let failed = 0;
  for (const item of due) {
    const context = contextFor(
      env,
      communityStore,
      item.delivery.teamId,
      item.sourceChannelId,
      item.reporterId,
      item.sourceThread,
      scheduledTime,
    );
    const message = render(item, context);
    if (message === null) {
      await failClaimedBugDelivery(context, item.delivery, item.reporterId, leaseToken);
      failed += 1;
      continue;
    }
    const result = await sendClaimedBugDelivery(
      context,
      item.delivery,
      item.reporterId,
      leaseToken,
      message,
    );
    if (result === "sent") sent += 1;
    else failed += 1;
  }
  console.log(
    JSON.stringify({
      event: "community.bug.delivery.scheduler.end",
      scheduledTime,
      claimed: due.length,
      sent,
      failed,
    }),
  );
  return due.length;
}
