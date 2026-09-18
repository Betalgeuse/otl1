import { communityConfirmationMessage } from "./community-messages";
import { statusMessage } from "./community-records";
import { type CommunityContext, ephemeral, payloadRecord, post } from "./community-runtime";
import { callSlack } from "./community-social";
import { type Json, object, string } from "./input";

export type GardenPublication = {
  readonly sent: string;
  readonly prior: readonly { readonly body: unknown }[];
  readonly messageText: string;
  readonly projectionKey: string;
};
export type PreparedGarden = {
  readonly prior: readonly { readonly body: unknown }[];
  readonly message: { readonly [key: string]: Json };
};

function markedBlocks(value: unknown, marker: string): readonly Json[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((block) => payloadRecord(block).type !== "actions")
    .map((block, index) =>
      index === 0 ? { ...payloadRecord(block), block_id: marker } : payloadRecord(block),
    );
}

export async function findGardenMessage(
  context: CommunityContext,
  marker: string,
): Promise<string | null> {
  let cursor = "";
  do {
    const result = await callSlack(context.env.SLACK_BOT_TOKEN, "conversations.replies", {
      channel: context.scope.channelId,
      ts: context.thread,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (Array.isArray(result.messages))
      for (const message of result.messages) {
        const item = object(message);
        if (
          Array.isArray(item.blocks) &&
          item.blocks.some((block) => object(block).block_id === marker)
        )
          return string(item.ts);
      }
    const metadata = result.response_metadata;
    cursor = metadata ? string(object(metadata).next_cursor) : "";
  } while (cursor);
  return null;
}

export async function postGarden(
  context: CommunityContext,
  forDate: string,
  marker: string,
  projectionKey: string,
  revision: number,
): Promise<GardenPublication> {
  return postPreparedGarden(
    context,
    forDate,
    marker,
    projectionKey,
    revision,
    await prepareGardenPublication(context, forDate),
  );
}

export async function prepareGardenPublication(
  context: CommunityContext,
  forDate: string,
): Promise<PreparedGarden> {
  const day = await context.store.day({ ...context.scope, date: forDate });
  return {
    prior: await context.store.listRecords(context.scope, "card"),
    message: payloadRecord(await statusMessage(context, day, null)),
  };
}

export async function postPreparedGarden(
  context: CommunityContext,
  forDate: string,
  marker: string,
  projectionKey: string,
  revision: number,
  prepared: PreparedGarden,
): Promise<GardenPublication> {
  const { message, prior } = prepared;
  const blocks = markedBlocks(message.blocks, marker);
  const reconciled = await findGardenMessage(context, marker);
  const sent = reconciled ?? (await post(context, { ...message, blocks }));
  await context.store.putRecord({
    ...context.scope,
    key: `card:refresh:${sent}`,
    kind: "card",
    body: {
      ts: sent,
      text: string(message.text),
      date: forDate,
      thread: context.thread,
      source: context.source,
      revision,
      projectionKey,
    },
  });
  return { sent, prior, messageText: string(message.text), projectionKey };
}

export async function finishGardenPublication(
  context: CommunityContext,
  publication: GardenPublication,
  forDate: string,
  undoKey: string | null,
): Promise<void> {
  await retireGardenCards(context, publication);
  try {
    await showGardenControls(context, forDate, undoKey);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "community.garden.controls_failed",
        type: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
}

export async function publishGardenNow(
  context: CommunityContext,
  forDate: string,
  undoKey: string | null,
): Promise<string> {
  const projectionKey = `direct:${context.scope.userId}:${forDate}:${context.thread}`;
  const day = await context.store.day({ ...context.scope, date: forDate });
  const publication = await postGarden(
    context,
    forDate,
    `garden_direct_${context.key}`,
    projectionKey,
    day.revision,
  );
  await finishGardenPublication(context, publication, forDate, undoKey);
  return publication.sent;
}

export async function retireGardenCards(
  context: CommunityContext,
  publication: GardenPublication,
): Promise<void> {
  const { sent, prior } = publication;
  for (const record of prior) {
    const data = object(record.body);
    if (data.projectionKey !== publication.projectionKey) continue;
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
}

export async function showGardenControls(
  context: CommunityContext,
  forDate: string,
  undoKey: string | null,
): Promise<void> {
  const value = (key: string) =>
    JSON.stringify({
      ownerId: context.scope.userId,
      key,
      thread: context.thread,
      source: context.source,
    });
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
}
