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
  "community_live_schedule",
]);
const memberActions = new Set([
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
]);

export function authorizeCommunityAction(
  id: string,
  scope: CommunityScope,
  env: CommunityEnv,
): void {
  if (adminActions.has(id)) requireCommunityAdmin(scope, env);
  else if (!memberActions.has(id)) throw new InputError("지원하지 않는 동작입니다.");
}
