import { slackCanvasId, slackCanvasUrl } from "./community-canvas";
import type { CommunityEnv } from "./community-runtime";
import { callSlack } from "./community-social";
import type { MemberIntroduction } from "./community-types";

type IntroductionCanvasEnv = Pick<
  CommunityEnv,
  "SLACK_BOT_TOKEN" | "COMMUNITY_INTRO_CANVAS_ID" | "COMMUNITY_INTRO_CANVAS_URL"
>;

function escapeCanvasText(value: string): string {
  return value.replace(/[\\*_~[\]#>]/g, "\\$&");
}

export function introductionCanvasUrl(env: IntroductionCanvasEnv): string {
  return slackCanvasUrl(env.COMMUNITY_INTRO_CANVAS_URL);
}

export function introductionCanvasMarkdown(entries: readonly MemberIntroduction[]): string {
  const sections = entries.map((entry) => {
    const heading = `## ${entry.confirmedName ? escapeCanvasText(entry.confirmedName) : "이름 확인 중"}`;
    const links = [
      ...(entry.linkedin ? [`[LinkedIn](${entry.linkedin})`] : []),
      ...(entry.details ? [escapeCanvasText(entry.details)] : []),
    ];
    return `${heading}\n\n${escapeCanvasText(entry.intro)}${links.length ? `\n\n${links.join(" · ")}` : ""}`;
  });
  return `현재 ${entries.length}명의 공개 자기소개입니다. 각 소개는 본인이 Slack에서 직접 수정할 수 있습니다.${sections.length ? `\n\n---\n\n${sections.join("\n\n---\n\n")}` : "\n\n아직 등록된 자기소개가 없습니다."}`;
}

export async function syncIntroductionCanvas(
  entries: readonly MemberIntroduction[],
  env: IntroductionCanvasEnv,
): Promise<void> {
  await callSlack(env.SLACK_BOT_TOKEN, "canvases.edit", {
    canvas_id: slackCanvasId(env.COMMUNITY_INTRO_CANVAS_ID),
    changes: [
      {
        operation: "replace",
        document_content: { type: "markdown", markdown: introductionCanvasMarkdown(entries) },
      },
    ],
  });
}
