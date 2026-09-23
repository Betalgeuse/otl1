import { type MemberNavigation, memberActionBlocks } from "./community-member-actions";
import { deliverReviewReminder, exactThreadReplyTimestamp } from "./community-review-reminder";
import { CommunitySlackError, callSlack } from "./community-social";
import type { ReminderBatch, ReminderBatchFinish, ReminderJob } from "./community-types";
import { type Json, list, object, string } from "./input";

export type ReminderBatchStore = {
  claimReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly workerId: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null>;
  claimReviewReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly workerId: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null>;
  claimGoalReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly workerId: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null>;
  finishReminderBatch(input: ReminderBatchFinish): Promise<boolean>;
  finishReviewReminderBatch(
    input: ReminderBatchFinish & { readonly messageTs?: string },
  ): Promise<boolean>;
  pruneReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null>;
};

function section(label: string, jobs: readonly ReminderJob[]): string {
  return `${label}: ${jobs.map((job) => `<@${job.userId}>`).join(" ")}`;
}

export function renderReminderBatch(jobs: readonly ReminderJob[]): string | null {
  const unique = new Map<string, ReminderJob>();
  for (const job of jobs) if (!unique.has(job.userId)) unique.set(job.userId, job);
  if (unique.size > 100) return null;
  const values = [...unique.values()].sort((left, right) =>
    `${left.kind}:${left.userId}`.localeCompare(`${right.kind}:${right.userId}`),
  );
  const goal = values.filter((job) => job.kind === "goal");
  const review = values.filter((job) => job.kind === "review");
  const sections = [
    ...(goal.length ? [section("*ONE THING*을 아직 안 적은 분", goal)] : []),
    ...(review.length ? [section("오늘 후기를 기다리는 분", review)] : []),
  ];
  if (sections.length === 0 || sections.some((value) => value.length > 2_800)) return null;
  return `${sections.join("\n\n")}\n\n개인 안내를 끄려면 “알림 설정”이라고 남겨주세요.`;
}

