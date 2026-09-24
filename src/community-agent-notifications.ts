import type { CommunityEnv } from "./community-runtime";
import { callSlack } from "./community-social";
import { object, string } from "./input";
import { NeonStore } from "./store";

type Notification = {
  readonly notificationId: number;
  readonly bugId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly kind: "task_started" | "task_ready" | "task_failed";
  readonly taskUrl: string;
  readonly attempt: number;
};

function parseNotification(value: unknown): Notification {
  const row = object(value);
  const payload = object(row.payload);
  const notificationId = Number(row.notification_id);
  const attempt = Number(payload.attempt);
  const kind = string(row.kind);
  const taskUrl = string(payload.taskUrl);
  if (
    !Number.isSafeInteger(notificationId) ||
    notificationId < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !["task_started", "task_ready", "task_failed"].includes(kind) ||
    !/^https:\/\/chatgpt[.]com\/codex\/tasks\/task_[a-z]_[a-f0-9]{32}$/.test(taskUrl)
  )
    throw new TypeError("invalid agent notification");
  return {
    notificationId,
    bugId: string(row.bug_id),
    channelId: string(row.channel_id),
    threadTs: string(row.thread_ts),
    kind: kind as Notification["kind"],
    taskUrl,
    attempt,
  };
}

function notificationText(input: Notification): string {
  if (input.kind === "task_started")
    return `GenQuant가 ${input.bugId} 재현 작업을 시작했어요. <${input.taskUrl}|Codex 작업 보기>`;
  if (input.kind === "task_ready")
    return `GenQuant가 ${input.bugId} 재현 증거를 확인했어요. <${input.taskUrl}|Codex 작업 보기>\n다음 수정 작업은 별도 lease로 이어집니다. 자동 병합은 하지 않습니다.`;
  return `GenQuant가 ${input.bugId} 재현 작업을 완료하지 못했어요. <${input.taskUrl}|Codex 작업 보기>\n실패 영수증을 남겼고 자동 병합은 진행하지 않았습니다.`;
}

export async function sendAgentNotifications(
  env: Pick<CommunityEnv, "SLACK_TEAM_ID" | "SLACK_BOT_TOKEN" | "DATABASE_URL">,
  now = new Date(),
): Promise<{ readonly claimed: number; readonly sent: number; readonly failed: number }> {
  const db = new NeonStore(env.DATABASE_URL);
  const leaseToken = crypto.randomUUID();
  const claimed = await db.queryJson("SELECT otl.bug_runner_claim_notifications($1::jsonb)", [
    JSON.stringify({ teamId: env.SLACK_TEAM_ID, leaseToken, limit: 10, now: now.toISOString() }),
  ]);
  if (!Array.isArray(claimed)) throw new TypeError("invalid agent notification batch");
  let sent = 0;
  let failed = 0;
  for (const raw of claimed) {
    const item = parseNotification(raw);
    try {
      await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
        channel: item.channelId,
        thread_ts: item.threadTs,
        text: notificationText(item),
      });
      await db.queryJson("SELECT otl.bug_runner_finish_notification($1::jsonb)", [
        JSON.stringify({
          notificationId: item.notificationId,
          leaseToken,
          status: "sent",
          now: now.toISOString(),
        }),
      ]);
      sent += 1;
    } catch {
      await db.queryJson("SELECT otl.bug_runner_finish_notification($1::jsonb)", [
        JSON.stringify({
          notificationId: item.notificationId,
          leaseToken,
          status: "failed",
          now: now.toISOString(),
        }),
      ]);
      failed += 1;
    }
  }
  return { claimed: claimed.length, sent, failed };
}
