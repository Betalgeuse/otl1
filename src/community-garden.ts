import { communityConfirmationMessage } from "./community-messages";
import { statusMessage } from "./community-records";
import { type CommunityContext, ephemeral, payloadRecord, post } from "./community-runtime";
import { callSlack } from "./community-social";
import { object, string } from "./input";

export async function publishGardenNow(
  context: CommunityContext,
  forDate: string,
  undoKey: string | null,
): Promise<string> {
  const value = (key: string) =>
    JSON.stringify({
      ownerId: context.scope.userId,
      key,
      thread: context.thread,
      source: context.source,
    });
  const day = await context.store.day({ ...context.scope, date: forDate });
  const prior = await context.store.listRecords(context.scope, "card");
  const message = payloadRecord(await statusMessage(context, day, null));
  const blocks = Array.isArray(message.blocks)
    ? message.blocks.filter((block) => object(block).type !== "actions")
    : [];
  const sent = await post(context, { ...message, blocks });
  await context.store.putRecord({
    ...context.scope,
    key: `card:refresh:${sent}`,
    kind: "card",
    body: { ts: sent, text: string(message.text), date: forDate },
  });
  for (const record of prior) {
    const data = object(record.body);
    const ts = string(data.ts);
    if (
      ts === sent ||
      (await context.store.getRecord({ ...context.scope, key: `retired-card:${ts}` }))
    )
      continue;
    try {
      await callSlack(context.env.SLACK_BOT_TOKEN, "chat.update", {
        channel: context.scope.channelId,
        ts,
        text:
          typeof data.text === "string"
            ? data.text
            : "이 잔디는 새 메시지로 갱신됐어요. 기존 댓글은 이곳에 남아 있어요.",
        blocks: [],
        attachments: [],
      });
      await context.store.putRecord({
        ...context.scope,
        key: `retired-card:${ts}`,
        kind: "retired_card",
        body: { replacement: sent },
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "community.garden.retire_failed",
          type: error instanceof Error ? error.name : "Unknown",
        }),
      );
    }
  }
  await ephemeral(
    context,
    communityConfirmationMessage(`${forDate} 내 잔디 관리`, [
      ...(undoKey
        ? [{ label: "되돌리기", actionId: "community_undo", value: value(undoKey) }]
        : []),
      { label: "현재 상태 보기", actionId: "community_status", value: value(forDate) },
      { label: "색상 변경", actionId: "community_palette", value: value(forDate) },
      { label: "알림 설정", actionId: "community_settings", value: value(forDate) },
      ...(context.env.COMMUNITY_INTRO_CHANNEL_ID
        ? [
            {
              label: "자기소개",
              actionId: "community_introduction",
              value: value("self-introduction"),
            },
          ]
        : []),
    ]),
  );
  return sent;
}
