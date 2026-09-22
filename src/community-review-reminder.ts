import { memberActionBlock } from "./community-member-actions";
import { CommunitySlackError, callSlack } from "./community-social";
import type { ReminderBatch, ReminderBatchFinish, ReminderJob } from "./community-types";
import { type Json, list, object, string } from "./input";

type ReviewReminderStore = {
  finishReviewReminderBatch(
    input: ReminderBatchFinish & { readonly messageTs?: string },
  ): Promise<boolean>;
};

export async function exactThreadReplyTimestamp(
  token: string,
  channelId: string,
  threadTs: string,
  text: string,
  firstAttemptAt: string,
): Promise<string | null> {
  let cursor = "";
  const oldest = Date.parse(firstAttemptAt) / 1_000;
  for (let page = 0; page < 10; page += 1) {
    const response = object(
      await callSlack(token, "conversations.replies", {
        channel: channelId,
        ts: threadTs,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const value of list(response.messages)) {
      const message = object(value);
      const timestamp = string(message.ts);
      if (message.text === text && Number(timestamp) >= oldest) return timestamp;
    }
    const metadata =
      response.response_metadata === undefined ? {} : object(response.response_metadata);
    cursor = metadata.next_cursor === undefined ? "" : string(metadata.next_cursor);
    if (!cursor) return null;
  }
  throw new CommunitySlackError("history_incomplete");
}

function retryCode(error: CommunitySlackError): string {
  if (["rate_limited", "transport_error", "history_incomplete"].includes(error.code))
    return error.code;
  return /^http_5\d\d$/.test(error.code) ? "http_5xx" : "terminal_provider_error";
}

export async function deliverReviewReminder(input: {
  readonly token: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly batch: ReminderBatch;
  readonly store: ReviewReminderStore;
  readonly render: (jobs: readonly ReminderJob[]) => string | null;
  readonly memberActions?: boolean;
}): Promise<number> {
  const text = input.render(input.batch.jobs);
  const threadTs = input.batch.threadTs;
  if (!text || !threadTs) {
    await input.store.finishReviewReminderBatch({
      teamId: input.teamId,
      channelId: input.channelId,
      leaseToken: input.batch.leaseToken,
      status: "failed",
      errorCode: text ? "terminal_provider_error" : "batch_too_large",
      retryAfterSeconds: 300,
    });
    return 0;
  }
  try {
    const reconciled =
      input.batch.attempt > 1
        ? await exactThreadReplyTimestamp(
            input.token,
            input.channelId,
            threadTs,
            text,
            input.batch.firstAttemptAt,
          )
        : null;
    const blocks: Json[] = text
      .split("\n\n")
      .filter((value) => value.includes("<@"))
      .map((value) => ({ type: "section", text: { type: "mrkdwn", text: value } }));
    if (input.memberActions) blocks.push(memberActionBlock());
    const messageTs =
      reconciled ??
      string(
        (
          await callSlack(input.token, "chat.postMessage", {
            channel: input.channelId,
            thread_ts: threadTs,
            text,
            blocks,
          })
        ).ts,
      );
    await input.store.finishReviewReminderBatch({
      teamId: input.teamId,
      channelId: input.channelId,
      leaseToken: input.batch.leaseToken,
      status: "sent",
      messageTs,
    });
    return input.batch.jobs.length;
  } catch (error) {
    if (!(error instanceof CommunitySlackError)) throw error;
    await input.store.finishReviewReminderBatch({
      teamId: input.teamId,
      channelId: input.channelId,
      leaseToken: input.batch.leaseToken,
      status: "failed",
      errorCode: retryCode(error),
      ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    });
    return 0;
  }
}
