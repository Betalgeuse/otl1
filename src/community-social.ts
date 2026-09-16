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
  constructor(readonly code: string) {
    super(`Slack 요청 실패: ${code}`);
  }
}

export async function callSlack(
  token: string,
  method: string,
  payload: Json,
): Promise<Record<string, unknown>> {
  if (!/^[a-z]+\.[a-zA-Z]+$/.test(method)) throw new CommunitySlackError("invalid_method");
  let response: Response;
  try {
    const lookup = ["users.info", "emoji.list", "conversations.members"].includes(method);
    const url = new URL(`https://slack.com/api/${method}`);
    if (method === "users.info") {
      const user = object(payload).user;
      if (typeof user !== "string") throw new CommunitySlackError("invalid_user");
      url.searchParams.set("user", user);
    }
    if (method === "conversations.members")
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
  if (!response.ok) throw new CommunitySlackError(`http_${response.status}`);
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
    throw new CommunitySlackError(code);
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
