import { parseBugAnswerActionId } from "./community-bug-actions";
import { handleBugAction, handleBugView } from "./community-bug-interactions";
import { armCommunityClock } from "./community-clock";
import { openSettings, openShoutout, readSettings } from "./community-controls";
import { introductionModal, parseIntroduction, submitIntroduction } from "./community-introduction";
import { showIntroductionDirectory } from "./community-introduction-channel";
import { escapeSlackText } from "./community-messages";
import { openCommunityPalette, submitCommunityPalette } from "./community-palette";
import { authorizeCommunityAction } from "./community-permissions";
import { processRecordAction } from "./community-record-interactions";
import {
  actionIdentity,
  type CommunityContext,
  type CommunityEnv,
  ephemeral,
  post,
} from "./community-runtime";
import { CommunityStore } from "./community-store";
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
  let context: CommunityContext = {
    env,
    scope,
    store,
    source,
    thread,
    date: metadata ? date(metadata.date) : koreaDate(Date.now() / 1000),
    key: `interaction:${action?.action_ts ?? view?.id}`,
  };
  if (view) {
    const bugResponse = await handleBugView(id, view, context, waitUntil);
    if (bugResponse) return bugResponse;
    if (id === "community_introduction_submit") {
      const parsed = parseIntroduction(object(view.state).values);
      if ("errors" in parsed)
        return Response.json({ response_action: "errors", errors: parsed.errors });
      const revision = Number(metadata?.revision);
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new InputError("자기소개 버전을 확인할 수 없어요.");
      waitUntil(submitIntroduction(context, string(view.id), parsed, revision));
      return Response.json({ response_action: "clear" });
    }
    if (id === "community_palette_submit") return submitCommunityPalette(context, view, waitUntil);
    if (id === "community_settings_submit" || id === "community_group_submit") {
      const prefs = readSettings(view, id === "community_group_submit");
      if ("errors" in prefs)
        return Response.json({ response_action: "errors", errors: prefs.errors });
      waitUntil(
        (async () => {
          if (id === "community_group_submit") await store.setGroupSchedule(scope, prefs);
          else await store.preferences(scope, prefs);
          await armCommunityClock(env, scope.channelId);
          await ephemeral(context, {
            text: `설정 저장! ONE THING ${prefs.goalTime} · 후기 ${prefs.reviewTime} · ${prefs.enabled ? "켜짐" : "꺼짐"} (한국 시간)`,
          });
        })(),
      );
      return Response.json({ response_action: "clear" });
    }
    if (id === "community_shoutout_submit") {
      const values = object(object(view.state).values);
      const target = string(object(object(values.target).value).selected_user);
      const text = string(object(object(values.message).value).value).trim();
      if (target === scope.userId)
        return Response.json({
          response_action: "errors",
          errors: { target: "자신 말고 응원할 동료를 골라주세요." },
        });
      if (!/^[UW][A-Z0-9]+$/.test(target) || !text || text.length > 500)
        return Response.json({
          response_action: "errors",
          errors: { message: "응원을 1~500자로 적어 주세요." },
        });
      const eligibleMembers = await store.members(scope.teamId, scope.channelId);
      if (!eligibleMembers.includes(scope.userId) || !eligibleMembers.includes(target))
        return Response.json({
          response_action: "errors",
          errors: { target: "지금 응원할 수 있는 동료를 골라주세요." },
        });
      waitUntil(
        (async () => {
          const key = `shoutout:${view.id}`;
          await store.putRecord({
            ...scope,
            key,
            kind: "shoutout",
            body: { target, text, date: context.date, source: context.source, thread },
          });
          if (!(await store.claimRecord({ ...scope, key }))) return;
          await post(context, {
            text: `<@${scope.userId}> → <@${target}>\n${escapeSlackText(text)}`,
          });
          await store.finishRecord({ ...scope, key }, "sent");
        })(),
      );
      return Response.json({ response_action: "clear" });
    }
    throw new InputError("지원하지 않는 화면입니다.");
  }
  const selected = action?.selected_option ? object(action.selected_option).value : action?.value;
  const value = object(JSON.parse(string(selected)));
  const ownerId = string(value.ownerId);
  const key = string(value.key);
  const resolvedOwnerId = ownerId === "actor" ? scope.userId : ownerId;
  if (
    !["community_shoutout", "community_introduction_directory"].includes(id) &&
    resolvedOwnerId !== scope.userId
  )
    throw new InputError("본인 기록만 변경할 수 있어요.");
  if (value.thread !== undefined || value.source !== undefined) {
    const thread = string(value.thread);
    const source = string(value.source);
    if (!/^\d+\.\d{6}$/.test(thread) || !/^\d+\.\d{6}$/.test(source))
      throw new InputError("기록 위치를 확인할 수 없어요.");
    context = { ...context, thread, source };
  }
  if (id === "community_palette") {
    await openCommunityPalette(context, string(data.trigger_id), key);
    return new Response(null, { status: 200 });
  }
  if (id === "community_settings" || id === "community_group_settings") {
    await openSettings(context, string(data.trigger_id), id === "community_group_settings");
    return new Response(null, { status: 200 });
  }
  if (id === "community_shoutout") {
    await openShoutout(context, string(data.trigger_id), ownerId === scope.userId ? null : ownerId);
    return new Response(null, { status: 200 });
  }
  if (id === "community_introduction") {
    await introductionModal(context, string(data.trigger_id));
    return new Response(null, { status: 200 });
  }
  const bugResponse = await handleBugAction(
    id,
    bugAnswerAction,
    context,
    key,
    value,
    data.trigger_id,
    waitUntil,
  );
  if (bugResponse) return bugResponse;
  if (id === "community_introduction_directory") {
    waitUntil(
      showIntroductionDirectory(context).catch((error: unknown) =>
        console.error(
          JSON.stringify({
            event: "community.introduction_directory.failed",
            type: error instanceof Error ? error.name : "Unknown",
          }),
        ),
      ),
    );
    return new Response(null, { status: 200 });
  }
  waitUntil(
    processRecordAction(context, id, key, value).catch(async (error: unknown) => {
      console.error(
        JSON.stringify({
          event: "community.action.failed",
          type: error instanceof Error ? error.name : "Unknown",
        }),
      );
      await ephemeral(context, {
        text:
          error instanceof InputError
            ? error.message
            : "처리를 확인하지 못했어요. 현재 상태를 확인해 주세요.",
      });
    }),
  );
  return new Response(null, { status: 200 });
}
