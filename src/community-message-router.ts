import { adminCommand, captureFeedback } from "./community-admin";
import { continueBugReport, handleBugReportMessage } from "./community-bugs";
import { groupCard, settingsCard } from "./community-controls";
import { decideCommunityRecord } from "./community-decision";
import { prepareRecordEdit } from "./community-edits";
import { classifyCommunityIntent } from "./community-language";
import { communityConfirmationMessage } from "./community-messages";
import { answerCommunityQuestion } from "./community-questions";
import { applyChange, confirmChange, publishStatus } from "./community-records";
import { handleReflectionReport } from "./community-reflection";
import {
  type CommunityContext,
  ephemeral,
  post,
  scopedValue,
  textReply,
} from "./community-runtime";
import type { DayChange } from "./community-types";
import { koreaDate } from "./input";

export async function dispatchCommunityMessage(
  context: CommunityContext,
  text: string,
  addressed: boolean,
): Promise<void> {
  if (await captureFeedback(context, text)) return;
  if (await handleBugReportMessage(context, text)) return;
  if (await continueBugReport(context, text)) return;
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
      communityConfirmationMessage("오늘 ONE THING을 함께한 동료에게 한마디!!! 🙌", [
        {
          label: "샤라웃 보내기",
          actionId: "community_shoutout",
          value: scopedValue(context.scope, context.date),
        },
      ]),
    );
    return;
  }
  if (await handleReflectionReport(context, text)) return;
  if (await prepareRecordEdit(context, text)) return;
  if (await answerCommunityQuestion(context, text, addressed)) return;
  const day = await context.store.day({ ...context.scope, date: context.date });
  if (/^(내 상태|원씽 보기|상태 보기)$/.test(text)) {
    await publishStatus(context, day, null);
    return;
  }
  if (text.length > 1000) {
    await textReply(
      context,
      "내용이 길어요. ONE THING은 200자, 후기는 이 대화에서 1,000자 이내로 알려주세요.",
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
  const intent = decideCommunityRecord(
    await classifyCommunityIntent(context.env.AI, { goal: day.goal || null, text }),
    text,
  );
  const base = {
    ...context.scope,
    date: context.date,
    key: `change:${context.key}`,
    expectedRevision: day.revision,
  };
  switch (intent.intent) {
    case "ignore":
      return;
    case "unclear":
      if (!intent.currentDateSafe) {
        await ephemeral(context, {
          text: "날짜가 있는 수행 기록은 한 날짜와 완료·부분 완료·미완료·휴식을 함께 알려주세요. 아직 기록을 바꾸지 않았어요.",
        });
        return;
      }
      await confirmChange(
        context,
        day,
        text,
        day.goal ? (intent.reflectionText ? "reflection" : "complete") : "goal",
      );
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
      const reflectionText = intent.reflectionText;
      if (
        intent.needsConfirmation ||
        !day.goal ||
        intent.outcome === "unknown" ||
        context.date !== koreaDate(Date.now() / 1000)
      ) {
        await confirmChange(context, day, text, reflectionText ? "reflection" : "complete");
        return;
      }
      const outcome = intent.outcome;
      const change: DayChange = reflectionText
        ? { ...base, action: "reflection", text: reflectionText, outcome }
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
