import { randomCustomEmoji } from "./community-emoji";
import { type CommunityContext, post } from "./community-runtime";
import { addReactions } from "./community-social";
import { object, string } from "./input";
import { INTENT_MODEL, type IntentAI } from "./intent";

const SHARE_INFO_KIND = "share_info_ai";
const MAX_TEXT = 4_000;

type ShareInfoResult = {
  readonly summary: string;
  readonly thought: string;
};

function validMessage(event: Record<string, unknown>, channelIds: ReadonlySet<string>): boolean {
  return (
    event.type === "message" &&
    typeof event.channel === "string" &&
    channelIds.has(event.channel) &&
    event.bot_id === undefined &&
    event.subtype === undefined &&
    event.edit_ts === undefined &&
    (event.thread_ts === undefined || event.thread_ts === event.ts)
  );
}

function parseResult(raw: unknown): ShareInfoResult {
  const value = object(raw);
  const summary = string(value.summary).trim();
  const thought = string(value.thought).trim();
  if (!summary || !thought || summary.length > 180 || thought.length > 180)
    throw new TypeError("Invalid Share Info response");
  return { summary, thought };
}

async function summarize(ai: IntentAI, text: string): Promise<ShareInfoResult> {
  const request = {
    messages: [
      {
        role: "system",
        content:
          'Summarize a trusted Korean community information post. Return JSON only: {"summary":"한 줄 요약","thought":"관련 회원·자료·주제로 확장하는 한 줄 생각거리"}. Preserve facts, do not invent names or claims, do not give generic praise, and do not include markdown links. The thought may mention one related topic but must not mention a person unless the input explicitly names them.',
      },
      { role: "user", content: text.slice(0, MAX_TEXT) },
    ],
    stream: false,
    temperature: 0.2,
    max_tokens: 220,
    response_format: { type: "json_object" },
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await Promise.race([
        ai.run(INTENT_MODEL, request),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new TypeError("Share Info deadline exceeded")), 8_000),
        ),
      ]);
      const value = object(raw);
      const content = Array.isArray(value.choices)
        ? object(object(value.choices[0]).message).content
        : value.response;
      return parseResult(JSON.parse(string(content)));
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError instanceof Error ? lastError : new TypeError("Share Info unavailable");
}

export async function handleShareInfoMessage(
  event: Record<string, unknown>,
  context: CommunityContext,
): Promise<boolean> {
  const channelIds = new Set(
    [
      context.env.COMMUNITY_SHAREINFO_CHANNEL_ID,
      ...(context.env.COMMUNITY_CHAPTER_CHANNEL_IDS?.split(",") ?? []),
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  if (!validMessage(event, channelIds)) return false;
  const channelId = string(event.channel);
  const text = string(event.text).trim();
  if (!text || text.length > MAX_TEXT) return true;
  const source = string(event.ts);
  const thread = string(event.thread_ts ?? source);
  const scope = { ...context.scope, channelId };
  const key = `share-info:${source}`;
  const store = context.store;
  await store.putRecord({ ...scope, key, kind: "incoming", body: { source, thread, text } });
  if (!(await store.claimRecord({ ...scope, key }))) return true;
  const names = (await randomCustomEmoji(context.env.SLACK_BOT_TOKEN)).slice(0, 4);
  try {
    if (names.length)
      await addReactions(context.env.SLACK_BOT_TOKEN, { channel: channelId, ts: source, names });
    await post({ ...context, scope, source, thread, key }, { text: "공유해줘서 고마워요!!!" });
    if (!context.env.AI) {
      await store.finishRecord({ ...scope, key }, "sent");
      return true;
    }
    const result = await summarize(context.env.AI, text);
    await post(
      { ...context, scope, source, thread, key },
      { text: `한 줄 요약: ${result.summary}\n생각거리: ${result.thought}` },
    );
    await store.putRecord({
      ...scope,
      key: `${SHARE_INFO_KIND}:${source}`,
      kind: SHARE_INFO_KIND,
      body: result,
    });
    await store.finishRecord({ ...scope, key }, "sent");
  } catch (error) {
    await store.finishRecord({ ...scope, key }, "failed");
    console.error(
      JSON.stringify({
        event: "community.share_info.failed",
        type: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
  return true;
}
