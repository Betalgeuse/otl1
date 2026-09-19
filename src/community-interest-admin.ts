import { escapeSlackText } from "./community-messages";
import type { Json } from "./input";

export type InterestReviewCardInput = {
  readonly interestId: string;
  readonly revision: number;
  readonly email: string;
  readonly displayName: string;
  readonly intent: string;
  readonly knownMemberClue: string;
  readonly shareNameEmailWithIntroducer: boolean;
};

export function interestReviewCard(input: InterestReviewCardInput): {
  readonly channel: "private";
  readonly text: string;
  readonly blocks: readonly Json[];
} {
  const safe = (value: string): string => escapeSlackText(value);
  const text = `소개가 필요한 참여 문의 ${input.interestId}`;
  const details = [
    `*참여 문의* ${input.interestId}`,
    `이름: ${safe(input.displayName)}`,
    `이메일: ${safe(input.email)}`,
    `관심 내용: ${safe(input.intent)}`,
    input.knownMemberClue ? `알고 있는 회원 단서: ${safe(input.knownMemberClue)}` : "",
    input.shareNameEmailWithIntroducer
      ? "신청자가 소개자에게 이름과 이메일 공유에 동의했습니다."
      : "소개자에게 이름과 이메일 공유 동의가 없습니다. 검증 가능한 오프라인 증거만 사용하세요.",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    channel: "private",
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: details } },
      ...(input.shareNameEmailWithIntroducer
        ? [
            {
              type: "actions",
              elements: [
                {
                  type: "users_select",
                  action_id: `community_interest_request:${input.interestId}:${input.revision}`,
                  placeholder: { type: "plain_text", text: "소개할 기존 회원 선택" },
                },
              ],
            },
          ]
        : []),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "문의 종료" },
            action_id: `community_interest_decline:${input.interestId}:${input.revision}`,
            value: input.interestId,
          },
        ],
      },
    ],
  };
}

export function interestVerifiedCard(input: {
  readonly interestId: string;
  readonly revision: number;
}): {
  readonly text: string;
  readonly blocks: readonly Json[];
} {
  const text = `기존 회원의 소개가 확인됐습니다: ${input.interestId}`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "일반 가입 신청으로 연결" },
            action_id: `community_interest_attach:${input.interestId}:${input.revision}`,
            value: input.interestId,
          },
        ],
      },
    ],
  };
}

export function interestMemberPromptCard(input: {
  readonly teamId: string;
  readonly interestId: string;
  readonly memberId: string;
  readonly revision: number;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly displayName: string;
  readonly email: string;
}): { readonly text: string; readonly blocks: readonly Json[] } {
  const text = `다음 분을 직접 알고 소개할 수 있나요? ${escapeSlackText(input.displayName)} (${escapeSlackText(input.email)})`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "제가 아는 분입니다" },
            action_id: "community_interest_confirm",
            value: JSON.stringify({
              teamId: input.teamId,
              interestId: input.interestId,
              memberId: input.memberId,
              revision: input.revision,
              nonce: input.nonce,
              expiresAt: input.expiresAt,
            }),
          },
        ],
      },
    ],
  };
}
