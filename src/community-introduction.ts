import { slackCanvasUrl } from "./community-canvas";
import { randomCustomEmoji } from "./community-emoji";
import { syncIntroductionCanvas } from "./community-introduction-canvas";
import type { IntroductionInput, IntroductionParseResult } from "./community-introduction-form";

export type { IntroductionInput, IntroductionParseResult } from "./community-introduction-form";
export { introductionModal, parseIntroduction } from "./community-introduction-form";

import { escapeSlackText } from "./community-messages";
import { type CommunityContext, type CommunityEnv, ephemeral } from "./community-runtime";
import { addReactions, callSlack } from "./community-social";
import type { MemberIntroduction } from "./community-types";
import { InputError, type Json, string } from "./input";

function targetChannel(context: CommunityContext): string {
  const channelId = string(context.env.COMMUNITY_INTRO_CHANNEL_ID);
  if (!channelId) throw new InputError("자기소개 채널 설정이 필요합니다.");
  return channelId;
}

function publicText(userId: string, parsed: IntroductionInput): string {
  return `<@${userId}> · ${escapeSlackText(parsed.confirmedName)}\n${escapeSlackText(parsed.intro)}${parsed.linkedin ? `\nLinkedIn: <${parsed.linkedin}|프로필 보기>` : ""}${parsed.details ? `\n더 보기: ${escapeSlackText(parsed.details)}` : ""}`;
}

export function introductionActionBlock(
  env?: Pick<CommunityEnv, "COMMUNITY_INTRO_CANVAS_URL">,
): Json {
  return {
    type: "actions",
    elements: [
      introductionButton(undefined, "자기소개 쓰기"),
      introductionDirectoryButton(env?.COMMUNITY_INTRO_CANVAS_URL),
    ],
  };
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
    confirmedName: parsed.confirmedName,
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
  let createdMessageTs: string | null = null;
  try {
    const payload = {
      channel: channelId,
      text: publicText(userId, parsed),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: publicText(userId, parsed) } },
        introductionActionBlock(context.env),
      ],
      unfurl_links: false,
      unfurl_media: false,
    };
    const sent = prepared.messageTs
      ? await callSlack(context.env.SLACK_BOT_TOKEN, "chat.update", {
          ...payload,
          ts: prepared.messageTs,
        })
      : await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", payload);
    const messageTs = string(sent.ts);
    if (!prepared.messageTs) {
      createdMessageTs = messageTs;
      await addReactions(context.env.SLACK_BOT_TOKEN, {
        channel: channelId,
        ts: messageTs,
        names: await randomCustomEmoji(context.env.SLACK_BOT_TOKEN),
      });
    }
    const result = await context.store.finishIntroduction({
      teamId,
      userId,
      token: viewId,
      channelId,
      messageTs,
    });
    if (!result) throw new InputError("자기소개 저장 결과를 확인할 수 없어요.");
    createdMessageTs = null;
    try {
      await syncIntroductionCanvas(await context.store.introductions(teamId), context.env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "community.introduction_canvas.failed",
          type: error instanceof Error ? error.name : "Unknown",
        }),
      );
    }
    await ephemeral(context, {
      text: prepared.messageTs ? "자기소개를 수정했어요." : "자기소개를 올렸어요.",
    });
  } catch (error) {
    let canAbort = createdMessageTs === null;
    if (createdMessageTs)
      try {
        await callSlack(context.env.SLACK_BOT_TOKEN, "chat.delete", {
          channel: channelId,
          ts: createdMessageTs,
        });
        canAbort = true;
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            event: "community.introduction.cleanup_failed",
            phase: "slack",
            type: cleanupError instanceof Error ? cleanupError.name : "Unknown",
          }),
        );
      }
    if (canAbort)
      try {
        await context.store.abortIntroduction(teamId, userId, viewId);
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            event: "community.introduction.cleanup_failed",
            phase: "database",
            type: cleanupError instanceof Error ? cleanupError.name : "Unknown",
          }),
        );
      }
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

export function introductionDirectoryButton(url?: string): Json {
  return {
    type: "button",
    text: { type: "plain_text", text: "자기소개 모두 보기" },
    action_id: "community_introduction_directory",
    value: JSON.stringify({ ownerId: "actor", key: "introduction-directory" }),
    ...(url ? { url: slackCanvasUrl(url) } : {}),
    accessibility_label: "모든 회원의 공개 자기소개 보기",
  };
}

export function introductionLine(entry: MemberIntroduction): string {
  return `<@${entry.userId}>${entry.confirmedName ? ` · ${escapeSlackText(entry.confirmedName)}` : ""} ${escapeSlackText(entry.intro)}${entry.linkedin ? ` · <${entry.linkedin}|LinkedIn>` : ""}${entry.details ? ` · ${escapeSlackText(entry.details)}` : ""}`;
}
