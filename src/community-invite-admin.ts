import { z } from "zod";
import { readInvitePrivateObject } from "./community-invite-private";
import { escapeSlackText } from "./community-messages";
import type { ReferralRuntimeStore, ReferralSlackPort } from "./community-referral-types";
import { InputError } from "./input";

export type InviteAdminEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly COMMUNITY_ADMIN_ID?: string;
  readonly INVITE_PRIVATE_OBJECTS?: import("./community-invite-private").InvitePrivateBucket;
  readonly INVITE_PRIVATE_KEK?: string;
  readonly INVITE_PRIVATE_KEK_VERSION?: string;
};

const actionValueSchema = z
  .object({
    requestId: z.string().regex(/^REQ-[A-Z0-9-]{4,64}$/),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

function decisionFromAction(
  actionId: string,
): "approved" | "declined" | "duplicate" | "suspected_abuse" | null {
  switch (actionId) {
    case "community_invite_approve":
      return "approved";
    case "community_invite_decline":
      return "declined";
    case "community_invite_duplicate":
      return "duplicate";
    case "community_invite_suspected_abuse":
      return "suspected_abuse";
    default:
      return null;
  }
}

function button(text: string, actionId: string, requestId: string, revision: number) {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value: JSON.stringify({ requestId, revision }),
  };
}

export async function deliverInviteAdminReview(
  env: InviteAdminEnv,
  store: ReferralRuntimeStore,
  slack: ReferralSlackPort,
  now = Date.now(),
): Promise<boolean> {
  const adminId = env.COMMUNITY_ADMIN_ID;
  if (!adminId) return false;
  const review = await store.claimAdminReview(new Date(now).toISOString());
  if (!review) return false;
  try {
    const applicant = await readInvitePrivateObject(
      {
        bucket: env.INVITE_PRIVATE_OBJECTS,
        kek: env.INVITE_PRIVATE_KEK,
        keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
      },
      review.privateRef,
    );
    const text = `가입 신청 검토\n이름: ${escapeSlackText(applicant.displayName)}\n이메일: ${escapeSlackText(applicant.email)}\n참여 의사: ${escapeSlackText(applicant.intent)}\nFree Slack 초대는 운영자가 직접 보낸 뒤 별도로 표시합니다.`;
    await slack.postAdmin({
      adminId,
      effectKey: review.effectKey,
      requestId: review.requestId,
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "actions",
          elements: [
            button("승인", "community_invite_approve", review.requestId, review.revision),
            button("거절", "community_invite_decline", review.requestId, review.revision),
            button("중복", "community_invite_duplicate", review.requestId, review.revision),
            button(
              "악용 의심",
              "community_invite_suspected_abuse",
              review.requestId,
              review.revision,
            ),
          ],
        },
      ],
    });
    await store.finishOutbox({
      outboxId: review.outboxId,
      status: "sent",
      now: new Date(now).toISOString(),
    });
    return true;
  } catch (error) {
    await store.finishOutbox({
      outboxId: review.outboxId,
      status: "failed",
      now: new Date(now).toISOString(),
    });
    if (error instanceof Error) return false;
    throw error;
  }
}

export async function handleInviteAdminAction(
  input: {
    readonly teamId: string;
    readonly userId: string;
    readonly actionId: string;
    readonly value: string;
    readonly actionTs: string;
  },
  env: InviteAdminEnv,
  store: ReferralRuntimeStore,
  slack?: ReferralSlackPort,
): Promise<boolean> {
  if (!input.actionId.startsWith("community_invite_")) return false;
  if (
    input.teamId !== env.SLACK_TEAM_ID ||
    !env.COMMUNITY_ADMIN_ID ||
    input.userId !== env.COMMUNITY_ADMIN_ID
  )
    throw new InputError("운영자 전용 기능입니다.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new InputError("신청 정보를 확인할 수 없습니다.");
    throw error;
  }
  const value = actionValueSchema.safeParse(decoded);
  if (!value.success || !/^\d{10}\.\d{1,6}$/.test(input.actionTs))
    throw new InputError("신청 정보를 확인할 수 없습니다.");
  const base = {
    teamId: input.teamId,
    adminId: input.userId,
    requestId: value.data.requestId,
    expectedRevision: value.data.revision,
    key: `slack:${input.actionTs}:${input.actionId}`,
    now: new Date(Number(input.actionTs) * 1_000).toISOString(),
  };
  if (input.actionId === "community_invite_mark_invited") {
    await store.markInvited(base);
    return true;
  }
  const decision = decisionFromAction(input.actionId);
  if (!decision) throw new InputError("지원하지 않는 신청 처리입니다.");
  const result = await store.decide({ ...base, decision });
  if (decision === "approved" && slack) {
    const text =
      "승인했습니다. Free Slack 초대를 직접 보낸 뒤 ‘수동 초대 표시’를 눌러 주세요. 이 표시는 전달 증명이 아닙니다.";
    await slack.postAdmin({
      adminId: input.userId,
      effectKey: `approved:${value.data.requestId}:${result.revision}`,
      requestId: value.data.requestId,
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "actions",
          elements: [
            button(
              "수동 초대 표시",
              "community_invite_mark_invited",
              value.data.requestId,
              result.revision,
            ),
          ],
        },
      ],
    });
  }
  return true;
}
