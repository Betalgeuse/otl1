import type { CommunityEnv } from "./community-runtime";
import { addReactions, callSlack, removeReactions } from "./community-social";
import { object, string } from "./input";
import { NeonStore } from "./store";

type Notification = {
  readonly notificationId: number;
  readonly bugId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly kind: "task_started" | "task_ready" | "task_failed" | "change_merged";
  readonly taskUrl: string;
  readonly attempt: number;
  readonly reporterId: string | null;
  readonly adminId: string | null;
  readonly summary: string | null;
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
    !["task_started", "task_ready", "task_failed", "change_merged"].includes(kind) ||
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
    reporterId: typeof payload.reporterId === "string" ? payload.reporterId : null,
    adminId: typeof payload.adminId === "string" ? payload.adminId : null,
    summary: typeof payload.summary === "string" ? payload.summary.slice(0, 1200) : null,
  };
}

function notificationText(input: Notification): string {
  if (input.kind === "change_merged") {
    const mentions = [...new Set([input.adminId, input.reporterId].filter(Boolean))]
      .map((id) => `<@${id}>`)
      .join(" ");
    return `${mentions}\n수정을 완료하고 반영했어요! ✅\n${input.summary ?? "승인한 To-Be 기준으로 수정·검증·병합했습니다."}`;
  }
  return `${input.bugId} 자동 개선을 완료하지 못했어요. 운영자가 확인할게요.`;
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
      if (item.kind === "task_failed" || item.kind === "change_merged")
        await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
          channel: item.channelId,
          thread_ts: item.threadTs,
          text: notificationText(item),
        });
      if (item.kind === "change_merged") {
        await removeReactions(env.SLACK_BOT_TOKEN, {
          channel: item.channelId,
          ts: item.threadTs,
          names: ["loading"],
        });
        await addReactions(env.SLACK_BOT_TOKEN, {
          channel: item.channelId,
          ts: item.threadTs,
          names: ["white_check_mark"],
        });
      } else if (item.kind === "task_failed") {
        await removeReactions(env.SLACK_BOT_TOKEN, {
          channel: item.channelId,
          ts: item.threadTs,
          names: ["loading"],
        });
        await addReactions(env.SLACK_BOT_TOKEN, {
          channel: item.channelId,
          ts: item.threadTs,
          names: ["warning"],
        });
      }
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
