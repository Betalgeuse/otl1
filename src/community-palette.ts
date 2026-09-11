import { publishStatus } from "./community-records";
import { type CommunityContext, ephemeral, payloadRecord } from "./community-runtime";
import { callSlack } from "./community-social";
import { DEFAULT_PALETTE, date, object } from "./input";
import { modalPalette, paletteModal } from "./palette-modal";
import { NeonStore } from "./store";

export async function openCommunityPalette(
  context: CommunityContext,
  triggerId: string,
  day: string,
) {
  const targetDate = date(day);
  const current = await new NeonStore(context.env.DATABASE_URL).execute({
    ...context.scope,
    today: context.date,
    date: targetDate,
    action: "get",
    text: "",
    palette: DEFAULT_PALETTE,
    eventTime: Date.now() / 1000,
  });
  await callSlack(context.env.SLACK_BOT_TOKEN, "views.open", {
    trigger_id: triggerId,
    view: {
      ...payloadRecord(
        paletteModal(current.palette, {
          ownerId: context.scope.userId,
          responseUrl: "",
          shared: false,
          date: targetDate,
        }),
      ),
      callback_id: "community_palette_submit",
      private_metadata: JSON.stringify({
        userId: context.scope.userId,
        channelId: context.scope.channelId,
        source: context.source,
        thread: context.thread,
        date: targetDate,
      }),
    },
  });
}

export function submitCommunityPalette(
  context: CommunityContext,
  view: Record<string, unknown>,
  waitUntil: (promise: Promise<unknown>) => void,
): Response {
  const palette = modalPalette(object(view.state).values);
  if ("errors" in palette)
    return Response.json({ response_action: "errors", errors: palette.errors });
  waitUntil(
    (async () => {
      await new NeonStore(context.env.DATABASE_URL).execute({
        ...context.scope,
        today: context.date,
        date: context.date,
        action: "palette",
        text: "",
        palette,
        eventTime: Date.now() / 1000,
      });
      const day = await context.store.day({ ...context.scope, date: context.date });
      await publishStatus(context, day, null);
    })().catch(async (error: unknown) => {
      console.error(
        JSON.stringify({
          event: "community.palette.failed",
          type: error instanceof Error ? error.name : "Unknown",
        }),
      );
      await ephemeral(context, {
        text: "색상 반영을 확인하지 못했어요. 잔디를 확인하고 다시 시도해 주세요.",
      });
    }),
  );
  return Response.json({ response_action: "clear" });
}
