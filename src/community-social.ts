import { type Json, object } from "./input";
import { SlackError } from "./slack-api";

export type SocialKind = "registered" | "complete" | "reflection" | "rest";

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0;
  return value;
}

export function socialReactions(
  userId: string,
  eventKey: string,
  kind: SocialKind,
): readonly string[] {
  const personal = ["penguin", "frog", "octopus", "cat", "hamster"];
  const celebration = ["raised_hands", "clap", "sparkles"];
  const anchors = {
    registered: "seedling",
    complete: "tada",
    reflection: "memo",
    rest: "coffee",
  } as const;
  return [
    anchors[kind],
    personal[hash(userId) % personal.length] ?? "penguin",
    celebration[hash(eventKey) % celebration.length] ?? "raised_hands",
  ];
}

export class CommunitySlackError extends SlackError {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Slack 요청 실패: ${code}`);
  }
}

export function withFeedbackAction(method: string, payload: Json): Record<string, unknown> {
  const value = object(payload);
  if (!["chat.postMessage", "chat.update"].includes(method)) return value;
  const channel = value.channel;
  if (typeof channel !== "string" || !/^[CG][A-Z0-9]+$/.test(channel)) return value;
  const existing = Array.isArray(value.blocks) ? value.blocks : [];
  if (
    existing.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        !Array.isArray(block) &&
        Array.isArray(block.elements) &&
        block.elements.some(
          (element: unknown) =>
            typeof element === "object" &&
            element !== null &&
            !Array.isArray(element) &&
            object(element).action_id === "community_bug_open",
        ),
    )
  )
    return value;
  if (
    typeof value.text === "string" &&
    /버그|제보|접수|피드백|명세 확인|추가 확인|어떤 문제/.test(value.text)
  )
    return value;
  const blocks = [...existing];
  if (!blocks.length && typeof value.text === "string")
    blocks.push({ type: "section", text: { type: "mrkdwn", text: value.text.slice(0, 2900) } });
  if (blocks.length >= 49) return value;
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "피드백 남기기" },
        action_id: "community_bug_open",
        value: JSON.stringify({ ownerId: "actor", key: "new" }),
        accessibility_label: "불편한 점이나 개선 의견 남기기",
      },
    ],
  });
  return { ...value, blocks };
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? Math.min(Math.max(seconds, 1), 3_600) : null;
}

export async function callSlack(
  token: string,
  method: string,
  payload: Json,
): Promise<Record<string, unknown>> {
  if (!/^[a-z]+\.[a-zA-Z]+$/.test(method)) throw new CommunitySlackError("invalid_method");
  let response: Response;
  try {
    const queryLookup = ["conversations.members", "conversations.replies"].includes(method);
    const lookup = ["users.info", "emoji.list"].includes(method) || queryLookup;
    const url = new URL(`https://slack.com/api/${method}`);
    if (method === "users.info") {
      const user = object(payload).user;
      if (typeof user !== "string") throw new CommunitySlackError("invalid_user");
      url.searchParams.set("user", user);
    }
    if (queryLookup)
      for (const [key, value] of Object.entries(object(payload))) {
        if (typeof value !== "string" && typeof value !== "number")
          throw new CommunitySlackError("invalid_query");
        url.searchParams.set(key, String(value));
      }
    response = await fetch(url.toString(), {
      method: lookup ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      ...(lookup ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(6000),
      redirect: "manual",
    });
  } catch (error) {
    if (error instanceof Error) throw new CommunitySlackError("transport_error");
    throw new CommunitySlackError("unknown_transport_error");
  }
  if (!response.ok)
    throw new CommunitySlackError(
      response.status === 429 ? "rate_limited" : `http_${response.status}`,
      retryAfterSeconds(response),
    );
  let data: Record<string, unknown>;
  try {
    data = object(await response.json());
  } catch (error) {
    if (error instanceof Error) throw new CommunitySlackError("invalid_response");
    throw new CommunitySlackError("unknown_response_error");
  }
  if (data.ok !== true) {
    const code =
      typeof data.error === "string" && /^[a-z_]{1,60}$/.test(data.error) ? data.error : "rejected";
    throw new CommunitySlackError(code, retryAfterSeconds(response));
  }
  return data;
}

export type ReactionTarget = {
  readonly channel: string;
  readonly ts: string;
  readonly names: readonly string[];
};

async function changeReactions(
  token: string,
  target: ReactionTarget,
  method: "add" | "remove",
): Promise<readonly string[]> {
  const completed: string[] = [];
  for (const name of new Set(target.names)) {
    try {
      await callSlack(token, `reactions.${method}`, {
        channel: target.channel,
        timestamp: target.ts,
        name,
      });
      completed.push(name);
    } catch (error) {
      if (
        error instanceof CommunitySlackError &&
        error.code === (method === "add" ? "already_reacted" : "no_reaction")
      )
        continue;
      throw error;
    }
  }
  return completed;
}

export function addReactions(token: string, target: ReactionTarget): Promise<readonly string[]> {
  return changeReactions(token, target, "add");
}

export function removeReactions(token: string, target: ReactionTarget): Promise<readonly string[]> {
  return changeReactions(token, target, "remove");
}
