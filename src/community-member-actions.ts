import { introductionButton } from "./community-introduction";
import type { Json } from "./input";

export function inviteButton(): Json {
  return {
    type: "button",
    text: { type: "plain_text", text: "친구 초대하기" },
    action_id: "community_referral_link",
    value: JSON.stringify({ ownerId: "actor", key: "referral_link" }),
    accessibility_label: "내 초대 링크 받기",
  };
}

export function memberActionBlock(): Json {
  return { type: "actions", elements: [introductionButton(), inviteButton()] };
}
