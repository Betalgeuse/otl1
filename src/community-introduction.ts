import { escapeSlackText } from "./community-messages";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { callSlack } from "./community-social";
import type { MemberIntroduction } from "./community-types";
import { InputError, type Json, object, string } from "./input";
import { openView } from "./slack-api";

export type IntroductionInput = {
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

function isSingleSentence(value: string): boolean {
  if (!value || [...value].length > 180 || /[\r\n]/.test(value)) return false;
  const boundaries = value.match(/[.!?…。！？]+/g) ?? [];
  return boundaries.length === 0 || (boundaries.length === 1 && /[.!?…。！？]+\s*$/.test(value));
}

export function parseIntroduction(valuesInput: unknown): IntroductionParseResult {
  const values = object(valuesInput);
  const intro = string(object(object(values.intro).value).value).trim();
  const rawLinkedIn = string(object(object(values.linkedin).value).value ?? "").trim();
  const details = string(object(object(values.details).value).value ?? "").trim();
  const errors: Record<string, string> = {};
  if (!isSingleSentence(intro))
    errors.intro = "자기소개는 줄바꿈 없이 한 문장, 180자 이내로 적어 주세요.";
  const linkedin = canonicalLinkedIn(rawLinkedIn);
  if (rawLinkedIn && !linkedin)
    errors.linkedin =
      "본인 LinkedIn 프로필 주소를 https://linkedin.com/in/... 형식으로 입력해 주세요.";
  if ([...details].length > 300 || /[\r\n]/.test(details))
    errors.details = "추가 공개 정보는 줄바꿈 없이 300자 이내로 적어 주세요.";
  return Object.keys(errors).length ? { errors } : { intro, linkedin, details: details || null };
}

function targetChannel(context: CommunityContext): string {
  const channelId = string(context.env.COMMUNITY_INTRO_CHANNEL_ID);
  if (!channelId) throw new InputError("자기소개 채널 설정이 필요합니다.");
  return channelId;
}

export async function introductionModal(
  context: CommunityContext,
  triggerId: string,
): Promise<void> {
  const existing = await context.store.introduction(context.scope.teamId, context.scope.userId);
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
            text: "한 문장 소개와 아래 선택 정보는 공개 채널에 올라가요.",
          },
        },
        {
          type: "input",
          block_id: "intro",
          label: { type: "plain_text", text: "요즘 어떤 일에 마음을 쓰고 있나요?" },
          hint: {
            type: "plain_text",
            text: "하는 일, 배우는 것, 같이 이야기하고 싶은 것 중 하나를 한 문장으로 적어 주세요.",
          },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: false,
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

function publicText(userId: string, parsed: IntroductionInput): string {
  return `<@${userId}>\n${escapeSlackText(parsed.intro)}${parsed.linkedin ? `\nLinkedIn: <${parsed.linkedin}|프로필 보기>` : ""}${parsed.details ? `\n더 보기: ${escapeSlackText(parsed.details)}` : ""}`;
}

export async function submitIntroduction(
  context: CommunityContext,
  viewId: string,
  parsed: IntroductionParseResult,
  expectedRevision: number,
): Promise<void> {
  if ("errors" in parsed) return;
  const teamId = context.scope.teamId;
  const userId = context.scope.userId;
  const channelId = targetChannel(context);
  const prepared = await context.store.prepareIntroduction({
    teamId,
    userId,
    intro: parsed.intro,
    linkedin: parsed.linkedin,
    details: parsed.details,
    expectedRevision,
    token: viewId,
  });
  if (!prepared) {
    await ephemeral(context, {
      text: "자기소개가 먼저 바뀌었어요. 다시 열어 최신 내용을 확인해 주세요.",
    });
    return;
  }
  try {
    const payload = {
      channel: channelId,
      text: publicText(userId, parsed),
      unfurl_links: false,
      unfurl_media: false,
    };
    const sent = prepared.messageTs
      ? await callSlack(context.env.SLACK_BOT_TOKEN, "chat.update", {
          ...payload,
          ts: prepared.messageTs,
        })
      : await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", payload);
    const result = await context.store.finishIntroduction({
      teamId,
      userId,
      token: viewId,
      channelId,
      messageTs: string(sent.ts),
    });
    if (!result) throw new InputError("자기소개 저장 결과를 확인할 수 없어요.");
    await ephemeral(context, {
      text: prepared.messageTs ? "자기소개를 수정했어요." : "자기소개를 올렸어요.",
    });
  } catch (error) {
    await context.store.abortIntroduction(teamId, userId, viewId);
    await ephemeral(context, {
      text: "자기소개 게시 결과를 확인하지 못했어요. 다시 시도해 주세요.",
    });
    console.error(
      JSON.stringify({
        event: "community.introduction.failed",
        type: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
}

export function introductionButton(userId = "actor", label = "자기소개 남기기"): Json {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: "community_introduction",
    value: JSON.stringify({ ownerId: userId, key: "self-introduction" }),
  };
}

export function introductionDirectoryButton(): Json {
  return {
    type: "button",
    text: { type: "plain_text", text: "모두 보기" },
    action_id: "community_introduction_directory",
    value: JSON.stringify({ ownerId: "actor", key: "introduction-directory" }),
  };
}

export function introductionLine(entry: MemberIntroduction): string {
  return `<@${entry.userId}> ${escapeSlackText(entry.intro)}${entry.linkedin ? ` · <${entry.linkedin}|LinkedIn>` : ""}${entry.details ? ` · ${escapeSlackText(entry.details)}` : ""}`;
}
