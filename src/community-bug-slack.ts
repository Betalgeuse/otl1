import { bugAnswerActionId } from "./community-bug-actions";
import { type BugCandidate, bugCandidate, type ParsedBugReport } from "./community-bug-facts";
import type { BugQuestion, BugPacketFields as DialoguePacketFields } from "./community-bug-schema";
import { escapeSlackText } from "./community-messages";
import type { CommunityContext } from "./community-runtime";
import { callSlack } from "./community-social";
import { InputError, object, string } from "./input";

type ModalResult = ParsedBugReport | { readonly errors: Readonly<Record<string, string>> };

const FIELD_LABELS = {
  actual: "실제 결과",
  expected: "기대 결과",
  steps: "재현 단계",
  location: "발생 위치",
  occurredAt: "발생 시각",
} as const;
const OPTION_LABELS = {
  always: "항상",
  sometimes: "가끔",
  once: "한 번",
  inconvenience: "불편",
  blocked: "진행할 수 없어요",
  wrong_data: "데이터가 잘못됐어요",
  security_privacy: "보안 또는 개인정보",
} as const;

function optionLabel(value: string): string {
  return Object.entries(OPTION_LABELS).find(([key]) => key === value)?.[1] ?? value;
}

export function bugQuestionPayload(
  context: CommunityContext,
  bugId: string,
  questionId: string,
  packetRevision: number,
  question: BugQuestion,
) {
  const identity = {
    type: "context",
    elements: [{ type: "plain_text", text: `버그 키: ${bugId}` }],
  };
  if (question.kind === "free_text")
    return {
      text: escapeSlackText(question.text),
      blocks: [{ type: "section", text: { type: "plain_text", text: question.text } }, identity],
    };
  return {
    text: escapeSlackText(question.text),
    blocks: [
      { type: "section", text: { type: "plain_text", text: question.text } },
      {
        type: "actions",
        elements: question.options.map((option) => ({
          type: "button",
          text: { type: "plain_text", text: optionLabel(option) },
          action_id: bugAnswerActionId(question.field, option),
          value: JSON.stringify({
            ownerId: context.scope.userId,
            key: bugId,
            questionId,
            packetRevision,
            answer: optionLabel(option),
            thread: context.thread,
            source: context.source,
          }),
        })),
      },
      identity,
    ],
  };
}

export function bugConfirmationPayload(
  context: CommunityContext,
  label: string,
  bugId: string,
  revision: number,
  fields: DialoguePacketFields,
) {
  return {
    text: `확인할 버그 초안 ${label}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*실제* ${escapeSlackText(fields.actual)}\n*기대* ${escapeSlackText(fields.expected)}\n*영향* ${escapeSlackText(fields.impact)}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "맞아요" },
            action_id: "community_bug_confirm",
            value: JSON.stringify({ ownerId: context.scope.userId, key: bugId, revision }),
          },
        ],
      },
    ],
  };
}

export function isBugReportMessage(text: string): boolean {
  return text.trim() === "버그 제보" || /^버그\s*:\s*\S.+$/s.test(text.trim());
}

export function bugEntryPayload(context: CommunityContext) {
  return {
    text: "버그 제보를 시작합니다.",
    blocks: [
      { type: "section", text: { type: "plain_text", text: "버그 제보를 시작합니다." } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "버그 제보" },
            action_id: "community_bug_open",
            value: JSON.stringify({
              ownerId: context.scope.userId,
              key: "new",
              thread: context.thread,
              source: context.source,
            }),
          },
        ],
      },
    ],
  };
}

function modalText(values: Record<string, unknown>, field: keyof typeof FIELD_LABELS): string {
  return string(object(object(values[field]).value).value ?? "").trim();
}

export function parseBugReportModal(input: unknown): ModalResult {
  const values = object(input);
  const fields = Object.fromEntries(
    Object.keys(FIELD_LABELS).map((field) => [
      field,
      modalText(values, field as keyof typeof FIELD_LABELS),
    ]),
  );
  const errors: Record<string, string> = {};
  if (!fields.actual) errors.actual = "실제로 관찰한 결과를 적어 주세요.";
  if (fields.actual && fields.actual.length > 1000) errors.actual = "1,000자 이내로 적어 주세요.";
  const steps =
    fields.steps
      ?.split("\n")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  if (fields.steps && steps.length < 2)
    errors.steps = "서로 다른 두 단계 이상을 줄마다 적어 주세요.";
  if (Object.keys(errors).length > 0) return { errors };
  const messages: Array<ParsedBugReport["messages"][number]> = [];
  const candidates: BugCandidate[] = [];
  for (const field of Object.keys(FIELD_LABELS) as readonly (keyof typeof FIELD_LABELS)[]) {
    if (field === "steps" || !fields[field]) continue;
    const id = `form:${field}`;
    messages.push({ id, text: fields[field], at: new Date().toISOString() });
    candidates.push(bugCandidate(field, id, fields[field]));
  }
  for (const [index, value] of steps.entries()) {
    const id = `form:steps:${index}`;
    messages.push({ id, text: value, at: new Date().toISOString() });
    candidates.push({ ...bugCandidate("steps", id, value), value: [value] });
  }
  for (const field of ["frequency", "impact"] as const) {
    const selection = object(object(values[field]).value).selected_option;
    const selected = selection ? string(object(selection).value) : "";
    const quote = OPTION_LABELS[selected as keyof typeof OPTION_LABELS];
    if (!quote) continue;
    const id = `form:${field}`;
    messages.push({ id, text: quote, at: new Date().toISOString() });
    candidates.push({ ...bugCandidate(field, id, quote), value: selected });
  }
  return { messages, candidates };
}

function selectBlock(id: string, label: string, options: readonly (readonly [string, string])[]) {
  return {
    type: "input",
    block_id: id,
    optional: true,
    label: { type: "plain_text", text: label },
    element: {
      type: "static_select",
      action_id: "value",
      options: options.map(([text, value]) => ({ text: { type: "plain_text", text }, value })),
    },
  };
}

export async function openBugReportModal(
  context: CommunityContext,
  triggerId: string,
): Promise<void> {
  if (!triggerId) throw new InputError("버그 제보 화면을 열 수 없어요.");
  const inputs = Object.entries(FIELD_LABELS).map(([blockId, label]) => ({
    type: "input",
    block_id: blockId,
    optional: blockId !== "actual",
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: "value",
      multiline: blockId === "actual" || blockId === "expected" || blockId === "steps",
    },
  }));
  await callSlack(context.env.SLACK_BOT_TOKEN, "views.open", {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "community_bug_submit",
      private_metadata: JSON.stringify({
        channelId: context.scope.channelId,
        userId: context.scope.userId,
        source: context.source,
        thread: context.thread,
        date: context.date,
      }),
      title: { type: "plain_text", text: "버그 제보" },
      submit: { type: "plain_text", text: "초안 만들기" },
      close: { type: "plain_text", text: "취소" },
      blocks: [
        ...inputs,
        selectBlock("frequency", "발생 빈도", [
          ["항상", "always"],
          ["가끔", "sometimes"],
          ["한 번", "once"],
        ]),
        selectBlock("impact", "영향", [
          ["불편", "inconvenience"],
          ["기능 사용 불가", "blocked"],
          ["잘못된 데이터", "wrong_data"],
          ["보안·개인정보", "security_privacy"],
        ]),
      ],
    },
  });
}
