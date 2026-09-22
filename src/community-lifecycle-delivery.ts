import { signLifecycleAction } from "./community-lifecycle-interactions";
import type { CommunityLifecycleRuntimeStore } from "./community-lifecycle-runtime-store";
import type { LifecycleActionId, LifecycleNotice } from "./community-lifecycle-runtime-types";
import { CommunitySlackError, callSlack } from "./community-social";
import type { Json } from "./input";
import { object, string } from "./input";

export const LIFECYCLE_NOTICE_BATCH = 10 as const;
export const LIFECYCLE_REQUIRED_SCOPES = ["im:write"] as const;

type SlackCall = (token: string, method: string, payload: Json) => Promise<Record<string, unknown>>;

type DeliveryStore = Pick<
  CommunityLifecycleRuntimeStore,
  "claimNotices" | "prepareNotice" | "finishNotice"
>;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function clientMessageId(effectKey: string): Promise<string> {
  const hash = await digest(effectKey);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function noticeText(notice: LifecycleNotice): string {
  switch (notice.kind) {
    case "grace_start":
      return "최근 참여 기록을 확인해 7일 유예가 시작됐어요. 기록은 그대로 보존됩니다.";
    case "three_days":
      return "유예 종료까지 3일 남았어요. 현재 참여 기록을 저장하면 기존 시즌이 이어집니다.";
    case "one_day":
      return "유예 종료까지 24시간 남았어요. 기록을 저장하거나 검토를 요청할 수 있어요.";
    case "extension":
      return "유예 기간을 한 번, 7일 연장했어요.";
    case "closure":
      return "현재 시즌이 휴면으로 닫혔어요. 기록은 보존되며 새 ONE THING으로 바로 돌아올 수 있어요.";
    case "return":
      return "새 ONE THING과 함께 돌아왔어요. 새로운 시즌이 시작됐습니다.";
  }
}

function actionsFor(notice: LifecycleNotice): readonly LifecycleActionId[] {
  switch (notice.kind) {
    case "grace_start":
    case "three_days":
    case "one_day":
      return ["lifecycle_extend", "lifecycle_review", "lifecycle_stop"];
    case "extension":
      return ["lifecycle_review", "lifecycle_stop"];
    case "closure":
      return ["lifecycle_review"];
    case "return":
      return [];
  }
}

async function message(notice: LifecycleNotice, secret: string): Promise<Json> {
  const actions = await Promise.all(
    actionsFor(notice).map(async (actionId) => ({
      type: "button",
      action_id: actionId,
      text: {
        type: "plain_text",
        text:
          actionId === "lifecycle_extend"
            ? "7일 연장"
            : actionId === "lifecycle_review"
              ? "계산 검토"
              : "이번 시즌 마치기",
      },
      value: await signLifecycleAction(
        {
          actionId,
          teamId: notice.teamId,
          channelId: notice.channelId,
          ownerId: notice.userId,
          revision: notice.revision,
          key: `${notice.effectKey}:${actionId}`,
        },
        secret,
      ),
    })),
  );
  const blocks: Json[] = [
    {
      type: "section",
      block_id: `lifecycle_notice:${notice.effectKey}`,
      text: { type: "mrkdwn", text: noticeText(notice) },
    },
  ];
  if (actions.length > 0) blocks.push({ type: "actions", elements: actions });
  return { text: noticeText(notice), blocks };
}

function deliveryFailure(
  error: unknown,
  now: number,
): {
  readonly status: "failed" | "dead";
  readonly code: string;
  readonly retryAt?: string;
} {
  if (error instanceof CommunitySlackError) {
    if (error.code === "missing_scope") return { status: "dead", code: "missing_im_write" };
    if (error.code === "rate_limited") {
      const delay = (error.retryAfterSeconds ?? 60) * 1_000;
      return { status: "failed", code: "http_429", retryAt: new Date(now + delay).toISOString() };
    }
    if (error.code === "transport_error" || error.code.startsWith("http_5"))
      return { status: "failed", code: error.code, retryAt: new Date(now + 60_000).toISOString() };
    return { status: "dead", code: "slack_rejected" };
  }
  return {
    status: "failed",
    code: "boundary_failure",
    retryAt: new Date(now + 60_000).toISOString(),
  };
}

export type LifecycleDeliveryResult = {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly dead: number;
  readonly possiblyMore: boolean;
  readonly errorCodes: Readonly<Record<string, number>>;
};

export async function deliverLifecycleNotices(input: {
  readonly store: DeliveryStore;
  readonly teamId: string;
  readonly token: string;
  readonly signingSecret: string;
  readonly now: number;
  readonly call?: SlackCall;
}): Promise<LifecycleDeliveryResult> {
  const leaseToken = crypto.randomUUID();
  const notices = await input.store.claimNotices({
    teamId: input.teamId,
    now: new Date(input.now).toISOString(),
    limit: LIFECYCLE_NOTICE_BATCH,
    leaseToken,
  });
  let sent = 0;
  let failed = 0;
  let dead = 0;
  const errorCodes: Record<string, number> = {};
  const slack = input.call ?? callSlack;
  for (const notice of notices) {
    try {
      const dmChannelId =
        notice.dmChannelId ??
        string(
          object(
            object(await slack(input.token, "conversations.open", { users: notice.userId }))
              .channel,
          ).id,
        );
      const payload = await message(notice, input.signingSecret);
      await input.store.prepareNotice({
        teamId: notice.teamId,
        userId: notice.userId,
        effectKey: notice.effectKey,
        leaseToken,
        now: new Date(input.now).toISOString(),
        dmChannelId,
        payloadDigest: await digest(JSON.stringify(payload)),
      });
      const response = await slack(input.token, "chat.postMessage", {
        ...object(payload),
        channel: dmChannelId,
        client_msg_id: await clientMessageId(notice.effectKey),
      });
      await input.store.finishNotice({
        teamId: notice.teamId,
        userId: notice.userId,
        effectKey: notice.effectKey,
        leaseToken,
        now: new Date(input.now).toISOString(),
        status: "sent",
        messageTs: string(response.ts),
      });
      sent += 1;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const outcome = deliveryFailure(error, input.now);
      await input.store.finishNotice({
        teamId: notice.teamId,
        userId: notice.userId,
        effectKey: notice.effectKey,
        leaseToken,
        now: new Date(input.now).toISOString(),
        status: outcome.status,
        errorCode: outcome.code,
        ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
      });
      errorCodes[outcome.code] = (errorCodes[outcome.code] ?? 0) + 1;
      if (outcome.status === "dead") dead += 1;
      else failed += 1;
    }
  }
  return {
    claimed: notices.length,
    sent,
    failed,
    dead,
    possiblyMore: notices.length >= LIFECYCLE_NOTICE_BATCH,
    errorCodes,
  };
}
