import { buildBoard } from "./board";
import { boardLink } from "./board-link";
import { customBotEmoji, randomCustomEmoji } from "./community-emoji";
import { earlierDayNotice } from "./community-followup";
import { generateEncouragement } from "./community-language";
import { communityConfirmationMessage, communityStatusMessage } from "./community-messages";
import { emitMilestones } from "./community-milestones";
import { publishStatus } from "./community-record-publication";
import { type CommunityContext, ephemeral, scopedValue, textReply } from "./community-runtime";
import { addReactions, socialReactions } from "./community-social";
import type { CommunityDay, DayChange } from "./community-types";
import { DEFAULT_PALETTE, koreaDate, object } from "./input";
import { NeonStore } from "./store";

export async function statusMessage(
  context: CommunityContext,
  day: CommunityDay,
  undoKey: string | null,
) {
  const boardDate = koreaDate(Date.now() / 1000);
  const history = (await context.store.history(context.scope)).filter(
    (item) => item.goal && item.date <= boardDate,
  );
  const legacy = await new NeonStore(context.env.DATABASE_URL).execute({
    teamId: context.scope.teamId,
    userId: context.scope.userId,
    today: boardDate,
    date: day.date,
    action: "get",
    text: "",
    palette: DEFAULT_PALETTE,
    eventTime: Date.now() / 1000,
  });
  const snapshot = {
    startDate: history[0]?.date ?? boardDate,
    palette: legacy.palette,
    goals: history.map((item) => ({
      date: item.date,
      text: item.goal,
      completed: item.outcome === "complete",
    })),
  };
  const url = await boardLink(buildBoard(snapshot, boardDate, boardDate), {
    baseUrl: context.env.PUBLIC_BASE_URL,
    secret: context.env.BOARD_SIGNING_SECRET,
    today: boardDate,
  });
  return communityStatusMessage({
    earlierNotice: await earlierDayNotice(context, history, boardDate),
    boardDate,
    userId: day.userId,
    date: day.date,
    goal: day.goal || null,
    outcome: day.outcome === "pending" ? "unknown" : day.outcome,
    reflection: day.reflection || null,
    rest: day.resting,
    undoValue: undoKey ? scopedValue(context.scope, undoKey) : null,
    boardUrl: url,
    statusValue: scopedValue(context.scope, day.date),
    settingsValue: scopedValue(context.scope, day.date),
  });
}

export async function confirmChange(
  context: CommunityContext,
  day: CommunityDay,
  text: string,
  action: DayChange["action"],
  outcome?: DayChange["outcome"],
) {
  const key = `pending:${context.key}`;
  await context.store.putRecord({
    ...context.scope,
    key,
    kind: "pending",
    body: {
      date: day.date,
      revision: day.revision,
      text,
      action,
      outcome: outcome ?? null,
      source: context.source,
      thread: context.thread,
    },
  });
  const value = scopedValue(context.scope, key);
  const dateLabel = day.date === koreaDate(Date.now() / 1000) ? "오늘" : day.date;
  const choices =
    action === "goal"
      ? [{ label: "이 목표 등록", actionId: "community_confirm", value }]
      : [
          { label: "완료했어요", actionId: "community_complete", value },
          { label: "일부 진행했어요", actionId: "community_partial", value },
          { label: "못 했어요", actionId: "community_not_done", value },
          {
            label: day.date === koreaDate(Date.now() / 1000) ? "오늘 쉬어요" : "이날 쉬었어요",
            actionId: "community_rest",
            value,
          },
          ...(action === "reflection"
            ? []
            : [
                {
                  label:
                    day.date === koreaDate(Date.now() / 1000)
                      ? "오늘 후기로 남기기"
                      : "이날 후기로 남기기",
                  actionId: "community_reflection",
                  value,
                },
              ]),
        ];
  await ephemeral(
    context,
    communityConfirmationMessage(
      action === "goal"
        ? `${dateLabel} ONE THING으로 등록할까요?\n${text}`
        : action === "reflection"
          ? `${dateLabel} ONE THING을 완료하셨나요?\n선택한 상태와 아래 글을 후기로 저장할게요.\n“${text}”`
          : `${dateLabel} ONE THING을 완료하셨나요?`,
      choices,
    ),
  );
}

export async function applyChange(context: CommunityContext, change: DayChange): Promise<void> {
  const result = await context.store.change({
    ...change,
    syncLegacy: context.scope.channelId === context.env.COMMUNITY_PUBLIC_CHANNEL_ID,
    delivery: {
      source: context.source,
      thread: context.thread,
      undoKey: null,
    },
  });
  if (result.conflict) {
    await textReply(context, "그 뒤에 기록이 바뀌었어요. 현재 상태를 확인하고 다시 알려주세요.");
    return;
  }
  if (!result.changed) {
    await textReply(context, "이미 반영된 기록이에요.");
    return;
  }
  if (change.preserveOutcome) {
    await publishStatus(context, result.day, null, result.gardenDeliveryKey);
    return;
  }
  try {
    await emitMilestones(context, result);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "community.milestone.failed",
        type: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
  const kind =
    change.action === "goal"
      ? "registered"
      : change.action === "rest"
        ? "rest"
        : change.action === "reflection"
          ? "reflection"
          : "reflection";
  const celebrateComplete =
    result.day.outcome === "complete" &&
    (change.action === "complete" || change.action === "reflection");
  const customNames =
    change.action === "undo" ? [] : await randomCustomEmoji(context.env.SLACK_BOT_TOKEN);
  const names =
    change.action === "undo"
      ? []
      : customNames.length
        ? customNames
        : socialReactions(context.scope.userId, context.key, celebrateComplete ? "complete" : kind);
  const undoRecordKey = `undo:${result.undoKey}`;
  await context.store.putRecord({
    ...context.scope,
    key: undoRecordKey,
    kind: "undo",
    body: {
      undoKey: result.undoKey,
      date: result.day.date,
      source: context.source,
      names,
      revision: result.day.revision,
    },
  });
  await publishStatus(context, result.day, undoRecordKey, result.gardenDeliveryKey);
  if (change.action === "undo") return;
  try {
    await addReactions(context.env.SLACK_BOT_TOKEN, {
      channel: context.scope.channelId,
      ts: context.source,
      names,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "community.reaction.failed",
        type: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
  if (context.env.AI && (change.action === "goal" || change.action === "reflection")) {
    const earlier = (await context.store.listRecords(context.scope, "encouragement"))
      .toSorted((a, b) => a.key.localeCompare(b.key))
      .at(-1);
    const previous = earlier ? object(earlier.body).text : undefined;
    const encouragement = await generateEncouragement(context.env.AI, {
      kind: change.action === "goal" ? "goal" : "reflection",
      text: change.text ?? "",
      userId: context.scope.userId,
      ...(typeof previous === "string" ? { previous } : {}),
    });
    await textReply(context, await customBotEmoji(context.env.SLACK_BOT_TOKEN, encouragement));
    await context.store.putRecord({
      ...context.scope,
      key: `encouragement:${context.source}`,
      kind: "encouragement",
      body: { text: encouragement },
    });
  }
}

export { publishStatus, undoChange } from "./community-record-publication";
