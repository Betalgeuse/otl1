import type { CommunityContext } from "./community-runtime";
import { object, string } from "./input";
import { openView } from "./slack-api";

export type IntroductionInput = {
  readonly confirmedName: string;
  readonly intro: string;
  readonly linkedin: string | null;
  readonly details: string | null;
};

export type IntroductionParseResult =
  | IntroductionInput
  | { readonly errors: Record<string, string> };

function canonicalLinkedIn(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !(url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) ||
      !/^\/in\/[^/]+\/?$/i.test(url.pathname)
    )
      return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function parseIntroduction(valuesInput: unknown): IntroductionParseResult {
  const values = object(valuesInput);
  const confirmedName = string(object(object(values.confirmed_name).value).value).trim();
  const intro = string(object(object(values.intro).value).value).trim();
  const rawLinkedIn = string(object(object(values.linkedin).value).value ?? "").trim();
  const details = string(object(object(values.details).value).value ?? "").trim();
  const errors: Record<string, string> = {};
  if (!confirmedName || [...confirmedName].length > 40 || /[\r\n]/.test(confirmedName))
    errors.confirmed_name = "본명은 1~40자로 적어 주세요.";
  if (!intro || [...intro].length > 180) errors.intro = "자기소개는 1~180자로 적어 주세요.";
  const linkedin = canonicalLinkedIn(rawLinkedIn);
  if (rawLinkedIn && !linkedin)
    errors.linkedin =
      "본인 LinkedIn 프로필 주소를 https://linkedin.com/in/... 형식으로 입력해 주세요.";
  if ([...details].length > 300 || /[\r\n]/.test(details))
    errors.details = "추가 공개 정보는 줄바꿈 없이 300자 이내로 적어 주세요.";
  return Object.keys(errors).length
    ? { errors }
    : { confirmedName, intro, linkedin, details: details || null };
}

export async function introductionModal(
  context: CommunityContext,
  triggerId: string,
): Promise<void> {
  const existing = await context.store.introduction(context.scope.teamId, context.scope.userId);
  const nameInput = await context.store.introductionNameInput(
    context.scope.teamId,
    context.scope.userId,
  );
  const editing = existing !== null;
  await openView(context.env.SLACK_BOT_TOKEN, {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "community_introduction_submit",
      title: { type: "plain_text", text: editing ? "자기소개 수정" : "자기소개" },
      submit: { type: "plain_text", text: editing ? "수정하기" : "소개 올리기" },
      close: { type: "plain_text", text: "닫기" },
      private_metadata: JSON.stringify({
        userId: context.scope.userId,
        channelId: context.scope.channelId,
        thread: context.thread,
        source: context.source,
        date: context.date,
        revision: existing?.revision ?? 0,
      }),
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "본명과 자기소개는 공개 채널에 올라가고, 본명은 내 초대 페이지에도 보여요. 아래 연결 정보는 선택이에요.",
          },
        },
        {
          type: "input",
          block_id: "confirmed_name",
          label: { type: "plain_text", text: "본명" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            max_length: 40,
            ...(nameInput ? { initial_value: nameInput } : {}),
            placeholder: { type: "plain_text", text: "이름을 적어 주세요" },
          },
        },
        {
          type: "input",
          block_id: "intro",
          label: { type: "plain_text", text: "요즘 어떤 일에 마음을 쓰고 있나요?" },
          hint: {
            type: "plain_text",
            text: "하는 일, 배우는 것, 같이 이야기하고 싶은 것을 자유롭게 적어 주세요.",
          },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            max_length: 180,
            ...(existing?.intro ? { initial_value: existing.intro } : {}),
            placeholder: { type: "plain_text", text: "데이터 제품을 만들고 있어요." },
          },
        },
        {
          type: "input",
          block_id: "details",
          optional: true,
          label: { type: "plain_text", text: "웹사이트·기타 공개 정보" },
          hint: {
            type: "plain_text",
            text: "공개해도 되는 웹사이트, GitHub, 포트폴리오 등을 한 줄로 적어 주세요.",
          },
          element: {
            type: "plain_text_input",
            action_id: "value",
            max_length: 300,
            ...(existing?.details ? { initial_value: existing.details } : {}),
            placeholder: { type: "plain_text", text: "https://example.com · @github" },
          },
        },
        {
          type: "input",
          block_id: "linkedin",
          optional: true,
          label: { type: "plain_text", text: "LinkedIn" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            max_length: 300,
            ...(existing?.linkedin ? { initial_value: existing.linkedin } : {}),
            placeholder: { type: "plain_text", text: "https://linkedin.com/in/your-name" },
          },
        },
      ],
    },
  });
}
