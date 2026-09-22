import { preparePublicCollectionTest } from "./community-admin-collection";
import { armCommunityClock } from "./community-clock";
import { communityConfirmationMessage } from "./community-messages";
import { isCommunityAdmin, requireCommunityAdmin } from "./community-permissions";
import { type CommunityContext, ephemeral, post, scopedValue } from "./community-runtime";
import { type Json, object, string } from "./input";
import { openView } from "./slack-api";

export async function settingsCard(context: CommunityContext): Promise<void> {
  const prefs = await context.store.preferences(context.scope);
  await ephemeral(
    context,
    communityConfirmationMessage(
      `개인 안내: ${prefs.enabled ? "켜짐" : "꺼짐"}\n*ONE THING* ${prefs.goalTime} · 후기 ${prefs.reviewTime} (한국 시간)`,
      [
        {
          label: "시간·수신 설정",
          actionId: "community_settings",
          value: JSON.stringify({
            ownerId: context.scope.userId,
            key: context.date,
            thread: context.thread,
            source: context.source,
          }),
        },
        {
          label: "알림 중지",
          actionId: "community_stop",
          value: JSON.stringify({
            ownerId: context.scope.userId,
            key: context.date,
            thread: context.thread,
            source: context.source,
          }),
        },
        ...(isCommunityAdmin(context.scope, context.env)
          ? [
              {
                label: "설정 시각으로 QA",
                actionId: "community_test_schedule",
                value: JSON.stringify({
                  ownerId: context.scope.userId,
                  key: context.date,
                  thread: context.thread,
                  source: context.source,
                }),
              },
            ]
          : []),
      ],
      "mrkdwn",
    ),
  );
}
export async function groupCard(context: CommunityContext): Promise<void> {
  requireCommunityAdmin(context.scope, context.env);
  const collectionTest = await preparePublicCollectionTest(context);
  await post(
    context,
    communityConfirmationMessage(
      "공통 *ONE THING*·후기 안내를 우리 봇이 맡습니다. 설정된 채널에만 게시합니다.",
      [
        {
          label: "공통 안내 설정",
          actionId: "community_group_settings",
          value: scopedValue(context.scope, context.date),
        },
        {
          label: "설정 시각으로 QA",
          actionId: "community_test_group",
          value: scopedValue(context.scope, context.date),
        },
        ...(collectionTest ? [collectionTest] : []),
        ...(context.scope.channelId === context.env.COMMUNITY_CHANNEL_ID
          ? [
              {
                label: "ONE THING 채널에 10시·18시 적용",
                actionId: "community_live_schedule",
                value: scopedValue(context.scope, context.date),
              },
            ]
          : []),
      ],
      "mrkdwn",
    ),
  );
}
function field(id: string, label: string, value: string): Json {
  return {
    type: "input",
    block_id: id,
    label: { type: "plain_text", text: label },
    element: { type: "plain_text_input", action_id: "value", initial_value: value, max_length: 5 },
  };
}
export async function openSettings(
  context: CommunityContext,
  triggerId: string,
  group: boolean,
): Promise<void> {
  if (group) requireCommunityAdmin(context.scope, context.env);
  const prefs = await context.store.preferences(context.scope);
  const record = group
    ? await context.store.getRecord({ ...context.scope, key: "group-schedule" })
    : null;
  const data = record ? object(record.body) : {};
  const enabled = group ? data.enabled === true : prefs.enabled;
  const option = { text: { type: "plain_text", text: "안내 받기" }, value: "enabled" };
  await openView(context.env.SLACK_BOT_TOKEN, {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: group ? "community_group_submit" : "community_settings_submit",
      title: { type: "plain_text", text: group ? "공통 안내 설정" : "개인 안내 설정" },
      submit: { type: "plain_text", text: "저장" },
      close: { type: "plain_text", text: "닫기" },
      private_metadata: JSON.stringify({
        userId: context.scope.userId,
        channelId: context.scope.channelId,
        thread: context.thread,
        source: context.source,
        date: context.date,
      }),
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: group
              ? "ONE THING·후기 공통 안내 시각을 설정합니다."
              : "개인 안내는 기본 켜짐(평일 ONE THING 11시·후기 20시)이에요. 종류별 하루 1회이며 주말·대한민국 공휴일·가입 당일·휴식·제출 후에는 재촉하지 않아요. 언제든 끌 수 있고 08:00~21:59 사이로 바꿀 수 있어요.",
          },
        },
        field(
          "goal",
          "ONE THING 시각 (HH:MM)",
          group ? (typeof data.goalTime === "string" ? data.goalTime : "10:00") : prefs.goalTime,
        ),
        field(
          "review",
          "후기 시각 (HH:MM)",
          group
            ? typeof data.reviewTime === "string"
              ? data.reviewTime
              : "18:00"
            : prefs.reviewTime,
        ),
        {
          type: "input",
          block_id: "enabled",
          optional: true,
          label: { type: "plain_text", text: "사용 여부" },
          element: {
            type: "checkboxes",
            action_id: "value",
            options: [option],
            ...(enabled ? { initial_options: [option] } : {}),
          },
        },
      ],
    },
  });
}
export function readSettings(
  view: Record<string, unknown>,
  group = false,
): { goalTime: string; reviewTime: string; enabled: boolean } | { errors: Record<string, string> } {
  const values = object(object(view.state).values);
  const goalTime = string(object(object(values.goal).value).value).trim();
  const reviewTime = string(object(object(values.review).value).value).trim();
  const errors: Record<string, string> = {};
  const pattern = group ? /^([01]\d|2[0-3]):[0-5]\d$/ : /^(0[89]|1\d|2[01]):[0-5]\d$/;
  const errorText = group
    ? "00:00~23:59 한국 시간을 HH:MM으로 입력해 주세요."
    : "08:00~21:59 한국 시간을 HH:MM으로 입력해 주세요.";
  if (!pattern.test(goalTime)) errors.goal = errorText;
  if (!pattern.test(reviewTime)) errors.review = errorText;
  if (Object.keys(errors).length) return { errors };
  const selected = object(object(values.enabled).value).selected_options;
  return {
    goalTime,
    reviewTime,
    enabled: Array.isArray(selected) && selected.some((v) => object(v).value === "enabled"),
  };
}
export async function stopSettings(context: CommunityContext): Promise<void> {
  await context.store.preferences(context.scope, { enabled: false });
  await armCommunityClock(context.env, context.scope.channelId);
  await ephemeral(context, {
    text: "개인 안내를 껐어요. 대기 중인 *ONE THING*·후기 알림도 멈췄습니다. ☕",
  });
}

export async function openShoutout(
  context: CommunityContext,
  triggerId: string,
  target: string | null,
): Promise<void> {
  await openView(context.env.SLACK_BOT_TOKEN, {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "community_shoutout_submit",
      title: { type: "plain_text", text: "동료에게 샤라웃" },
      submit: { type: "plain_text", text: "응원 보내기" },
      close: { type: "plain_text", text: "닫기" },
      private_metadata: JSON.stringify({
        userId: context.scope.userId,
        channelId: context.scope.channelId,
        thread: context.thread,
        source: context.source,
        date: context.date,
      }),
      blocks: [
        {
          type: "input",
          block_id: "target",
          label: { type: "plain_text", text: "누구에게 보내나요?" },
          element: {
            type: "users_select",
            action_id: "value",
            ...(target ? { initial_user: target } : {}),
          },
        },
        {
          type: "input",
          block_id: "message",
          label: { type: "plain_text", text: "어떤 ONE THING이나 도움을 응원하나요?" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            max_length: 500,
            placeholder: { type: "plain_text", text: "읽기로 한 논문 끝낸 거 멋져요!!! 🐧🙌" },
          },
        },
      ],
    },
  });
}
