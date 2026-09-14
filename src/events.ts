import { InputError, type Json, object, string } from "./input";
import { boardMessage } from "./messages";
import type { Store } from "./store";

type EventEnv = {
  readonly SLACK_BOT_TOKEN: string;
  readonly SLACK_TEAM_ID: string;
  readonly DAILY_SCRUM_CHANNEL_ID: string;
};
type EventContext = { readonly today: string; readonly timestamp: number };

const seen = new Set<string>();

export function eventPayload(body: string): Record<string, unknown> {
  const data = object(JSON.parse(body));
  if (data.type === "url_verification") return data;
  if (data.type !== "event_callback") throw new Error("Unsupported Slack event");
  const eventId = string(data.event_id);
  if (seen.has(eventId)) return { type: "duplicate" };
  seen.add(eventId);
  if (seen.size > 2048) seen.delete(seen.values().next().value as string);
  return data;
}

export async function handleMention(
  data: Record<string, unknown>,
  env: EventEnv,
  context: EventContext,
): Promise<void> {
  if (data.type === "duplicate") return;
  if (data.type === "url_verification") return;
  if (string(data.team_id) !== env.SLACK_TEAM_ID) return;
  const event = object(data.event);
  if (event.bot_id !== undefined || event.subtype !== undefined) return;
  if (event.type !== "app_mention" && event.type !== "message") return;
  const text = string(event.text)
    .replace(/<@[A-Z0-9]+>/g, "")
    .trim();
  const channel = string(event.channel);
  if (event.type === "message" && channel !== env.DAILY_SCRUM_CHANNEL_ID) return;
  const user = string(event.user);
  const candidate =
    event.type === "app_mention" || /(^|\s)(오늘|원씽|할\s*일|목표)(\s|은|을|이|:|$)/.test(text);
  const reply =
    text.length > 0 && candidate && !/(\s|^)(도와|뭐|무엇|어떻게|왜)(\s|$)/.test(text)
      ? `오늘의 ONE THING 초안으로 등록할까요?\n“${text.slice(0, 200)}”`
      : "오늘의 ONE THING을 한 가지 문장으로 적어 주세요. 예: 책 10쪽 읽기";
  const blocks: readonly Json[] =
    text.length > 0
      ? [
          { type: "section", text: { type: "mrkdwn", text: reply } },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "nl_confirm",
                text: { type: "plain_text", text: "등록" },
                style: "primary",
                value: JSON.stringify({
                  teamId: env.SLACK_TEAM_ID,
                  userId: user,
                  channel,
                  date: context.today,
                  text: text.slice(0, 200),
                  eventTime: context.timestamp,
                }),
              },
              {
                type: "button",
                action_id: "nl_cancel",
                text: { type: "plain_text", text: "취소" },
                value: "cancel",
              },
            ],
          },
        ]
      : [];
  await slackPost(env.SLACK_BOT_TOKEN, {
    channel,
    thread_ts: string(event.ts),
    text: reply,
    blocks,
  });
}

export function verificationResponse(data: Record<string, unknown>): Response | null {
  return data.type === "url_verification"
    ? Response.json({ challenge: string(data.challenge) })
    : null;
}

async function slackPost(token: string, payload: Json): Promise<void> {
  const bodyPayload =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? Object.fromEntries(
          Object.entries(payload).filter(
            ([key]) => key !== "response_type" && key !== "replace_original",
          ),
        )
      : payload;
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(bodyPayload),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
  const data = object(await response.json());
  if (data.ok !== true) throw new Error(`Slack rejected message: ${string(data.error)}`);
}

export async function confirmMention(
  token: string,
  payload: Record<string, unknown>,
  store: Store,
  baseUrl: string,
  boardSecret: string,
  today: string,
): Promise<void> {
  let phase: "database" | "board-post" | "reaction" = "database";
  const actions = payload.actions;
  const action = Array.isArray(actions) && actions[0] !== undefined ? object(actions[0]) : payload;
  const value = object(JSON.parse(string(action.value)));
  if (
    string(object(payload.team).id) !== string(value.teamId) ||
    string(object(payload.user).id) !== string(value.userId) ||
    string(object(payload.container).channel_id) !== string(value.channel)
  )
    throw new InputError("본인 채널의 초안만 등록할 수 있어요.");
  const snapshot = await store.execute({
    teamId: string(value.teamId),
    userId: string(value.userId),
    today,
    action: "write",
    date: string(value.date),
    text: string(value.text),
    palette: { empty: "#EBEDF0", written: "#9BE9A8", complete: "#216E39" },
    eventTime: Number(value.eventTime),
  });
  phase = "board-post";
  const board = object(
    await boardMessage(snapshot, {
      today,
      anchor: string(value.date),
      ownerId: string(value.userId),
      replace: false,
      sharedBy: string(value.userId),
      link: { baseUrl, secret: boardSecret, today },
    }),
  );
  await slackPost(token, { ...board, channel: string(value.channel) });
  try {
    phase = "reaction";
    const container = object(payload.container);
    const message = object(payload.message);
    await addReaction(token, string(container.channel_id ?? value.channel), string(message.ts));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "registration.reaction.failed",
        phase,
        errorType: error instanceof Error ? error.name : "Unknown",
        errorMessage: error instanceof Error ? error.message : "Unknown",
      }),
    );
  }
}

async function addReaction(token: string, channel: string, timestamp: string): Promise<void> {
  const response = await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, timestamp, name: "white_check_mark" }),
    redirect: "manual",
    signal: AbortSignal.timeout(3000),
  });
  const data = object(await response.json());
  if (!response.ok || (data.ok !== true && data.error !== "already_reacted"))
    throw new Error("Slack reaction rejected");
}
