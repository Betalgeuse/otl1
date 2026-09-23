import { unresolvedDays } from "./community-followup";
import type { CommunityContext } from "./community-runtime";
import type { CommunityDay, DayChange } from "./community-types";
import { date, InputError, koreaDate, object, string } from "./input";
import { openView } from "./slack-api";

export type PastReviewBinding = {
  readonly date: string;
  readonly revision: number;
};

export type PastReviewInput = PastReviewBinding & {
  readonly outcome: "complete" | "partial" | "not_done";
  readonly reflection: string;
};

export function pastReviewBinding(value: Record<string, unknown>): PastReviewBinding {
  const targetDate = date(value.date);
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new InputError("지난 기록의 버전을 확인할 수 없어요.");
  return { date: targetDate, revision };
}

function reviewable(day: CommunityDay, binding: PastReviewBinding): boolean {
  return (
    day.date === binding.date &&
    day.revision === binding.revision &&
    Boolean(day.goal.trim()) &&
    !day.resting &&
    (day.outcome === "pending" || !day.reflection.trim())
  );
}

export async function openPastReviewModal(
  context: CommunityContext,
  triggerId: string,
  binding: PastReviewBinding,
): Promise<void> {
  const day = await context.store.day({ ...context.scope, date: binding.date });
  if (!reviewable(day, binding))
    throw new InputError("이미 정리됐거나 그 뒤에 바뀐 기록이에요. 현재 상태를 확인해 주세요.");
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
      callback_id: "community_past_review_submit",
      title: { type: "plain_text", text: "밀린 후기 기록하기" },
      submit: { type: "plain_text", text: "기록하기" },
      close: { type: "plain_text", text: "닫기" },
      private_metadata: JSON.stringify({
        userId: context.scope.userId,
        channelId: context.scope.channelId,
        source: context.source,
        thread: context.thread,
        date: day.date,
        revision: day.revision,
      }),
      blocks: [
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
        {
          type: "input",
          block_id: "reflection",
          label: { type: "plain_text", text: "짧게 돌아봐요" },
          hint: {
            type: "plain_text",
            text: "해낸 것, 막힌 점, 다음에 이어갈 한 가지를 편하게 적어 주세요.",
          },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            max_length: 2000,
            ...(day.reflection.trim() ? { initial_value: day.reflection } : {}),
            placeholder: { type: "plain_text", text: "막상 시작하니 생각보다 빨리 끝났다." },
          },
        },
      ],
    },
  });
}

export async function openPastReviewPickerModal(
  context: CommunityContext,
  triggerId: string,
): Promise<void> {
  const missing = unresolvedDays(
    await context.store.history(context.scope),
    koreaDate(Date.now() / 1000),
  ).slice(0, 10);
  if (!missing.length) throw new InputError("지금 정리할 이전 ONE THING이 없어요.");
  await openView(context.env.SLACK_BOT_TOKEN, {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "community_past_review_submit",
      title: { type: "plain_text", text: "밀린 후기 기록하기" },
      submit: { type: "plain_text", text: "기록하기" },
      close: { type: "plain_text", text: "닫기" },
      private_metadata: JSON.stringify({
        userId: context.scope.userId,
        channelId: context.scope.channelId,
        source: context.source,
        thread: context.thread,
      }),
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "아직 완료 상태나 후기가 빠진 날짜를 골라 한 번에 정리할 수 있어요.",
          },
        },
        {
          type: "input",
          block_id: "date",
          label: { type: "plain_text", text: "어느 ONE THING인가요?" },
          element: {
            type: "static_select",
            action_id: "value",
            options: missing.map((day) => ({
              text: {
                type: "plain_text",
                text: `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))} · ${day.goal.replace(/\s+/g, " ")}`.slice(
                  0,
                  75,
                ),
              },
              value: JSON.stringify({ date: day.date, revision: day.revision }),
            })),
          },
        },
        {
          type: "input",
          block_id: "outcome",
          label: { type: "plain_text", text: "어디까지 했나요?" },
          element: {
            type: "static_select",
            action_id: "value",
            options: [
              { text: { type: "plain_text", text: "완료했어요" }, value: "complete" },
              { text: { type: "plain_text", text: "일부 진행했어요" }, value: "partial" },
              { text: { type: "plain_text", text: "못 했어요" }, value: "not_done" },
            ],
          },
        },
        {
          type: "input",
          block_id: "reflection",
          label: { type: "plain_text", text: "짧게 돌아봐요" },
          hint: {
            type: "plain_text",
            text: "해낸 것, 막힌 점, 다음에 이어갈 한 가지를 편하게 적어 주세요.",
          },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            max_length: 2000,
            placeholder: { type: "plain_text", text: "막상 시작하니 생각보다 빨리 끝났다." },
          },
        },
      ],
    },
  });
}

export function parsePastReviewSubmission(
  viewInput: unknown,
): PastReviewInput | { readonly errors: Record<string, string> } {
  const view = object(viewInput);
  const metadata = object(JSON.parse(string(view.private_metadata)));
  const values = object(object(view.state).values);
  const selected = string(object(object(object(values.outcome).value).selected_option).value);
  const reflection = string(object(object(values.reflection).value).value).trim();
  const errors: Record<string, string> = {};
  if (!reflection || [...reflection].length > 2000)
    errors.reflection = "후기는 1~2000자로 적어 주세요.";
  if (!["complete", "partial", "not_done"].includes(selected))
    errors.outcome = "완료 상태를 골라 주세요.";
  if (Object.keys(errors).length) return { errors };
  const selectedDate = values.date
    ? object(object(object(values.date).value).selected_option).value
    : undefined;
  const binding = pastReviewBinding(
    selectedDate === undefined ? metadata : object(JSON.parse(string(selectedDate))),
  );
  const outcome = selected === "complete" || selected === "partial" ? selected : "not_done";
  return { ...binding, outcome, reflection };
}

export function pastReviewChange(context: CommunityContext, input: PastReviewInput): DayChange {
  return {
    ...context.scope,
    date: input.date,
    key: `change:${context.key}`,
    expectedRevision: input.revision,
    action: "reflection",
    text: input.reflection,
    outcome: input.outcome,
  };
}
