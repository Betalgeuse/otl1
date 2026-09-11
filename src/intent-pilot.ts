import { DEFAULT_PALETTE, koreaDate, object, string } from "./input";
import { classifyIntent, type IntentAI, type Interpretation } from "./intent";
import type { Store } from "./store";

export type PilotEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly SLACK_BOT_TOKEN: string;
  readonly LLM_PILOT_CHANNEL_ID?: string;
  readonly LLM_PILOT_USER_ID?: string;
  readonly AI?: IntentAI;
  readonly INTENT_RATE_LIMITER?: {
    limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
};

export function pilotReply(result: Interpretation): string {
  const suffix = "\n자연어 해석 테스트입니다. 목표·후기·휴식 기록은 변경하지 않았어요.";
  switch (result.intent) {
    case "goal":
      return `오늘 원씽을 등록하려는 뜻으로 이해했어요.${suffix}`;
    case "rest":
      return `오늘은 쉬겠다는 뜻으로 이해했어요.${suffix}`;
    case "ignore":
      return `목표나 수행 상태에 대한 본인 보고로 보지 않았어요.${suffix}`;
    case "unclear":
      return `오늘 원씽을 완료하셨나요? 완료·일부 진행·못함·오늘 쉬기 중 하나로 알려주세요.${suffix}`;
    case "reflection": {
      const labels = {
        complete: "완료",
        partial: "부분 진행",
        not_done: "미수행",
        unknown: "확인 필요",
      };
      return `오늘 원씽을 완료하셨나요? 문장에서는 ‘${labels[result.outcome]}’로 이해했어요.${suffix}`;
    }
    default:
      return exhaustive(result.intent);
  }
}

function exhaustive(value: never): never {
  throw new TypeError(`Unexpected intent: ${String(value)}`);
}

export async function handleIntentPilot(
  data: Record<string, unknown>,
  env: PilotEnv,
  store: Store,
): Promise<boolean> {
  if (data.type !== "event_callback" || data.team_id !== env.SLACK_TEAM_ID) return false;
  const event = object(data.event);
  if (!env.LLM_PILOT_CHANNEL_ID || event.channel !== env.LLM_PILOT_CHANNEL_ID) return false;
  if (!env.AI || !env.INTENT_RATE_LIMITER || event.user !== env.LLM_PILOT_USER_ID) return true;
  if (event.bot_id || (event.subtype !== undefined && event.subtype !== "thread_broadcast"))
    return true;
  // app_mention has a matching message event: consume only message to avoid a second inference.
  if (event.type !== "message") return true;
  const text = string(event.text)
    .replace(/<@[A-Z0-9]+>/g, "")
    .trim();
  if (!text) return true;
  const user = string(event.user);
  const channel = string(event.channel);
  const ts = string(event.ts);
  const anchor = string(event.thread_ts ?? event.ts);
  const day = koreaDate(Number(anchor));
  if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return true;
  let reply: string;
  try {
    const allowed = await env.INTENT_RATE_LIMITER.limit({
      key: `intent:${env.SLACK_TEAM_ID}:${user}`,
    });
    if (!allowed.success) {
      reply =
        "잠시 후 다시 알려주세요. 테스트 호출 횟수 제한에 도달했어요. 기록은 변경하지 않았어요.";
    } else {
      const snapshot = await store.execute({
        teamId: env.SLACK_TEAM_ID,
        userId: user,
        today: koreaDate(Date.now() / 1000),
        action: "get",
        date: day,
        text: "",
        palette: DEFAULT_PALETTE,
        eventTime: Number(ts),
      });
      const goal = snapshot.goals.find((item) => item.date === day)?.text ?? null;
      reply = pilotReply(await classifyIntent(env.AI, { goal, text }));
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "intent.pilot.failed",
        errorType: error instanceof Error ? error.name : "Unknown",
      }),
    );
    reply = "문장을 확인하지 못했어요. 기록은 변경하지 않았어요. 잠시 후 다시 알려주세요.";
  }
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, thread_ts: anchor, text: reply }),
    redirect: "manual",
    signal: AbortSignal.timeout(3000),
  });
  const posted = object(await response.json());
  if (!response.ok || posted.ok !== true) throw new TypeError("Pilot feedback delivery failed");
  return true;
}
