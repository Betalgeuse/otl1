import type { CommunityEnv } from "./community-runtime";
import { InputError } from "./input";

const FILE_ID = /^F[A-Z0-9]+$/;
const SECTION_LIMIT = 2900;

export type WelcomeGuideContent = {
  readonly body: string;
  readonly orderedFileIds: readonly [string, string];
  readonly hash: string;
};

type GuideChannelEnv = Pick<
  CommunityEnv,
  | "COMMUNITY_PUBLIC_CHANNEL_ID"
  | "COMMUNITY_FEEDBACK_CHANNEL_ID"
  | "COMMUNITY_RELEASE_CHANNEL_ID"
  | "COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS"
>;

const GUIDE_CHANNEL_LABELS = [
  "daily-scrum",
  "all-freetalk-qna-feedback",
  "townhall",
  "chapter-developers",
  "chapter-english",
  "chapter-investment",
] as const;

export function renderGuideChannels(body: string, env: GuideChannelEnv): string {
  const channelIds = [
    env.COMMUNITY_PUBLIC_CHANNEL_ID,
    env.COMMUNITY_FEEDBACK_CHANNEL_ID,
    env.COMMUNITY_RELEASE_CHANNEL_ID,
    ...(env.COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS?.split(",").map((id) => id.trim()) ?? []),
  ];
  if (
    channelIds.length !== GUIDE_CHANNEL_LABELS.length ||
    !channelIds.every((id) => typeof id === "string" && /^[CG][A-Z0-9]{8,}$/.test(id)) ||
    new Set(channelIds).size !== GUIDE_CHANNEL_LABELS.length
  )
    throw new InputError("환영 안내 채널 설정을 확인해 주세요.");
  const channels = new Map<string, string>(
    GUIDE_CHANNEL_LABELS.map((label, index) => {
      const id = channelIds[index];
      if (!id) throw new InputError("환영 안내 채널 설정을 확인해 주세요.");
      return [label, id] as const;
    }),
  );
  const seen = new Set<string>();
  const rendered = body.replace(
    /^([ \t]*(?:▪︎|◦)[ \t]*(?:Slack 사용이 어려우면 )?)#(daily-scrum|all-freetalk-qna-feedback|townhall|chapter-developers|chapter-english|chapter-investment)(?=[:에])/gm,
    (_match, prefix: string, label: string) => {
      const id = channels.get(label);
      if (!id) throw new InputError("환영 안내 채널 설정을 확인해 주세요.");
      seen.add(label);
      return `${prefix}<#${id}>`;
    },
  );
  if (seen.size !== GUIDE_CHANNEL_LABELS.length)
    throw new InputError("환영 안내 채널 표기를 확인해 주세요.");
  return rendered;
}

export function parseGuideFileIds(value: string | undefined): readonly [string, string] {
  const ids = value?.split(",").map((id) => id.trim()) ?? [];
  if (ids.length !== 2 || ids[0] === ids[1] || !ids.every((id) => FILE_ID.test(id)))
    throw new InputError("환영 안내 이미지 설정을 확인해 주세요.");
  const first = ids[0];
  const second = ids[1];
  if (!first || !second) throw new InputError("환영 안내 이미지 설정을 확인해 주세요.");
  return [first, second];
}

export function sanitizeGuideBody(body: string): string {
  return body
    .replace(/<!(channel|here|everyone)>/g, "@$1")
    .replace(/<[^>]*>|https?:\/\/\S+|\*?(?:원씽|\b(?:one\s*thing|onthing)\b)\*?/gi, (part) =>
      part.startsWith("<") || /^https?:/i.test(part) ? part : "*ONE THING*",
    );
}

export async function canonicalGuideContent(
  body: string,
  orderedFileIds: readonly [string, string],
): Promise<WelcomeGuideContent> {
  const sanitized = sanitizeGuideBody(body);
  const envelope = JSON.stringify({ version: 1, body: sanitized, orderedFileIds });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(envelope));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { body: sanitized, orderedFileIds, hash };
}

export function guideBlocks(userId: string, guide: WelcomeGuideContent, renderedBody: string) {
  const introduction = `<@${userId}> 어서 오세요!!! 처음 오셨다면 이 안내부터 함께 읽어주세요.\n\n${renderedBody}`;
  const parts: string[] = [];
  let remaining = introduction;
  while (remaining.length > SECTION_LIMIT) {
    const boundary = remaining.lastIndexOf("\n", SECTION_LIMIT);
    if (boundary < 0) throw new InputError("환영 안내 문단이 너무 깁니다.");
    parts.push(remaining.slice(0, boundary + 1));
    remaining = remaining.slice(boundary + 1);
  }
  parts.push(remaining);
  const sections = parts.map((part) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: part,
    },
  }));
  return [
    ...sections,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "친구 초대하기" },
          action_id: "community_referral_link",
          value: JSON.stringify({ ownerId: "actor", key: "referral_link" }),
          accessibility_label: "내 초대 링크 받기",
        },
      ],
    },
    {
      type: "image",
      slack_file: { id: guide.orderedFileIds[0] },
      alt_text: "OT1L 로고",
      title: { type: "plain_text", text: "OT1L" },
    },
    {
      type: "image",
      slack_file: { id: guide.orderedFileIds[1] },
      alt_text: "daily scrum 진행 화면",
      title: { type: "plain_text", text: "매일의 ONE THING" },
    },
  ];
}
