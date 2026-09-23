import { handleBugView } from "./community-bug-interactions";
import { armCommunityClock } from "./community-clock";
import { readSettings } from "./community-controls";
import { parseIntroduction, submitIntroduction } from "./community-introduction";
import { escapeSlackText } from "./community-messages";
import { submitCommunityPalette } from "./community-palette";
import { parsePastReviewSubmission, pastReviewChange } from "./community-past-review";
import { applyChange } from "./community-records";
import { type CommunityContext, type CommunityEnv, ephemeral, post } from "./community-runtime";
import type { CommunityStore } from "./community-store";
import type { CommunityScope } from "./community-types";
import { InputError, object, string } from "./input";

type ViewInteraction = {
  readonly id: string;
  readonly view: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly context: CommunityContext;
  readonly store: CommunityStore;
  readonly scope: CommunityScope;
  readonly env: CommunityEnv;
  readonly thread: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
};

export async function handleCommunityView(input: ViewInteraction): Promise<Response> {
  const bugResponse = await handleBugView(input.id, input.view, input.context, input.waitUntil);
  if (bugResponse) return bugResponse;
  if (input.id === "community_introduction_submit") {
    const parsed = parseIntroduction(object(input.view.state).values);
    if ("errors" in parsed)
      return Response.json({ response_action: "errors", errors: parsed.errors });
    const revision = Number(input.metadata.revision);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new InputError("자기소개 버전을 확인할 수 없어요.");
    input.waitUntil(submitIntroduction(input.context, string(input.view.id), parsed, revision));
    return Response.json({ response_action: "clear" });
  }
  if (input.id === "community_past_review_submit") {
    const parsed = parsePastReviewSubmission(input.view);
    if ("errors" in parsed)
      return Response.json({ response_action: "errors", errors: parsed.errors });
    const current = await input.store.day({ ...input.scope, date: parsed.date });
    if (
      current.revision !== parsed.revision ||
      !current.goal.trim() ||
      current.resting ||
      (current.outcome !== "pending" && current.reflection.trim())
    )
      return Response.json({
        response_action: "errors",
        errors: { reflection: "이미 정리됐거나 그 뒤에 바뀐 기록이에요." },
      });
    input.waitUntil(
      applyChange({ ...input.context, date: parsed.date }, pastReviewChange(input.context, parsed)),
    );
    return Response.json({ response_action: "clear" });
  }
  if (input.id === "community_palette_submit")
    return submitCommunityPalette(input.context, input.view, input.waitUntil);
  if (input.id === "community_settings_submit" || input.id === "community_group_submit") {
    const prefs = readSettings(input.view, input.id === "community_group_submit");
    if ("errors" in prefs)
      return Response.json({ response_action: "errors", errors: prefs.errors });
    input.waitUntil(
      (async () => {
        if (input.id === "community_group_submit")
          await input.store.setGroupSchedule(input.scope, prefs);
        else await input.store.preferences(input.scope, prefs);
        await armCommunityClock(input.env, input.scope.channelId);
        await ephemeral(input.context, {
          text: `설정 저장! ONE THING ${prefs.goalTime} · 후기 ${prefs.reviewTime} · ${prefs.enabled ? "켜짐" : "꺼짐"} (한국 시간)`,
        });
      })(),
    );
    return Response.json({ response_action: "clear" });
  }
  if (input.id === "community_shoutout_submit") {
    const values = object(object(input.view.state).values);
    const target = string(object(object(values.target).value).selected_user);
    const text = string(object(object(values.message).value).value).trim();
    if (target === input.scope.userId)
      return Response.json({
        response_action: "errors",
        errors: { target: "자신 말고 응원할 동료를 골라주세요." },
      });
    if (!/^[UW][A-Z0-9]+$/.test(target) || !text || text.length > 500)
      return Response.json({
        response_action: "errors",
        errors: { message: "응원을 1~500자로 적어 주세요." },
      });
    const eligibleMembers = await input.store.members(input.scope.teamId, input.scope.channelId);
    if (!eligibleMembers.includes(input.scope.userId) || !eligibleMembers.includes(target))
      return Response.json({
        response_action: "errors",
        errors: { target: "지금 응원할 수 있는 동료를 골라주세요." },
      });
    input.waitUntil(
      (async () => {
        const key = `shoutout:${input.view.id}`;
        await input.store.putRecord({
          ...input.scope,
          key,
          kind: "shoutout",
          body: {
            target,
            text,
            date: input.context.date,
            source: input.context.source,
            thread: input.thread,
          },
        });
        if (!(await input.store.claimRecord({ ...input.scope, key }))) return;
        await post(input.context, {
          text: `<@${input.scope.userId}> → <@${target}>\n${escapeSlackText(text)}`,
        });
        await input.store.finishRecord({ ...input.scope, key }, "sent");
      })(),
    );
    return Response.json({ response_action: "clear" });
  }
  throw new InputError("지원하지 않는 화면입니다.");
}
