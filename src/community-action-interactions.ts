import type { parseBugAnswerActionId } from "./community-bug-actions";
import { handleBugAction } from "./community-bug-interactions";
import { openSettings, openShoutout } from "./community-controls";
import { introductionModal } from "./community-introduction";
import { showIntroductionDirectory } from "./community-introduction-channel";
import { openCommunityPalette } from "./community-palette";
import {
  openPastReviewModal,
  openPastReviewPickerModal,
  pastReviewBinding,
} from "./community-past-review";
import { processRecordAction } from "./community-record-interactions";
import { type CommunityContext, ephemeral } from "./community-runtime";
import type { CommunityScope } from "./community-types";
import { InputError, object, string } from "./input";

type ActionInteraction = {
  readonly id: string;
  readonly action: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  readonly scope: CommunityScope;
  readonly context: CommunityContext;
  readonly bugAnswerAction: ReturnType<typeof parseBugAnswerActionId>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
};

export async function handleCommunityAction(input: ActionInteraction): Promise<Response> {
  const selected = input.action.selected_option
    ? object(input.action.selected_option).value
    : input.action.value;
  const value = object(JSON.parse(string(selected)));
  const ownerId = string(value.ownerId);
  const key = string(value.key);
  const resolvedOwnerId = ownerId === "actor" ? input.scope.userId : ownerId;
  if (
    !["community_shoutout", "community_introduction", "community_introduction_directory"].includes(
      input.id,
    ) &&
    resolvedOwnerId !== input.scope.userId
  )
    throw new InputError("본인 기록만 변경할 수 있어요.");
  let context = input.context;
  if (value.thread !== undefined || value.source !== undefined) {
    const thread = string(value.thread);
    const source = string(value.source);
    if (!/^\d+\.\d{6}$/.test(thread) || !/^\d+\.\d{6}$/.test(source))
      throw new InputError("기록 위치를 확인할 수 없어요.");
    context = { ...context, thread, source };
  }
  if (input.id === "community_palette") {
    await openCommunityPalette(context, string(input.data.trigger_id), key);
    return new Response(null, { status: 200 });
  }
  if (input.id === "community_settings" || input.id === "community_group_settings") {
    await openSettings(
      context,
      string(input.data.trigger_id),
      input.id === "community_group_settings",
    );
    return new Response(null, { status: 200 });
  }
  if (input.id === "community_shoutout") {
    await openShoutout(
      context,
      string(input.data.trigger_id),
      ownerId === input.scope.userId ? null : ownerId,
    );
    return new Response(null, { status: 200 });
  }
  if (input.id === "community_introduction") {
    await introductionModal(context, string(input.data.trigger_id));
    return new Response(null, { status: 200 });
  }
  if (input.id === "community_past_review") {
    await openPastReviewModal(context, string(input.data.trigger_id), pastReviewBinding(value));
    return new Response(null, { status: 200 });
  }
  if (input.id === "community_past_review_list") {
    await openPastReviewPickerModal(context, string(input.data.trigger_id));
    return new Response(null, { status: 200 });
  }
  const bugResponse = await handleBugAction(
    input.id,
    input.bugAnswerAction,
    context,
    key,
    value,
    input.data.trigger_id,
    input.waitUntil,
  );
  if (bugResponse) return bugResponse;
  if (input.id === "community_introduction_directory") {
    input.waitUntil(
      showIntroductionDirectory(context).catch((error: unknown) =>
        console.error(
          JSON.stringify({
            event: "community.introduction_directory.failed",
            type: error instanceof Error ? error.name : "Unknown",
          }),
        ),
      ),
    );
    return new Response(null, { status: 200 });
  }
  input.waitUntil(
    processRecordAction(context, input.id, key, value).catch(async (error: unknown) => {
      console.error(
        JSON.stringify({
          event: "community.action.failed",
          type: error instanceof Error ? error.name : "Unknown",
        }),
      );
      await ephemeral(context, {
        text:
          error instanceof InputError
            ? error.message
            : "처리를 확인하지 못했어요. 현재 상태를 확인해 주세요.",
      });
    }),
  );
  return new Response(null, { status: 200 });
}
