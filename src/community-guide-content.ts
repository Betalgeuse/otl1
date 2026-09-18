import { InputError } from "./input";

const FILE_ID = /^F[A-Z0-9]+$/;
const SECTION_LIMIT = 2900;

export type WelcomeGuideContent = {
  readonly body: string;
  readonly orderedFileIds: readonly [string, string];
  readonly hash: string;
};

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

export function guideBlocks(userId: string, guide: WelcomeGuideContent) {
  const introduction = `<@${userId}> 어서 오세요!!! 처음 오셨다면 이 안내부터 함께 읽어주세요.\n\n${guide.body}`;
  const sections = Array.from(
    { length: Math.ceil(introduction.length / SECTION_LIMIT) },
    (_, index) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: introduction.slice(index * SECTION_LIMIT, (index + 1) * SECTION_LIMIT),
      },
    }),
  );
  return [
    ...sections,
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
