import { publishRelease, releasePreview } from "./community-admin";
import { armCommunityClock } from "./community-clock";
import { openSettings, openShoutout, readSettings, stopSettings } from "./community-controls";
import { enablePublicSchedule } from "./community-cutover";
import { confirmedRecordEdit } from "./community-edits";
import { introductionModal, parseIntroduction, submitIntroduction } from "./community-introduction";
import { escapeSlackText } from "./community-messages";
import { openCommunityPalette, submitCommunityPalette } from "./community-palette";
import { authorizeCommunityAction } from "./community-permissions";
import { applyChange, publishStatus, undoChange } from "./community-records";
import {
  actionIdentity,
  type CommunityContext,
  type CommunityEnv,
  ephemeral,
  post,
  textReply,
} from "./community-runtime";
import { runCommunitySchedule } from "./community-scheduler";
import { CommunityStore } from "./community-store";
import type { DayChange } from "./community-types";
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
  const scope = actionIdentity(data, env, id);
  authorizeCommunityAction(id, scope, env);
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
    if (id === "community_introduction_submit") {
      const parsed = parseIntroduction(object(view.state).values);
      if ("errors" in parsed)
        return Response.json({ response_action: "errors", errors: parsed.errors });
      waitUntil(submitIntroduction(context, string(view.id), parsed));
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
  if (id !== "community_shoutout" && ownerId !== scope.userId)
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
  waitUntil(
    processAction(context, id, key).catch(async (error: unknown) => {
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

async function processAction(context: CommunityContext, id: string, key: string): Promise<void> {
  if (id === "community_live_schedule") {
    await enablePublicSchedule(context);
    return;
  }
  if (id === "community_undo") {
    await undoChange(context, key);
    return;
  }
  if (id === "community_stop") {
    await stopSettings(context);
    return;
  }
  if (id === "community_status") {
    const day = await context.store.day({ ...context.scope, date: date(key) });
    await publishStatus(context, day, null);
    return;
  }
  if (id === "community_release_preview") {
    await releasePreview(context, key);
    return;
  }
  if (id === "community_publish") {
    await publishRelease(context, key, context.key);
    return;
  }
  if (id === "community_test_schedule" || id === "community_test_group") {
    let goalTime: string;
    let reviewTime: string;
    if (id === "community_test_group") {
      const record = await context.store.getRecord({ ...context.scope, key: "group-schedule" });
      if (!record) {
        await textReply(context, "공통 안내를 먼저 설정해 주세요.");
        return;
      }
      const data = object(record.body);
      goalTime = string(data.goalTime);
      reviewTime = string(data.reviewTime);
    } else {
      const p = await context.store.preferences(context.scope);
      goalTime = p.goalTime;
      reviewTime = p.reviewTime;
    }
    for (const time of new Set([goalTime, reviewTime]))
      await runCommunitySchedule(
        {
          ...context.env,
          COMMUNITY_CHANNEL_ID: context.scope.channelId,
          COMMUNITY_ADMIN_ID: string(context.env.COMMUNITY_ADMIN_ID),
        },
        context.store,
        new Date(`${context.date}T${time}:00+09:00`),
      );
    await textReply(
      context,
      "설정 시각으로 검사했어요. 실제 예약 조건을 사용한 QA 시간 테스트이며 이미 보낸 알림은 다시 보내지 않아요.",
    );
    return;
  }
  const pending = await context.store.getRecord({ ...context.scope, key });
  if (pending?.kind !== "pending") throw new InputError("확인할 요청이 없어요.");
  const data = object(pending.body);
  const action = string(data.action);
  const selected = id.replace("community_", "");
  if (!["confirm", "complete", "partial", "not_done", "rest", "reflection"].includes(selected))
    throw new InputError("지원하지 않는 동작입니다.");
  if (!(await context.store.claimRecord({ ...context.scope, key }))) {
    await ephemeral(context, { text: "이미 처리한 선택이에요." });
    return;
  }
  const targetDate = date(data.date);
  const revision = Number(data.revision);
  if (!Number.isSafeInteger(revision)) throw new InputError("기록 버전을 확인할 수 없어요.");
  const appliedContext = {
    ...context,
    date: targetDate,
    source: string(data.source),
    thread: string(data.thread),
  };
  const base = { ...context.scope, date: targetDate, key, expectedRevision: revision };
  let change: DayChange;
  if (selected === "confirm" && action === "edit") change = confirmedRecordEdit(base, data);
  else if (selected === "confirm" && action === "goal")
    change = { ...base, action: "goal", text: string(data.text) };
  else if (selected === "rest") change = { ...base, action: "rest" };
  else if (selected === "reflection")
    change = { ...base, action: "reflection", text: string(data.text) };
  else if (selected === "complete" || selected === "partial" || selected === "not_done")
    change =
      action === "reflection"
        ? { ...base, action: "reflection", text: string(data.text), outcome: selected }
        : { ...base, action: selected };
  else throw new InputError("선택 내용을 확인해 주세요.");
  await applyChange(appliedContext, change);
  await context.store.finishRecord({ ...context.scope, key }, "sent");
}
