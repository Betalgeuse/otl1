import { CommunitySlackError, callSlack } from "./community-social";
import type { ReminderBatch, ReminderBatchFinish, ReminderJob } from "./community-types";
import { list, object, string } from "./input";

export type ReminderBatchStore = {
  claimReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly workerId: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null>;
  finishReminderBatch(input: ReminderBatchFinish): Promise<boolean>;
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

async function alreadyPosted(
  token: string,
  channelId: string,
  text: string,
  firstAttemptAt: string,
): Promise<boolean> {
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
    if (list(response.messages).some((value) => object(value).text === text)) return true;
    const metadata =
      response.response_metadata === undefined ? {} : object(response.response_metadata);
    cursor = metadata.next_cursor === undefined ? "" : string(metadata.next_cursor);
    if (!cursor) return false;
  }
  throw new CommunitySlackError("history_incomplete");
}

function retryCode(error: CommunitySlackError): string {
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
}): Promise<number> {
  const leaseToken = crypto.randomUUID();
  const batch = await input.store.claimReminderBatch({
    teamId: input.teamId,
    channelId: input.channelId,
    now: input.now,
    workerId: "community-scheduler",
    leaseToken,
  });
  if (!batch) return 0;
  const text = renderReminderBatch(batch.jobs);
  if (!text) {
    await input.store.finishReminderBatch({
      teamId: input.teamId,
      channelId: input.channelId,
      leaseToken: batch.leaseToken,
      status: "failed",
      errorCode: "batch_too_large",
      retryAfterSeconds: 300,
    });
    return 0;
  }
  try {
    if (
      batch.attempt > 1 &&
      (await alreadyPosted(input.token, input.channelId, text, batch.firstAttemptAt))
    ) {
      await input.store.finishReminderBatch({
        teamId: input.teamId,
        channelId: input.channelId,
        leaseToken: batch.leaseToken,
        status: "sent",
      });
      return batch.jobs.length;
    }
    await callSlack(input.token, "chat.postMessage", {
      channel: input.channelId,
      text,
      blocks: text
        .split("\n\n")
        .filter((value) => value.includes("<@"))
        .map((value) => ({ type: "section", text: { type: "mrkdwn", text: value } })),
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
      leaseToken: batch.leaseToken,
      status: "failed",
      errorCode: retryCode(error),
      ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    });
    return 0;
  }
}
