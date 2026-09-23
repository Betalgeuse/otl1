import { bugTextEntryState } from "./community-bug-entry-session";
import { parseBugIntakeCandidate } from "./community-bug-intent";
import { digestBugText } from "./community-bug-private";
import { replayBugDelivery } from "./community-bugs";
import { enrollReminderMember } from "./community-enrollment";
import { messageDate } from "./community-followup";
import { deliverWelcomeGuide } from "./community-guide";
import { incomingMessageBody } from "./community-intake";
import { handleIntroductionChannelMessage } from "./community-introduction-channel";
import { handleLifecycleAdminMessage } from "./community-lifecycle-admin";
import { lifecycleAdminStore } from "./community-lifecycle-runtime-store";
import { dispatchCommunityMessage, dispatchFeedbackBugMessage } from "./community-message-router";
import {
  handleReferralCapacityAdminMessage,
  referralCapacityAdminStore,
} from "./community-referral-capacity-admin";
import { handleReferralTeamJoin } from "./community-referral-join";
import { handleReferralLinkMessage } from "./community-referral-link";
import { referralSlackPort } from "./community-referral-slack";
import { CommunityReferralStore } from "./community-referral-store";
import { replayReflectionOutcomeDelivery } from "./community-reflection-outcome";
import { type CommunityEnv, textReply } from "./community-runtime";
import { handleShareInfoMessage } from "./community-share-info";
import { callSlack } from "./community-social";
import { CommunityStore } from "./community-store";
import { welcomeTownhallMember } from "./community-welcome";
import { InputError, koreaDate, object, string } from "./input";
import { communityEditRelevant, messageEvent } from "./slack-message-event";
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
  const rawEvent = object(data.event);
  if (rawEvent.type === "team_join") {
    if (env.REFERRALS_ENABLED === "true") {
      const joined = object(rawEvent.user);
      const referral = new CommunityReferralStore(new NeonStore(env.DATABASE_URL), {
        teamId: env.SLACK_TEAM_ID,
        channelId: env.COMMUNITY_PUBLIC_CHANNEL_ID ?? "",
        userId: env.COMMUNITY_ADMIN_ID ?? "",
      });
      await handleReferralTeamJoin(
        { teamId: env.SLACK_TEAM_ID, eventId: string(data.event_id), userId: string(joined.id) },
        env,
        referral,
        referralSlackPort(env),
      );
    }
    return true;
  }
  if (rawEvent.type !== "message" && rawEvent.type !== "app_mention") return false;
  const event = messageEvent(rawEvent);
  if (typeof event.text === "string" && event.text.trim().startsWith("생애주기 ")) {
    if (event.type !== "message" || event.bot_id || event.subtype !== undefined || event.edit_ts)
      return true;
    const adminChannel = env.COMMUNITY_CHANNEL_ID;
    const userId = string(event.user);
    if (
      !adminChannel ||
      adminChannel === env.COMMUNITY_PUBLIC_CHANNEL_ID ||
      event.channel !== adminChannel ||
      userId !== env.COMMUNITY_ADMIN_ID
    )
      throw new InputError("운영자 전용 기능입니다.");
    const source = string(event.ts);
    const stamp = Number(source);
    if (!Number.isFinite(stamp) || Math.abs(Date.now() / 1000 - stamp) > 300) return true;
    return handleLifecycleAdminMessage(
      {
        teamId: env.SLACK_TEAM_ID,
        channelId: adminChannel,
        userId,
        text: string(event.text).trim(),
        key: string(data.event_id),
        now: new Date(stamp * 1_000).toISOString(),
      },
      env,
      lifecycleAdminStore(env.LIFECYCLE_ADMIN_DATABASE_URL),
      async (replyText) => {
        await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
          channel: userId,
          text: replyText,
        });
      },
    );
  }
  if (
    typeof event.text === "string" &&
    (event.text.trim().startsWith("초대 한도 ") || event.text.trim().startsWith("초대 기본 한도 "))
  ) {
    if (event.type !== "message" || event.bot_id || event.subtype !== undefined || event.edit_ts)
      return true;
    const adminChannel = env.COMMUNITY_CHANNEL_ID;
    const userId = string(event.user);
    if (
      !adminChannel ||
      adminChannel === env.COMMUNITY_PUBLIC_CHANNEL_ID ||
      event.channel !== adminChannel ||
      userId !== env.COMMUNITY_ADMIN_ID
    )
      throw new InputError("운영자 전용 기능입니다.");
    const stamp = Number(string(event.ts));
    if (!Number.isFinite(stamp) || Math.abs(Date.now() / 1000 - stamp) > 300) return true;
    return handleReferralCapacityAdminMessage(
      {
        teamId: env.SLACK_TEAM_ID,
        channelId: adminChannel,
        userId,
        text: string(event.text).trim(),
        key: string(data.event_id),
        now: new Date(stamp * 1_000).toISOString(),
      },
      env,
      referralCapacityAdminStore(env.REFERRAL_ADMIN_DATABASE_URL),
      async (replyText) => {
        await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
          channel: userId,
          text: replyText,
        });
      },
    );
  }
  if (await deliverWelcomeGuide(event, env)) return true;
  if (await handleIntroductionChannelMessage(event, env)) return true;
  await enrollReminderMember(event, env);
  if (await welcomeTownhallMember(event, env)) return true;
  const shareContext = {
    env,
    store: new CommunityStore(new NeonStore(env.DATABASE_URL)),
    scope: {
      teamId: env.SLACK_TEAM_ID,
      channelId: string(event.channel),
      userId: string(event.user),
    },
    thread: string(event.thread_ts ?? event.ts),
    source: string(event.ts),
    date: koreaDate(Number(event.ts)),
    key: `share-info:${string(event.ts)}`,
  };
  if (await handleShareInfoMessage(event, shareContext)) return true;
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
  if (env.REFERRALS_ENABLED === "true" && text === "내 초대 링크" && !isFeedbackChannel) {
    if (event.edit_ts) return true;
    await store.putRecord({
      ...scope,
      key,
      kind: "incoming",
      body: incomingMessageBody(
        {
          date: koreaDate(stamp),
          thread: string(event.thread_ts ?? source),
          rawText,
          normalizedText: text,
          editTs: null,
        },
        null,
      ),
    });
    if (!(await store.claimRecord({ ...scope, key }))) return true;
    try {
      await handleReferralLinkMessage(
        { teamId: env.SLACK_TEAM_ID, channelId: string(event.channel), userId, text },
        env,
        new CommunityReferralStore(new NeonStore(env.DATABASE_URL), {
          teamId: env.SLACK_TEAM_ID,
          channelId: string(event.channel),
          userId,
        }),
        referralSlackPort(env),
      );
      await store.finishRecord({ ...scope, key }, "sent");
    } catch (error) {
      await store.finishRecord({ ...scope, key }, "failed");
      throw error;
    }
    return true;
  }
  const thread = string(event.thread_ts ?? event.ts);
  const date = await messageDate(store, scope, string(env.COMMUNITY_ADMIN_ID), source, thread);
  const textEntryState =
    thread === source ? "missing" : await bugTextEntryState(store, scope, thread);
  const context = {
    env,
    store,
    scope,
    key,
    thread,
    source,
    date,
    bugTextEntryState: textEntryState,
  };
  const bugCandidate = parseBugIntakeCandidate(
    text,
    [env.COMMUNITY_CHANNEL_ID, env.COMMUNITY_FEEDBACK_CHANNEL_ID].includes(scope.channelId),
  );
  if (isFeedbackChannel && !bugCandidate && thread === source) return true;
  const textEntryInput = textEntryState !== "missing";
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
      bugCandidate || feedbackBugInput || textEntryInput
        ? { messageType: "bug_intake", contentDigest: await digestBugText(text) }
        : null,
    ),
  });
  if (!(await store.claimRecord({ ...scope, key }))) {
    await replayBugDelivery(context);
    if (!isFeedbackChannel && !bugCandidate && textEntryState === "missing")
      await replayReflectionOutcomeDelivery(context);
    return true;
  }
  try {
    if (!communityEditRelevant(event.edit_ts, isFeedbackChannel && thread !== source, text)) {
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
