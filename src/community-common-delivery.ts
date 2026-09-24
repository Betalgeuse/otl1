import { type MemberNavigation, memberActionBlocks } from "./community-member-actions";
import { exactMessageTimestamp, reminderRetryCode } from "./community-reminder-batch";
import { CommunitySlackError, callSlack } from "./community-social";
import type { CommunityStore } from "./community-store";
import type { CommunityScope } from "./community-types";
import { InputError, string } from "./input";

type CommonStore = Pick<
  CommunityStore,
  "putRecord" | "claimCommonDelivery" | "finishCommonDelivery" | "finishReviewRoot"
>;

async function finishSent(
  store: CommonStore,
  scope: CommunityScope,
  delivery: {
    readonly leaseToken: string;
    readonly key: string;
    readonly date: string;
    readonly kind: "goal" | "review";
  },
  messageTs: string,
  reviewThreadV2: boolean,
): Promise<void> {
  await store.putRecord({
    ...scope,
    key: `prompt:${messageTs}`,
    kind: "prompt",
    body: { date: delivery.date, kind: delivery.kind },
  });
  await store.putRecord({
    ...scope,
    key: `common-thread:${delivery.date}:${delivery.kind}`,
    kind: "prompt",
    body: { date: delivery.date, kind: delivery.kind, ts: messageTs },
  });
  if (delivery.kind === "review" && reviewThreadV2) {
    await store.finishReviewRoot({
      ...scope,
      leaseToken: delivery.leaseToken,
      date: delivery.date,
      messageTs,
    });
    return;
  }
  await store.finishCommonDelivery({
    ...scope,
    leaseToken: delivery.leaseToken,
    status: "sent",
    messageTs,
  });
}

export async function enqueueCommonDelivery(
  store: CommonStore,
  scope: CommunityScope,
  date: string,
  kind: "goal" | "review",
  text: string,
): Promise<void> {
  await store.putRecord({
    ...scope,
    key: `common:${date}:${kind}`,
    kind: "dispatch",
    body: { date, kind, text },
  });
}

export async function sendCommonDeliveries(input: {
  readonly token: string;
  readonly now: string;
  readonly scope: CommunityScope;
  readonly store: CommonStore;
  readonly reviewThreadV2?: boolean;
  readonly memberActions?: boolean;
  readonly navigation?: MemberNavigation;
}): Promise<number> {
  let sent = 0;
  for (let index = 0; index < 4; index += 1) {
    const delivery = await input.store.claimCommonDelivery({
      ...input.scope,
      now: input.now,
      leaseToken: crypto.randomUUID(),
    });
    if (!delivery) return sent;
    try {
      const reconciled =
        delivery.attempt > 1
          ? await exactMessageTimestamp(
              input.token,
              input.scope.channelId,
              delivery.text,
              delivery.firstAttemptAt,
            )
          : null;
      if (reconciled) {
        await finishSent(
          input.store,
          input.scope,
          delivery,
          reconciled,
          input.reviewThreadV2 === true,
        );
        sent += 1;
        continue;
      }
      const response = await callSlack(input.token, "chat.postMessage", {
        channel: input.scope.channelId,
        text: delivery.text,
        ...(input.memberActions
          ? {
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: delivery.text } },
                ...memberActionBlocks(input.navigation, delivery.date),
              ],
            }
          : {}),
      });
      const messageTs = string(response.ts);
      if (!/^\d+\.\d+$/.test(messageTs)) throw new InputError("Slack timestamp missing");
      await finishSent(
        input.store,
        input.scope,
        delivery,
        messageTs,
        input.reviewThreadV2 === true,
      );
      sent += 1;
    } catch (error) {
      if (!(error instanceof CommunitySlackError)) throw error;
      await input.store.finishCommonDelivery({
        ...input.scope,
        leaseToken: delivery.leaseToken,
        status: "failed",
        errorCode: reminderRetryCode(error),
        ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      });
      return sent;
    }
  }
  return sent;
}
