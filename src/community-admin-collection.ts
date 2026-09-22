import type { CommunityChoice } from "./community-messages";
import { requireCommunityAdmin } from "./community-permissions";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { runCommunitySchedule, type ScheduleClock } from "./community-scheduler";
import { InputError, object, string } from "./input";

const ACTION_ID = "community_test_public_collection";

export async function preparePublicCollectionTest(
  context: CommunityContext,
): Promise<CommunityChoice | null> {
  requireCommunityAdmin(context.scope, context.env);
  const target = context.env.COMMUNITY_PUBLIC_CHANNEL_ID;
  if (!target) return null;
  if (target === context.scope.channelId)
    throw new InputError("공개 데일리스크럼 채널 설정을 확인해 주세요.");
  const key = `admin-collection-test:${context.source}`;
  await context.store.putRecord({
    ...context.scope,
    key,
    kind: "admin_qa_action",
    body: {
      date: context.date,
      source: context.source,
      thread: context.thread,
      targetChannelId: target,
    },
  });
  return {
    label: "데일리스크럼 수집 테스트",
    actionId: ACTION_ID,
    value: JSON.stringify({
      ownerId: context.scope.userId,
      key,
      source: context.source,
      thread: context.thread,
    }),
  };
}

export async function runPublicCollectionTest(
  context: CommunityContext,
  actionKey: string,
  clock: ScheduleClock = { now: () => new Date(Date.now()) },
): Promise<void> {
  requireCommunityAdmin(context.scope, context.env);
  const target = context.env.COMMUNITY_PUBLIC_CHANNEL_ID;
  if (!target || target === context.scope.channelId)
    throw new InputError("공개 데일리스크럼 채널 설정을 확인해 주세요.");
  const action = await context.store.getRecord({ ...context.scope, key: actionKey });
  if (action?.kind !== "admin_qa_action") throw new InputError("테스트 요청을 확인할 수 없어요.");
  const actionBody = object(action.body);
  if (
    string(actionBody.date) !== context.date ||
    string(actionBody.source) !== context.source ||
    string(actionBody.thread) !== context.thread ||
    string(actionBody.targetChannelId) !== target
  )
    throw new InputError("테스트 요청이 오래되었거나 위치가 달라요. 다시 열어 주세요.");
  if (!(await context.store.claimRecord({ ...context.scope, key: actionKey }))) return;
  const publicScope = { ...context.scope, channelId: target };
  const scheduleRecord = await context.store.getRecord({ ...publicScope, key: "group-schedule" });
  if (!scheduleRecord) throw new InputError("데일리스크럼 공통 안내를 먼저 설정해 주세요.");
  const schedule = object(scheduleRecord.body);
  const goalTime = string(schedule.goalTime);
  const reviewTime = string(schedule.reviewTime);
  if (![goalTime, reviewTime].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))
    throw new InputError("데일리스크럼 안내 시각을 확인해 주세요.");
  let people = 0;
  let batches = 0;
  for (const time of new Set([goalTime, reviewTime])) {
    const result = await runCommunitySchedule(
      {
        ...context.env,
        COMMUNITY_CHANNEL_ID: target,
        COMMUNITY_ADMIN_ID: string(context.env.COMMUNITY_ADMIN_ID),
      },
      context.store,
      new Date(`${context.date}T${time}:00+09:00`),
      clock,
    );
    people += result.personal;
    if (result.personal > 0) batches += 1;
  }
  await context.store.finishRecord({ ...context.scope, key: actionKey }, "sent");
  await ephemeral(context, {
    text: `데일리스크럼 수집 테스트 · 대상 ${people}명 · 배치 ${batches}건`,
  });
}
