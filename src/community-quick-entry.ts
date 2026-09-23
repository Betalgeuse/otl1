import { escapeSlackText } from "./community-messages";
import { applyChange } from "./community-records";
import { type CommunityContext, post } from "./community-runtime";
import type { Outcome } from "./community-types";
import { date, InputError, type Json, object, string } from "./input";
import { openView } from "./slack-api";

type QuickEntryKind = "goal" | "review";

type QuickEntryBinding = {
  readonly date: string;
  readonly revision: number;
  readonly text: string;
};

type QuickEntryInput =
  | (QuickEntryBinding & { readonly kind: "goal"; readonly reason: string })
  | (QuickEntryBinding & {
      readonly kind: "review";
      readonly outcome: Exclude<Outcome, "pending">;
    });

function metadata(input: Record<string, unknown>): {
  readonly kind: QuickEntryKind;
  readonly date: string;
  readonly revision: number;
} {
  const kind = string(input.kind);
  const revision = input.revision;
  if (
    !["goal", "review"].includes(kind) ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new InputError("빠른 기록 정보를 확인할 수 없어요.");
  return { kind: kind === "goal" ? "goal" : "review", date: date(input.date), revision };
}

function textInput(kind: QuickEntryKind, initialValue: string): Json {
  return {
    type: "input",
    block_id: "text",
    label: {
      type: "plain_text",
      text: kind === "goal" ? "오늘 가장 중요한 업무 하나" : "짧게 돌아봐요",
    },
    ...(kind === "review"
      ? {
          hint: {
            type: "plain_text",
            text: "해낸 것, 막힌 점, 다음에 이어갈 한 가지를 편하게 적어 주세요.",
          },
        }
      : {}),
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      max_length: kind === "goal" ? 200 : 2000,
      ...(initialValue ? { initial_value: initialValue } : {}),
      placeholder: {
        type: "plain_text",
        text:
          kind === "goal"
            ? "예: 발표 자료 1~5쪽 초안을 완성해 동료에게 공유하기"
            : "예: 개념 층위를 나눠 정리하니 다음 작업이 분명해졌다.",
      },
    },
  };
}

function reasonInput(): Json {
  return {
    type: "input",
    block_id: "reason",
    label: { type: "plain_text", text: "왜 중요한가요?" },
    hint: {
      type: "plain_text",
      text: "이걸 해내면 무엇이 더 쉬워지거나 필요 없어지는지 적어 주세요.",
    },
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: true,
      max_length: 500,
      placeholder: {
        type: "plain_text",
        text: "예: 다음 의사결정에 필요한 근거를 오늘 확보해야 해서",
      },
    },
  };
}

