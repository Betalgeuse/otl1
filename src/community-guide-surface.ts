import type { WelcomeGuideContent } from "./community-guide-content";
import { inviteButton } from "./community-member-actions";
import type { CommunityEnv } from "./community-runtime";
import { CommunitySlackError, callSlack } from "./community-social";
import { InputError } from "./input";

type GuideSurfaceEnv = Pick<
  CommunityEnv,
  | "SLACK_BOT_TOKEN"
  | "COMMUNITY_WELCOME_CHANNEL_ID"
  | "COMMUNITY_GUIDE_CANVAS_ID"
  | "COMMUNITY_GUIDE_CANVAS_URL"
  | "COMMUNITY_GUIDE_ANCHOR_TS"
>;

function guideSurface(env: GuideSurfaceEnv) {
  const channel = env.COMMUNITY_WELCOME_CHANNEL_ID;
  const canvasId = env.COMMUNITY_GUIDE_CANVAS_ID;
  const canvasUrl = env.COMMUNITY_GUIDE_CANVAS_URL;
  const anchorTs = env.COMMUNITY_GUIDE_ANCHOR_TS;
  if (
    !channel ||
    !/^[CG][A-Z0-9]{8,}$/.test(channel) ||
    !canvasId ||
    !/^F[A-Z0-9]+$/.test(canvasId) ||
    !canvasUrl ||
    !/^https:\/\/[a-z0-9-]+\.slack\.com\/docs\/[A-Z0-9]+\/[A-Z0-9]+$/.test(canvasUrl) ||
    !anchorTs ||
    !/^\d{10,}\.\d{6}$/.test(anchorTs)
  )
    throw new InputError("고정 사용설명서 설정을 확인해 주세요.");
  return { channel, canvasId, canvasUrl, anchorTs };
}

function linkSection(text: string, canvasUrl: string) {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "사용설명서 보기" },
      url: canvasUrl,
      action_id: "community_guide_open",
    },
  };
}

export function welcomeGuideLink(userId: string, env: GuideSurfaceEnv) {
  const { canvasUrl } = guideSurface(env);
  const text = `<@${userId}> 어서 오세요!!! 시작하기 전에 고정 사용설명서를 확인해 주세요.\n${canvasUrl}`;
  return {
    text,
    blocks: [
      linkSection(
        `<@${userId}> 어서 오세요!!!\n*ONE THING* 작성 방법과 채널 안내는 고정 사용설명서에서 확인해 주세요.`,
        canvasUrl,
      ),
      { type: "actions", elements: [inviteButton()] },
    ],
  };
}

function canvasMarkdown(version: string, renderedBody: string): string {
  const body = renderedBody
    .replace(/^@channel\nOT1L v[^\n]+\n\n/, "")
    .replace(/<#([CG][A-Z0-9]+)>/g, "![](#$1)");
  return `# ONE THING 1 LINE 사용설명서\n\n마지막 업데이트: ${version}\n\n${body}`;
}

export async function syncWelcomeGuideSurface(
  guide: WelcomeGuideContent & { readonly version: string },
  renderedBody: string,
  env: GuideSurfaceEnv,
): Promise<void> {
  const { channel, canvasId, canvasUrl, anchorTs } = guideSurface(env);
  await callSlack(env.SLACK_BOT_TOKEN, "canvases.edit", {
    canvas_id: canvasId,
    changes: [
      {
        operation: "replace",
        document_content: {
          type: "markdown",
          markdown: canvasMarkdown(guide.version, renderedBody),
        },
      },
    ],
  });
  const text = `ONE THING 1 LINE 사용설명서 · ${guide.version}\n${canvasUrl}`;
  await callSlack(env.SLACK_BOT_TOKEN, "chat.update", {
    channel,
    ts: anchorTs,
    text,
    blocks: [
      linkSection(
        `*ONE THING 1 LINE 사용설명서* · ${guide.version}\nSET / DO / REVIEW 흐름과 작성 예시는 이 문서에서 확인해 주세요.`,
        canvasUrl,
      ),
      { type: "actions", elements: [inviteButton()] },
    ],
  });
  try {
    await callSlack(env.SLACK_BOT_TOKEN, "pins.add", { channel, timestamp: anchorTs });
  } catch (error) {
    if (error instanceof CommunitySlackError && error.code === "already_pinned") return;
    throw error;
  }
}
