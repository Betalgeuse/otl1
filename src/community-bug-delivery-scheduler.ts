import {
  BUG_DELIVERY_WORKER_ID,
  type BugDeliveryDueObserver,
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
class BugMaintenancePhaseError extends Error {
  constructor() {
    super("Bug maintenance phase failed");
    this.name = "BugMaintenancePhaseError";
  }
}

type PhaseResult<T> = { readonly value: T; readonly failed: boolean };
type BatchSummary = { readonly processed: number; readonly possiblyMore: boolean };
export type BugDeliveryMaintenanceResult = {
  readonly reconcilePrivate: BatchSummary;
  readonly expiry: BatchSummary;
  readonly deliveries: {
    readonly claimed: number;
    readonly sent: number;
    readonly failed: number;
    readonly possiblyMore: boolean;
  };
  readonly possiblyMore: boolean;
};

async function isolatedPhase<T>(
  phase: "reconcile_private" | "expire" | "claim",
  scheduledTime: number,
  fallback: T,
  work: () => Promise<T>,
): Promise<PhaseResult<T>> {
  try {
    return { value: await work(), failed: false };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "community.bug.delivery.phase.failed",
        phase,
        scheduledTime,
        code: "boundary_failure",
        failure: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return { value: fallback, failed: true };
  }
}

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
      return {
        text:
          delivery.templateId === "receipt.exhausted.v1"
            ? `추가 확인 시간이 지나 운영자에게 전달했어요. ${delivery.bugId}`
            : delivery.templateId === "receipt.private.v1"
              ? `비공개 접수 ${delivery.bugId}`
              : `접수됨 ${delivery.bugId}`,
      };
    case "admin_handoff":
      return {
        text:
          delivery.destination === "admin_channel"
            ? delivery.templateId === "admin_handoff.exhausted.v1"
              ? `추가 확인 종료 버그 인계 ${delivery.bugId}`
              : `비공개 버그 인계 ${delivery.bugId}`
            : `비공개 접수 ${delivery.bugId}`,
      };
  }
}

export async function runDueBugDeliveries(
  env: CommunityEnv,
  scheduledTime: number,
  observeDue?: BugDeliveryDueObserver,
): Promise<BugDeliveryMaintenanceResult> {
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
  const dueStore = new CommunityBugDueDeliveryStore(db);
  const now = new Date(scheduledTime).toISOString();
  const reconcile = await isolatedPhase("reconcile_private", scheduledTime, 0, () =>
    dueStore.reconcilePrivate({ teamId: env.SLACK_TEAM_ID, limit: BATCH_LIMIT, now }),
  );
  const expiry = await isolatedPhase("expire", scheduledTime, 0, () =>
    dueStore.expire({ teamId: env.SLACK_TEAM_ID, limit: BATCH_LIMIT, now }),
  );
  const claim = await isolatedPhase("claim", scheduledTime, [], () =>
    dueStore.claim({
      teamId: env.SLACK_TEAM_ID,
      workerId: BUG_DELIVERY_WORKER_ID,
      leaseToken,
      limit: BATCH_LIMIT,
      now,
    }),
  );
  const due = claim.value;
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
      await failClaimedBugDelivery(context, item.delivery, item.reporterId, leaseToken, observeDue);
      failed += 1;
      continue;
    }
    const result = await sendClaimedBugDelivery(
      context,
      item.delivery,
      item.reporterId,
      leaseToken,
      message,
      observeDue,
    );
    if (result === "sent") sent += 1;
    else failed += 1;
  }
  const result = {
    reconcilePrivate: {
      processed: reconcile.value,
      possiblyMore: reconcile.value >= BATCH_LIMIT,
    },
    expiry: { processed: expiry.value, possiblyMore: expiry.value >= BATCH_LIMIT },
    deliveries: {
      claimed: due.length,
      sent,
      failed,
      possiblyMore: due.length >= BATCH_LIMIT,
    },
  };
  const summary = {
    ...result,
    possiblyMore:
      result.reconcilePrivate.possiblyMore ||
      result.expiry.possiblyMore ||
      result.deliveries.possiblyMore,
  };
  console.log(
    JSON.stringify({
      event: "community.bug.delivery.scheduler.end",
      scheduledTime,
      reconciled: summary.reconcilePrivate.processed,
      expired: summary.expiry.processed,
      claimed: summary.deliveries.claimed,
      sent: summary.deliveries.sent,
      failed: summary.deliveries.failed,
      possiblyMore: summary.possiblyMore,
    }),
  );
  if (reconcile.failed || expiry.failed || claim.failed) throw new BugMaintenancePhaseError();
  return summary;
}