export async function openQuickEntryModal(
  context: CommunityContext,
  triggerId: string,
  kind: QuickEntryKind,
): Promise<void> {
  const day = await context.store.day({ ...context.scope, date: context.date });
  if (kind === "review" && !day.goal.trim())
    throw new InputError("오늘 ONE THING을 먼저 기록해 주세요.");
  const options = [
    { text: { type: "plain_text", text: "완료했어요" }, value: "complete" },
    { text: { type: "plain_text", text: "일부 진행했어요" }, value: "partial" },
    { text: { type: "plain_text", text: "못 했어요" }, value: "not_done" },
  ];
  const initial = options.find((option) => option.value === day.outcome);
  await openView(context.env.SLACK_BOT_TOKEN, {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id:
        kind === "goal" ? "community_quick_goal_submit" : "community_quick_review_submit",
      title: { type: "plain_text", text: kind === "goal" ? "ONE THING 기록하기" : "후기 남기기" },
      submit: { type: "plain_text", text: kind === "goal" ? "기록하기" : "후기 남기기" },
      close: { type: "plain_text", text: "닫기" },
      private_metadata: JSON.stringify({
        userId: context.scope.userId,
        channelId: context.scope.channelId,
        source: context.source,
        thread: context.thread,
        date: day.date,
        revision: day.revision,
        kind,
      }),
      blocks: [
        ...(kind === "review"
          ? [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*${day.date} ONE THING*\n${day.goal}`.slice(0, 2900),
                },
              },
              {
                type: "input",
                block_id: "outcome",
                label: { type: "plain_text", text: "어디까지 했나요?" },
                element: {
                  type: "static_select",
                  action_id: "value",
                  options,
                  ...(initial ? { initial_option: initial } : {}),
                },
              },
            ]
          : []),
        textInput(kind, kind === "goal" ? day.goal : day.reflection),
        ...(kind === "goal" ? [reasonInput()] : []),
      ],
    },
  });
}

export function parseQuickEntrySubmission(
  viewInput: unknown,
): QuickEntryInput | { readonly errors: Record<string, string> } {
  const view = object(viewInput);
  const binding = metadata(object(JSON.parse(string(view.private_metadata))));
  const values = object(object(view.state).values);
  const text = string(object(object(values.text).value).value).trim();
  const errors: Record<string, string> = {};
  const limit = binding.kind === "goal" ? 200 : 2000;
  if (!text || [...text].length > limit)
    errors.text =
      binding.kind === "goal"
        ? "ONE THING은 1~200자로 적어 주세요."
        : "후기는 1~2000자로 적어 주세요.";
  if (binding.kind === "goal") {
    const reason = string(object(object(values.reason).value).value).trim();
    if (!reason || [...reason].length > 500) errors.reason = "중요한 이유를 1~500자로 적어 주세요.";
    return Object.keys(errors).length
      ? { errors }
      : { kind: "goal", date: binding.date, revision: binding.revision, text, reason };
  }
  const selected = string(object(object(object(values.outcome).value).selected_option).value);
  if (!["complete", "partial", "not_done"].includes(selected))
    errors.outcome = "완료 상태를 골라 주세요.";
  if (Object.keys(errors).length) return { errors };
  const outcome = selected === "complete" || selected === "partial" ? selected : "not_done";
  return {
    kind: "review",
    date: binding.date,
    revision: binding.revision,
    text,
    outcome,
  };
}

export async function submitQuickEntry(
  context: CommunityContext,
  viewId: string,
  input: QuickEntryInput,
): Promise<void> {
  const current = await context.store.day({ ...context.scope, date: input.date });
  if (current.revision !== input.revision)
    throw new InputError("그 사이 기록이 바뀌었어요. 다시 열어 주세요.");
  if (input.kind === "review" && !current.goal.trim())
    throw new InputError("오늘 ONE THING과 완료 상태를 확인해 주세요.");
  const label =
    input.kind === "review"
      ? input.outcome === "complete"
        ? "완료"
        : input.outcome === "partial"
          ? "일부 진행"
          : "미완료"
      : "";
  const messageTs = await post(
    { ...context, date: input.date },
    {
      text:
        input.kind === "goal"
          ? `<@${context.scope.userId}> · 오늘의 *ONE THING*\n*ONE THING*: ${escapeSlackText(input.text)}\n사유: ${escapeSlackText(input.reason)}`
          : `<@${context.scope.userId}> · ${input.date} *ONE THING* 후기 · ${label}\n${escapeSlackText(input.text)}`,
    },
  );
  const appliedContext = {
    ...context,
    date: input.date,
    source: messageTs,
    key: `quick-entry:${viewId}`,
  };
  await applyChange(
    appliedContext,
    input.kind === "goal"
      ? {
          ...context.scope,
          date: input.date,
          key: `change:${appliedContext.key}`,
          expectedRevision: input.revision,
          action: "goal",
          text: input.text,
          ...(current.goal.trim() ? { preserveOutcome: true } : {}),
        }
      : {
          ...context.scope,
          date: input.date,
          key: `change:${appliedContext.key}`,
          expectedRevision: input.revision,
          action: "reflection",
          text: input.text,
          outcome: input.outcome,
        },
  );
  if (input.kind === "goal")
    await context.store.putRecord({
      ...context.scope,
      key: `goal-reason:${viewId}`,
      kind: "goal_reason",
      body: {
        date: input.date,
        goal: input.text,
        reason: input.reason,
        source: messageTs,
        thread: context.thread,
      },
    });
}
