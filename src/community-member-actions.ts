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

export function memberActionBlock(navigation: MemberNavigation = {}): Json {
  return {
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
      inviteButton(),
    ],
  };
}
