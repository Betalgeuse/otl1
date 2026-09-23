import type { CommunityEnv } from "./community-runtime";
import type { CommunityScope } from "./community-types";
import { InputError } from "./input";

export function isCommunityAdmin(scope: CommunityScope, env: CommunityEnv): boolean {
  return Boolean(
    env.COMMUNITY_ADMIN_ID &&
      env.COMMUNITY_CHANNEL_ID &&
      env.COMMUNITY_CHANNEL_ID !== env.COMMUNITY_PUBLIC_CHANNEL_ID &&
      env.COMMUNITY_CHANNEL_ID !== env.COMMUNITY_RELEASE_CHANNEL_ID &&
      scope.teamId === env.SLACK_TEAM_ID &&
      scope.userId === env.COMMUNITY_ADMIN_ID &&
      scope.channelId === env.COMMUNITY_CHANNEL_ID,
  );
}

export function requireCommunityAdmin(scope: CommunityScope, env: CommunityEnv): void {
  if (!isCommunityAdmin(scope, env))
    throw new InputError(
      "운영자 전용 기능입니다. 지정된 관리자 계정으로 비공개 관리 채널에서 사용해 주세요.",
    );
}

const adminActions = new Set([
  "community_group_settings",
  "community_group_submit",
  "community_release_preview",
  "community_publish",
  "community_test_schedule",
  "community_test_group",
  "community_test_public_collection",
  "community_live_schedule",
]);
const memberActions = new Set([
  "community_palette",
  "community_palette_submit",
  "community_settings",
  "community_settings_submit",
  "community_shoutout",
  "community_shoutout_submit",
  "community_stop",
  "community_status",
  "community_undo",
  "community_confirm",
  "community_complete",
  "community_partial",
  "community_not_done",
  "community_rest",
  "community_reflection",
  "community_introduction",
  "community_introduction_submit",
  "community_introduction_directory",
  "community_past_review",
  "community_past_review_list",
  "community_past_review_submit",
  "community_quick_goal",
  "community_quick_goal_submit",
  "community_quick_review",
  "community_quick_review_submit",
  "community_guide_open",
  "community_referral_link",
  "community_bug_open",
  "community_bug_submit",
  "community_bug_confirm",
  "community_bug_answer",
]);

export function authorizeCommunityAction(
  id: string,
  scope: CommunityScope,
  env: CommunityEnv,
): void {
  if (adminActions.has(id)) requireCommunityAdmin(scope, env);
  else if (!memberActions.has(id)) throw new InputError("지원하지 않는 동작입니다.");
}
