import { parseBugIntakeCandidate } from "./community-bug-intent";
import { digestBugText } from "./community-bug-private";
import { replayBugDelivery } from "./community-bugs";
import { enrollReminderMember } from "./community-enrollment";
import { messageDate } from "./community-followup";
import { deliverWelcomeGuide } from "./community-guide";
import { incomingMessageBody } from "./community-intake";
import { handleIntroductionChannelMessage } from "./community-introduction-channel";
import { dispatchCommunityMessage, dispatchFeedbackBugMessage } from "./community-message-router";
import { type CommunityEnv, textReply } from "./community-runtime";
import { CommunityStore } from "./community-store";
import { welcomeTownhallMember } from "./community-welcome";
import { InputError, object, string } from "./input";
import { messageEvent } from "./slack-message-event";
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
  const event = messageEvent(object(data.event));
  if (await deliverWelcomeGuide(event, env)) return true;
  if (await handleIntroductionChannelMessage(event, env)) return true;
  await enrollReminderMember(event, env);
  if (await welcomeTownhallMember(event, env)) return true;
  if (
    ![
      env.COMMUNITY_CHANNEL_ID,
      env.COMMUNITY_PUBLIC_CHANNEL_ID,
      env.COMMUNITY_RELEASE_CHANNEL_ID,
      env.COMMUNITY_FEEDBACK_CHANNEL_ID,
    ].includes(string(event.channel))
  )
    return false;
  const isFeedbackChannel = event.channel === env.COMMUNITY_FEEDBACK_CHANNEL_ID;
  if (
    !["message", ...(isFeedbackChannel ? ["app_mention"] : [])].includes(string(event.type)) ||
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
  const stamp = Number(event.edit_ts ?? source);
  if (!Number.isFinite(stamp) || Math.abs(Date.now() / 1000 - stamp) > 300) return true;
  const rawText = string(event.text);
  const text = (
    env.COMMUNITY_BOT_USER_ID ? rawText.split(`<@${env.COMMUNITY_BOT_USER_ID}>`).join("") : rawText
  ).trim();
  if (!text) return true;
  const scope = { teamId: env.SLACK_TEAM_ID, channelId: string(event.channel), userId };
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  const key = `incoming:${source}${event.edit_ts ? `:edit:${string(event.edit_ts)}` : ""}`;
  const thread = string(event.thread_ts ?? event.ts);
  const date = await messageDate(store, scope, string(env.COMMUNITY_ADMIN_ID), source, thread);
  const context = { env, store, scope, key, thread, source, date };
  const bugCandidate = parseBugIntakeCandidate(
    text,
    [env.COMMUNITY_CHANNEL_ID, env.COMMUNITY_FEEDBACK_CHANNEL_ID].includes(scope.channelId),
  );
  if (isFeedbackChannel && !bugCandidate && thread === source) return true;
  const feedbackBugInput = isFeedbackChannel && (bugCandidate !== null || thread !== source);
  await store.putRecord({
    ...scope,
    key,
    kind: "incoming",
    body: incomingMessageBody(
      {
        date,
        thread,
        rawText,
        normalizedText: text,
        editTs: event.edit_ts ? string(event.edit_ts) : null,
      },
      bugCandidate || feedbackBugInput
        ? { messageType: "bug_intake", contentDigest: await digestBugText(text) }
        : null,
    ),
  });
  if (!(await store.claimRecord({ ...scope, key }))) {
    await replayBugDelivery(context);
    return true;
  }
  try {
    if (event.edit_ts && !/후기|회고|수정|정정|변경/.test(text)) {
      await store.finishRecord({ ...scope, key }, "sent");
      return true;
    }
    if (isFeedbackChannel) await dispatchFeedbackBugMessage(context, text);
    else
      await dispatchCommunityMessage(
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