export function chunkReminderJobs(
  jobs: readonly ReminderJob[],
): readonly (readonly ReminderJob[])[] {
  const ordered = [...new Map(jobs.map((job) => [`${job.kind}:${job.userId}`, job])).values()].sort(
    (left, right) => `${left.kind}:${left.userId}`.localeCompare(`${right.kind}:${right.userId}`),
  );
  const chunks: ReminderJob[][] = [];
  let current: ReminderJob[] = [];
  for (const job of ordered) {
    const candidate = [...current, job];
    if (candidate.length > 100 || renderReminderBatch(candidate) === null) {
      if (current.length === 0) throw new CommunitySlackError("invalid_member_id");
      chunks.push(current);
      current = [job];
    } else current = candidate;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function exactMessageTimestamp(
  token: string,
  channelId: string,
  text: string,
  firstAttemptAt: string,
): Promise<string | null> {
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const response = object(
      await callSlack(token, "conversations.history", {
        channel: channelId,
        limit: 100,
        oldest: String(Date.parse(firstAttemptAt) / 1_000),
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const value of list(response.messages)) {
      const message = object(value);
      if (message.text === text) return string(message.ts);
    }
    const metadata =
      response.response_metadata === undefined ? {} : object(response.response_metadata);
    cursor = metadata.next_cursor === undefined ? "" : string(metadata.next_cursor);
    if (!cursor) return null;
  }
  throw new CommunitySlackError("history_incomplete");
}

export async function exactMessageAlreadyPosted(
  token: string,
  channelId: string,
  text: string,
  firstAttemptAt: string,
): Promise<boolean> {
  return (await exactMessageTimestamp(token, channelId, text, firstAttemptAt)) !== null;
}

export function reminderRetryCode(error: CommunitySlackError): string {
  if (["rate_limited", "transport_error", "history_incomplete"].includes(error.code))
    return error.code;
  return /^http_5\d\d$/.test(error.code) ? "http_5xx" : "terminal_provider_error";
}

export async function sendReminderBatch(input: {
  readonly token: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly now: string;
  readonly store: ReminderBatchStore;
  readonly reviewThreadV2?: boolean;
  readonly memberActions?: boolean;
  readonly navigation?: MemberNavigation;
}): Promise<number> {
  const leaseToken = crypto.randomUUID();
  const review =
    input.reviewThreadV2 === false
      ? null
      : await input.store.claimReviewReminderBatch({
          teamId: input.teamId,
          channelId: input.channelId,
          now: input.now,
          workerId: "community-scheduler",
          leaseToken,
        });
  if (review)
    return deliverReviewReminder({
      token: input.token,
      teamId: input.teamId,
      channelId: input.channelId,
      batch: review,
      store: input.store,
      render: renderReminderBatch,
      ...(input.memberActions === undefined ? {} : { memberActions: input.memberActions }),
      ...(input.navigation === undefined ? {} : { navigation: input.navigation }),
    });
  const claimInput = {
    teamId: input.teamId,
    channelId: input.channelId,
    now: input.now,
    workerId: "community-scheduler",
    leaseToken,
  };
  let batch =
    input.reviewThreadV2 === false
      ? await input.store.claimReminderBatch(claimInput)
      : await input.store.claimGoalReminderBatch(claimInput);
  if (!batch) return 0;
  const claimedLeaseToken = batch.leaseToken;
  const text = renderReminderBatch(batch.jobs);
  if (!text) {
    await input.store.finishReminderBatch({
      teamId: input.teamId,
      channelId: input.channelId,
      leaseToken: claimedLeaseToken,
      status: "failed",
      errorCode: "batch_too_large",
      retryAfterSeconds: 300,
    });
    return 0;
  }
  try {
    if (
      batch.attempt > 1 &&
      (await (batch.threadTs
        ? exactThreadReplyTimestamp(
            input.token,
            input.channelId,
            batch.threadTs,
            text,
            batch.firstAttemptAt,
          )
        : exactMessageAlreadyPosted(input.token, input.channelId, text, batch.firstAttemptAt)))
    ) {
      await input.store.finishReminderBatch({
        teamId: input.teamId,
        channelId: input.channelId,
        leaseToken: batch.leaseToken,
        status: "sent",
      });
      return batch.jobs.length;
    }
    if (batch.attempt > 1) {
      batch = await input.store.pruneReminderBatch({
        teamId: input.teamId,
        channelId: input.channelId,
        now: input.now,
        leaseToken: batch.leaseToken,
      });
      if (!batch) return 0;
    }
    const deliverableText = renderReminderBatch(batch.jobs);
    if (!deliverableText) throw new CommunitySlackError("invalid_batch");
    const blocks: Json[] = deliverableText
      .split("\n\n")
      .filter((value) => value.includes("<@"))
      .map((value) => ({ type: "section", text: { type: "mrkdwn", text: value } }));
    if (input.memberActions)
      blocks.push(...memberActionBlocks(input.navigation, batch.jobs[0]?.date));
    await callSlack(input.token, "chat.postMessage", {
      channel: input.channelId,
      text: deliverableText,
      ...(batch.threadTs ? { thread_ts: batch.threadTs } : {}),
      blocks,
    });
    await input.store.finishReminderBatch({
      teamId: input.teamId,
      channelId: input.channelId,
      leaseToken: batch.leaseToken,
      status: "sent",
    });
    return batch.jobs.length;
  } catch (error) {
    if (!(error instanceof CommunitySlackError)) throw error;
    await input.store.finishReminderBatch({
      teamId: input.teamId,
      channelId: input.channelId,
      leaseToken: claimedLeaseToken,
      status: "failed",
      errorCode: reminderRetryCode(error),
      ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    });
    return 0;
  }
}

export async function sendReminderBatches(input: {
  readonly token: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly now: string;
  readonly store: ReminderBatchStore;
  readonly reviewThreadV2?: boolean;
  readonly memberActions?: boolean;
  readonly navigation?: MemberNavigation;
}): Promise<number> {
  let delivered = 0;
  for (let batch = 0; batch < 10; batch += 1) {
    const count = await sendReminderBatch(input);
    if (count === 0) return delivered;
    delivered += count;
  }
  return delivered;
}
