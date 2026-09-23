import { slackCanvasUrl } from "./community-canvas";
import { introductionButton, introductionDirectoryButton } from "./community-introduction";
import type { Json } from "./input";

export type MemberNavigation = {
  readonly guideUrl?: string;
  readonly introductionUrl?: string;
};

export function inviteButton(): Json {
  return {
    type: "button",
    text: { type: "plain_text", text: "친구 초대하기" },
    action_id: "community_referral_link",
    value: JSON.stringify({ ownerId: "actor", key: "referral_link" }),
    accessibility_label: "내 초대 링크 받기",
  };
}

export function memberActionBlocks(
  navigation: MemberNavigation = {},
  targetDate?: string,
): readonly Json[] {
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "ONE THING 기록하기" },
          action_id: "community_quick_goal",
          value: JSON.stringify({ ownerId: "actor", key: "quick-goal", date: targetDate }),
          style: "primary",
          accessibility_label: "오늘의 ONE THING 기록하기",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "후기 남기기" },
          action_id: "community_quick_review",
          value: JSON.stringify({ ownerId: "actor", key: "quick-review", date: targetDate }),
          style: "danger",
          accessibility_label: "오늘의 ONE THING 완료 상태와 후기 남기기",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        ...(navigation.guideUrl
          ? [
              {
                type: "button",
                text: { type: "plain_text", text: "사용설명서 보기" },
                url: slackCanvasUrl(navigation.guideUrl),
                action_id: "community_guide_open",
                accessibility_label: "ONE THING 1 LINE 사용설명서 보기",
              },
            ]
          : []),
        introductionButton(undefined, "자기소개 쓰기"),
        introductionDirectoryButton(navigation.introductionUrl),
        {
          type: "button",
          text: { type: "plain_text", text: "밀린 후기 기록하기" },
          action_id: "community_past_review_list",
          value: JSON.stringify({ ownerId: "actor", key: "past-review-list" }),
          accessibility_label: "완료 상태나 후기가 빠진 이전 ONE THING 기록하기",
        },
        inviteButton(),
      ],
    },
  ];
}
