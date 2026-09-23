import { handleCommunityAction } from "./community-action-interactions";
import { parseBugAnswerActionId } from "./community-bug-actions";
import { armCommunityClock } from "./community-clock";
import { handleInterestInteraction } from "./community-interest-interactions";
import { handleInviteAdminAction } from "./community-invite-admin";
import { parseLifecycleAction } from "./community-lifecycle-interactions";
import { CommunityLifecycleRuntimeStore } from "./community-lifecycle-runtime-store";
import { authorizeCommunityAction } from "./community-permissions";
import { handleReferralLinkMessage } from "./community-referral-link";
import { referralSlackPort } from "./community-referral-slack";
import { CommunityReferralStore } from "./community-referral-store";
import { actionIdentity, type CommunityContext, type CommunityEnv } from "./community-runtime";
import { CommunityStore } from "./community-store";
import { handleCommunityView } from "./community-view-interactions";
import { date, InputError, koreaDate, object, string } from "./input";
import { NeonStore } from "./store";

export async function communityInteraction(
  data: Record<string, unknown>,
  env: CommunityEnv,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response | null> {
  if (env.COMMUNITY_ENABLED !== "true") return null;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const action = actions[0] ? object(actions[0]) : null;
  const view = data.view ? object(data.view) : null;
  const id = string(action?.action_id ?? view?.callback_id ?? "");
  if (data.type === "block_actions" && action && id.startsWith("community_interest_")) {
    await handleInterestInteraction(data, env);
    if (env.COMMUNITY_PUBLIC_CHANNEL_ID)
      waitUntil(armCommunityClock(env, env.COMMUNITY_PUBLIC_CHANNEL_ID));
    return new Response(null, { status: 200 });
  }
  if (data.type === "block_actions" && action && id.startsWith("community_invite_")) {
    if (env.REFERRALS_ENABLED !== "true") throw new InputError("지금은 신청을 처리할 수 없습니다.");
    const teamId = string(object(data.team).id);
    const userId = string(object(data.user).id);
    const dmChannelId = string(object(data.container).channel_id);
    if (!/^D[A-Z0-9]+$/.test(dmChannelId))
      throw new InputError("비공개 관리자 카드에서 처리해 주세요.");
    const store = new CommunityReferralStore(new NeonStore(env.DATABASE_URL), {
      teamId: env.SLACK_TEAM_ID,
      channelId: env.COMMUNITY_PUBLIC_CHANNEL_ID ?? "",
      userId: env.COMMUNITY_ADMIN_ID ?? "",
    });
    await handleInviteAdminAction(
      {
        teamId,
        userId,
        actionId: id,
        value: string(action.value),
        actionTs: string(action.action_ts),
      },
      env,
      store,
      referralSlackPort(env),
    );
    if (env.COMMUNITY_PUBLIC_CHANNEL_ID)
      waitUntil(armCommunityClock(env, env.COMMUNITY_PUBLIC_CHANNEL_ID));
    return new Response(null, { status: 200 });
  }
  if (data.type === "block_actions" && action && id === "community_referral_link") {
    const scope = actionIdentity(data, env, id);
    authorizeCommunityAction(id, scope, env);
    const value = object(JSON.parse(string(action.value)));
    if (string(value.ownerId) !== "actor" || string(value.key) !== "referral_link")
      throw new InputError("이 동작은 사용할 수 없습니다.");
    const slack = referralSlackPort(env);
    waitUntil(
      (async () => {
        if (env.REFERRALS_ENABLED !== "true") {
          await slack.postEphemeral({
            channelId: scope.channelId,
            userId: scope.userId,
            text: "지금은 초대 링크를 사용할 수 없어요. 운영자에게 문의해 주세요.",
          });
          return;
        }
        const store = new CommunityReferralStore(new NeonStore(env.DATABASE_URL), {
          teamId: env.SLACK_TEAM_ID,
          channelId: env.COMMUNITY_PUBLIC_CHANNEL_ID ?? "",
          userId: env.COMMUNITY_ADMIN_ID ?? "",
        });
        await handleReferralLinkMessage(
          {
            teamId: scope.teamId,
            channelId: scope.channelId,
            userId: scope.userId,
            text: "내 초대 링크",
          },
          env,
          store,
          slack,
        );
      })().catch(async (error: unknown) => {
        console.error(
          JSON.stringify({
            event: "community.referral_link.failed",
            type: error instanceof Error ? error.name : "Unknown",
          }),
        );
        try {
          await slack.postEphemeral({
            channelId: scope.channelId,
            userId: scope.userId,
            text: "초대 링크를 확인하지 못했어요. 잠시 후 다시 눌러 주세요.",
          });
        } catch (replyError: unknown) {
          console.error(
            JSON.stringify({
              event: "community.referral_link.failure_notice_failed",
              type: replyError instanceof Error ? replyError.name : "Unknown",
            }),
          );
        }
      }),
    );
    return new Response(null, { status: 200 });
  }
  if (data.type === "block_actions" && action && id.startsWith("lifecycle_")) {
    if (env.LIFECYCLE_MODE !== "enforce" || !env.LIFECYCLE_ACTION_SECRET)
      throw new InputError("지금은 생애주기 동작을 처리할 수 없습니다.");
    const teamId = string(object(data.team).id);
    const actorId = string(object(data.user).id);
    const dmChannelId = string(object(data.container).channel_id);
    if (!/^D[A-Z0-9]+$/.test(dmChannelId))
      throw new InputError("비공개 생애주기 안내에서 처리해 주세요.");
    const binding = await parseLifecycleAction(
      string(action.value),
      actorId,
      env.COMMUNITY_ADMIN_ID,
      env.LIFECYCLE_ACTION_SECRET,
    );
    if (
      binding.actionId !== id ||
      binding.teamId !== teamId ||
      teamId !== env.SLACK_TEAM_ID ||
      ![env.COMMUNITY_PUBLIC_CHANNEL_ID, env.COMMUNITY_CHANNEL_ID].includes(binding.channelId)
    )
      throw new InputError("이 동작은 사용할 수 없습니다.");
    if (binding.actionId === "lifecycle_restore_error")
      throw new InputError("증거가 있는 관리자 정정 요청이 필요합니다.");
    const actionTs = string(action.action_ts);
    if (!/^\d{10}\.\d{1,6}$/.test(actionTs))
      throw new InputError("동작 시각을 확인할 수 없습니다.");
    await new CommunityLifecycleRuntimeStore(new NeonStore(env.DATABASE_URL)).action(
      binding,
      new Date(Number(actionTs) * 1_000).toISOString(),
    );
    return new Response(null, { status: 200 });
  }
  if (!id.startsWith("community_")) return null;
  const bugAnswerAction = parseBugAnswerActionId(id);
  if (!bugAnswerAction && (id === "community_bug_answer" || id.startsWith("community_bug_answer:")))
    throw new InputError("지원하지 않는 동작입니다.");
  const routedId = bugAnswerAction ? "community_bug_answer" : id;
  const scope = actionIdentity(data, env, routedId);
  authorizeCommunityAction(routedId, scope, env);
  if (
    (data.type === "view_submission") !== id.endsWith("_submit") ||
    !["view_submission", "block_actions"].includes(string(data.type))
  )
    throw new InputError("지원하지 않는 요청 형식입니다.");
  if (id === "community_guide_open") return new Response(null, { status: 200 });
  const metadata = view ? object(JSON.parse(string(view.private_metadata))) : null;
  if (metadata && metadata.userId !== scope.userId)
    throw new InputError("본인이 연 화면에서 다시 시도해 주세요.");
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  const message = data.message ? object(data.message) : null;
  const container = data.container ? object(data.container) : null;
  const source = metadata ? string(metadata.source) : string(message?.ts ?? container?.message_ts);
  const thread = metadata
    ? string(metadata.thread)
    : string(message?.thread_ts ?? container?.thread_ts ?? message?.ts ?? container?.message_ts);
  const context: CommunityContext = {
    env,
    scope,
    store,
    source,
    thread,
    date: metadata ? date(metadata.date) : koreaDate(Date.now() / 1000),
    key: `interaction:${action?.action_ts ?? view?.id}`,
  };
  if (view) {
    if (!metadata) throw new InputError("화면 정보를 확인할 수 없어요.");
    return handleCommunityView({
      id,
      view,
      metadata,
      context,
      store,
      scope,
      env,
      thread,
      waitUntil,
    });
  }
  if (!action) throw new InputError("동작 정보를 확인할 수 없어요.");
  return handleCommunityAction({
    id,
    action,
    data,
    scope,
    context,
    bugAnswerAction,
    waitUntil,
  });
}
