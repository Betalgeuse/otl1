import { adminCommand, captureFeedback } from "./community-admin";
import { groupCard, settingsCard } from "./community-controls";
import { messageDate } from "./community-followup";
import { classifyCommunityIntent } from "./community-language";
import { communityConfirmationMessage } from "./community-messages";
import { answerCommunityQuestion } from "./community-questions";
import { applyChange, confirmChange, publishStatus } from "./community-records";
import {
  type CommunityContext,
  type CommunityEnv,
  post,
  scopedValue,
  textReply,
} from "./community-runtime";
import { CommunityStore } from "./community-store";
import type { DayChange } from "./community-types";
import { welcomeTownhallMember } from "./community-welcome";
import { InputError, koreaDate, object, string } from "./input";
import { NeonStore } from "./store";

export async function handleCommunityEvent(
  data: Record<string, unknown>,
  env: CommunityEnv,
): Promise<boolean> {
  if (
    env.COMMUNITY_ENABLED !== "true" ||
    data.type !== "event_callback" ||
    data.team_id !== env.SLACK_TEAM_ID
  )
    return false;
  const event = object(data.event);
  if (await welcomeTownhallMember(event, env)) return true;
  if (
    ![
      env.COMMUNITY_CHANNEL_ID,
      env.COMMUNITY_PUBLIC_CHANNEL_ID,
      env.COMMUNITY_RELEASE_CHANNEL_ID,
    ].includes(string(event.channel))
  )
    return false;
  if (
    event.type !== "message" ||
    event.bot_id ||
    (event.subtype !== undefined && event.subtype !== "thread_broadcast")
  )
    return true;
  const userId = string(event.user);
  if (
    !/^[UW][A-Z0-9]+$/.test(userId) ||
    (event.channel === env.COMMUNITY_CHANNEL_ID && userId !== env.COMMUNITY_ADMIN_ID)
  )
    return true;
  const source = string(event.ts);
  const stamp = Number(source);
  if (!Number.isFinite(stamp) || Math.abs(Date.now() / 1000 - stamp) > 300) return true;
  const rawText = string(event.text);
  const text = (
    env.COMMUNITY_BOT_USER_ID ? rawText.split(`<@${env.COMMUNITY_BOT_USER_ID}>`).join("") : rawText
  ).trim();
  if (!text) return true;
  const scope = { teamId: env.SLACK_TEAM_ID, channelId: string(event.channel), userId };
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  const key = `incoming:${source}`;
  const thread = string(event.thread_ts ?? event.ts);
  const date = await messageDate(store, scope, string(env.COMMUNITY_ADMIN_ID), source, thread);
  const context = { env, store, scope, key, thread, source, date };
  await store.putRecord({ ...scope, key, kind: "incoming", body: { date, thread } });
  if (!(await store.claimRecord({ ...scope, key }))) return true;
  try {
    await processMessage(
      context,
      text,
      Boolean(env.COMMUNITY_BOT_USER_ID && rawText.includes(`<@${env.COMMUNITY_BOT_USER_ID}>`)),
    );
    await store.finishRecord({ ...scope, key }, "sent");
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "community.event.failed",
        type: error instanceof Error ? error.name : "Unknown",
      }),
    );
    await store.finishRecord({ ...scope, key }, "failed");
    await textReply(
      context,
      error instanceof InputError
        ? error.message
        : "처리 결과를 확인하지 못했어요. “내 상태”로 기록을 먼저 확인해 주세요.",
    );
  }
  return true;
}

async function processMessage(
  context: CommunityContext,
  text: string,
  addressed: boolean,
): Promise<void> {
  if (await captureFeedback(context, text)) return;
  if (
    context.scope.channelId === context.env.COMMUNITY_RELEASE_CHANNEL_ID &&
    ![context.env.COMMUNITY_CHANNEL_ID, context.env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(
      context.scope.channelId,
    )
  )
    return;
  if (await adminCommand(context, text)) return;
  if (/^(개인 )?알림 ?설정$/.test(text)) {
    await settingsCard(context);
    return;
  }
  if (/^(공통 알림|공통 안내) ?설정$/.test(text)) {
    if (context.scope.userId !== context.env.COMMUNITY_ADMIN_ID) {
      await textReply(context, "공통 안내는 운영자만 설정할 수 있어요.");
      return;
    }
    await groupCard(context);
    return;
  }
  if (/^샤라웃( 보내기)?$/.test(text)) {
    await post(
      context,
      communityConfirmationMessage("오늘 원씽을 함께한 동료에게 한마디!!! 🙌", [
        {
          label: "샤라웃 보내기",
          actionId: "community_shoutout",
          value: scopedValue(context.scope, context.date),
        },
      ]),
    );
    return;
  }
  if (await answerCommunityQuestion(context, text, addressed)) return;
  const day = await context.store.day({ ...context.scope, date: context.date });
  if (/^(내 상태|원씽 보기|상태 보기)$/.test(text)) {
    await publishStatus(context, day, null);
    return;
  }
  if (text.length > 1000) {
    await textReply(
      context,
      "내용이 길어요. 원씽은 200자, 후기는 이 대화에서 1,000자 이내로 알려주세요.",
    );
    return;
  }
  if (!context.env.AI) {
    await textReply(context, "자연어 연결을 사용할 수 없어요. 잠시 후 다시 알려주세요.");
    return;
  }
  const allowed = await context.env.INTENT_RATE_LIMITER?.limit({
    key: `community:${context.scope.userId}`,
  });
  if (allowed && !allowed.success) {
    await textReply(context, "잠시 후 다시 알려주세요. 기록은 바꾸지 않았어요.");
    return;
  }
  const intent = await classifyCommunityIntent(context.env.AI, { goal: day.goal || null, text });
  const base = {
    ...context.scope,
    date: context.date,
    key: `change:${context.source}`,
    expectedRevision: day.revision,
  };
  switch (intent.intent) {
    case "ignore":
      return;
    case "unclear":
      await confirmChange(context, day, text, day.goal ? "complete" : "goal");
      return;
    case "goal": {
      const goal = intent.goalText ?? text;
      if (intent.needsConfirmation || context.date !== koreaDate(Date.now() / 1000) || day.goal) {
        await confirmChange(context, day, goal, "goal");
        return;
      }
      await applyChange(context, { ...base, action: "goal", text: goal });
      return;
    }
    case "rest":
      if (intent.needsConfirmation || context.date !== koreaDate(Date.now() / 1000)) {
        await confirmChange(context, day, text, "rest");
        return;
      }
      await applyChange(context, { ...base, action: "rest" });
      return;
    case "completion":
    case "reflection": {
      if (
        intent.needsConfirmation ||
        !day.goal ||
        intent.outcome === "unknown" ||
        context.date !== koreaDate(Date.now() / 1000)
      ) {
        await confirmChange(
          context,
          day,
          text,
          intent.intent === "reflection" ? "reflection" : "complete",
        );
        return;
      }
      const outcome = intent.outcome;
      const change: DayChange =
        intent.intent === "reflection"
          ? { ...base, action: "reflection", text, outcome }
          : { ...base, action: outcome };
      await applyChange(context, change);
      return;
    }
    default:
      return exhaustive(intent.intent);
  }
}
function exhaustive(value: never): never {
  throw new TypeError(String(value));
}
