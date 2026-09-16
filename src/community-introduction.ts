import { escapeSlackText } from "./community-messages";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { callSlack } from "./community-social";
import { type Json, object, string } from "./input";
import { openView } from "./slack-api";

export type IntroductionInput = {
  readonly intro: string;
  readonly linkedin: string | null;
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
  const intro = string(object(object(values.intro).value).value).trim();
  const rawLinkedIn = string(object(object(values.linkedin).value).value ?? "").trim();
  const errors: Record<string, string> = {};
  if (!intro || [...intro].length > 800) errors.intro = "자기소개를 한 줄 이상 적어 주세요.";
  const linkedin = canonicalLinkedIn(rawLinkedIn);
  if (rawLinkedIn && !linkedin)
    errors.linkedin =
      "본인 LinkedIn 프로필 주소를 https://linkedin.com/in/... 형식으로 입력해 주세요.";
  return Object.keys(errors).length ? { errors } : { intro, linkedin };
}

function introductionScope(context: CommunityContext) {
  return {
    ...context.scope,
    channelId: string(context.env.COMMUNITY_INTRO_CHANNEL_ID),
  };
}

export async function introductionModal(
  context: CommunityContext,
  triggerId: string,
): Promise<void> {
  const scope = introductionScope(context);
  const existing = await context.store.getRecord({ ...scope, key: "self-introduction" });
  if (existing) {
    await ephemeral(context, {
      text:
        existing.status === "sent"
          ? "자기소개가 이미 올라가 있어요. 수정 기능은 다음 단계에서 열게요."
          : "이전 자기소개 제출 결과를 확인하고 있어요. 운영자에게 알려 주세요.",
    });
    return;
  }
  await openView(context.env.SLACK_BOT_TOKEN, {
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "community_introduction_submit",
      title: { type: "plain_text", text: "자기소개" },
      submit: { type: "plain_text", text: "소개 올리기" },
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
            text: "자기소개와 LinkedIn은 공개 채널에 올라가요. LinkedIn은 선택이에요.",
          },
        },
        {
          type: "input",
          block_id: "intro",
          label: { type: "plain_text", text: "요즘 어떤 일에 마음을 쓰고 있나요?" },
          hint: {
            type: "plain_text",
            text: "요즘 하는 일, 배우거나 만드는 것, 같이 이야기하고 싶은 것 중 하나만 적어도 충분해요.",
          },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true,
            max_length: 800,
            placeholder: { type: "plain_text", text: "요즘은 데이터 제품을 만들고 있어요." },
          },
        },
        {
          type: "input",
          block_id: "linkedin",
          optional: true,
          label: { type: "plain_text", text: "LinkedIn (선택)" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            max_length: 300,
            placeholder: { type: "plain_text", text: "https://linkedin.com/in/your-name" },
          },
        },
      ],
    },
  });
}

export async function submitIntroduction(
  context: CommunityContext,
  viewId: string,
  parsed: IntroductionParseResult,
): Promise<void> {
  if ("errors" in parsed) return;
  const scope = introductionScope(context);
  const key = "self-introduction";
  await context.store.putRecord({
    ...scope,
    key,
    kind: "self_introduction",
    body: {
      intro: parsed.intro,
      linkedin: parsed.linkedin,
      sourceChannelId: context.scope.channelId,
      source: context.source,
    },
  });
  if (!(await context.store.claimRecord({ ...scope, key }))) return;
  try {
    const sent = await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: scope.channelId,
      text: `<@${scope.userId}>\n${escapeSlackText(parsed.intro)}${parsed.linkedin ? `\nLinkedIn: <${parsed.linkedin}|프로필 보기>` : ""}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    await context.store.putRecord({
      ...scope,
      key: `self-introduction-delivery:${viewId}`,
      kind: "self_introduction_delivery",
      body: { messageTs: string(sent.ts), source: context.source },
    });
    await context.store.finishRecord({ ...scope, key }, "sent");
  } catch (error) {
    await context.store.finishRecord({ ...scope, key }, "failed");
    throw error;
  }
}

export function introductionButton(userId: string): Json {
  return {
    type: "button",
    text: { type: "plain_text", text: "자기소개 남기기" },
    action_id: "community_introduction",
    value: JSON.stringify({ ownerId: userId, key: "self-introduction" }),
  };
}
