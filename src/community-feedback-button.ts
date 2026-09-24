import type { Json } from "./input";

export function feedbackButton(): Json {
  return {
    type: "button",
    text: { type: "plain_text", text: "피드백 남기기" },
    action_id: "community_bug_open",
    value: JSON.stringify({ ownerId: "actor", key: "new" }),
    accessibility_label: "불편한 점이나 개선 의견 남기기",
  };
}

export function feedbackActionBlock(): Json {
  return { type: "actions", elements: [feedbackButton()] };
}
