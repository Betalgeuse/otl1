import { publishRelease, releasePreview } from "./community-admin";
import { runPublicCollectionTest } from "./community-admin-collection";
import { stopSettings } from "./community-controls";
import { enablePublicSchedule } from "./community-cutover";
import { confirmedRecordEdit } from "./community-edits";
import { applyChange, publishStatus, undoChange } from "./community-records";
import { type CommunityContext, ephemeral, textReply } from "./community-runtime";
import { runCommunitySchedule } from "./community-scheduler";
import type { DayChange } from "./community-types";
import { date, InputError, object, string } from "./input";

export async function processRecordAction(
  context: CommunityContext,
  id: string,
  key: string,
): Promise<void> {
  if (id === "community_test_public_collection") {
    await runPublicCollectionTest(context, key);
    return;
  }
  if (id === "community_live_schedule") {
    await enablePublicSchedule(context);
    return;
  }
  if (id === "community_undo") {
    await undoChange(context, key);
    return;
  }
  if (id === "community_stop") {
    await stopSettings(context);
    return;
  }
  if (id === "community_status") {
    const day = await context.store.day({ ...context.scope, date: date(key) });
    await publishStatus(context, day, null);
    return;
  }
  if (id === "community_release_preview") {
    await releasePreview(context, key);
    return;
  }
  if (id === "community_publish") {
    await publishRelease(context, key, context.key);
    return;
  }
  if (id === "community_test_schedule" || id === "community_test_group") {
    let goalTime: string;
    let reviewTime: string;
    if (id === "community_test_group") {
      const record = await context.store.getRecord({ ...context.scope, key: "group-schedule" });
      if (!record) {
        await textReply(context, "공통 안내를 먼저 설정해 주세요.");
        return;
      }
      const data = object(record.body);
      goalTime = string(data.goalTime);
      reviewTime = string(data.reviewTime);
    } else {
      const preferences = await context.store.preferences(context.scope);
      goalTime = preferences.goalTime;
      reviewTime = preferences.reviewTime;
    }
    for (const time of new Set([goalTime, reviewTime]))
      await runCommunitySchedule(
        {
          ...context.env,
          COMMUNITY_CHANNEL_ID: context.scope.channelId,
          COMMUNITY_ADMIN_ID: string(context.env.COMMUNITY_ADMIN_ID),
        },
        context.store,
        new Date(`${context.date}T${time}:00+09:00`),
      );
    await textReply(
      context,
      "설정 시각으로 검사했어요. 실제 예약 조건을 사용한 QA 시간 테스트이며 이미 보낸 알림은 다시 보내지 않아요.",
    );
    return;
  }
  const pending = await context.store.getRecord({ ...context.scope, key });
  if (pending?.kind !== "pending") throw new InputError("확인할 요청이 없어요.");
  const data = object(pending.body);
  const action = string(data.action);
  const selected = id.replace("community_", "");
  if (!["confirm", "complete", "partial", "not_done", "rest", "reflection"].includes(selected))
    throw new InputError("지원하지 않는 동작입니다.");
  if (!(await context.store.claimRecord({ ...context.scope, key }))) {
    await ephemeral(context, { text: "이미 처리한 선택이에요." });
    return;
  }
  const targetDate = date(data.date);
  const revision = Number(data.revision);
  if (!Number.isSafeInteger(revision)) throw new InputError("기록 버전을 확인할 수 없어요.");
  const appliedContext = {
    ...context,
    date: targetDate,
    source: string(data.source),
    thread: string(data.thread),
  };
  const base = { ...context.scope, date: targetDate, key, expectedRevision: revision };
  let change: DayChange;
  if (selected === "confirm" && action === "edit") change = confirmedRecordEdit(base, data);
  else if (selected === "confirm" && action === "goal")
    change = { ...base, action: "goal", text: string(data.text) };
  else if (selected === "rest") change = { ...base, action: "rest" };
  else if (selected === "reflection")
    change = { ...base, action: "reflection", text: string(data.text) };
  else if (selected === "complete" || selected === "partial" || selected === "not_done")
    change =
      action === "reflection"
        ? { ...base, action: "reflection", text: string(data.text), outcome: selected }
        : { ...base, action: selected };
  else throw new InputError("선택 내용을 확인해 주세요.");
  await applyChange(appliedContext, change);
  await context.store.finishRecord({ ...context.scope, key }, "sent");
}
