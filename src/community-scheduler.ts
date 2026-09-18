import { isWeekend } from "./calendar";
import { enqueueCommonDelivery, sendCommonDeliveries } from "./community-common-delivery";
import { customBotEmoji } from "./community-emoji";
import { collectCurrentChannelMembers } from "./community-membership";
import { sendReminderBatches } from "./community-reminder-batch";
import type { CommunityStore } from "./community-store";
import type { ChannelMembershipSnapshot } from "./community-types";
import { InputError, object, string } from "./input";

export type CommunityScheduleEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly SLACK_BOT_TOKEN: string;
  readonly COMMUNITY_CHANNEL_ID: string;
  readonly COMMUNITY_ADMIN_ID: string;
  readonly COMMUNITY_PUBLIC_CHANNEL_ID?: string;
  readonly COMMUNITY_BOT_USER_ID?: string;
};
export type ScheduleClock = { readonly now: () => Date };
type ScheduleStore = Pick<
  CommunityStore,
  | "getRecord"
  | "putRecord"
  | "claimRecord"
  | "finishRecord"
  | "reconcileChannelMembers"
  | "reminderTriggerDue"
  | "claimReminderBatch"
  | "finishReminderBatch"
  | "pruneReminderBatch"
  | "claimCommonDelivery"
  | "finishCommonDelivery"
>;
type Kind = "goal" | "review";
type Schedule = {
  readonly enabled: boolean;
  readonly goalTime: string;
  readonly reviewTime: string;
};

function parseSchedule(value: unknown): Schedule {
  const body = object(value);
  if (typeof body.enabled !== "boolean") throw new InputError("Invalid schedule enabled flag");
  const goalTime = string(body.goalTime);
  const reviewTime = string(body.reviewTime);
  if (![goalTime, reviewTime].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)))
    throw new InputError("Invalid schedule time");
  return { enabled: body.enabled, goalTime, reviewTime };
}
function promptText(date: string, kind: Kind): string {
  if (isWeekend(date))
    return `${date} 주말 *ONE THING*은 선택이에요!!! :seedling: 함께하고 싶다면 가장 먼저 해보고 싶은 중요한 일 한 가지를 이 스레드나 채널에 편하게 남겨주세요. 멘션 없이 적어도 돼요. 푹 쉬어도 좋아요!!! :penguin:`;
  return kind === "goal"
    ? `${date} 오늘의 *ONE THING*!!! :seedling: 오늘 최우선순위로 가장 먼저 해결할 중요한 일 한 가지는 무엇인가요? 그 일과 이유를 이 글의 스레드에 남겨주세요. 가장 중요한 일부터 같이 해봅시다 :muscle:`
    : `${date} 오늘 *ONE THING*은 어떠셨나요? :memo: 해낸 만큼, 느낀 점 한 줄을 이 글의 스레드에 남겨주세요. 다 못 했어도 괜찮아요!!! :penguin:`;
}
async function commonText(
  env: CommunityScheduleEnv,
  date: string,
  kind: Kind,
  memberIds: readonly string[],
): Promise<string> {
  const base = await customBotEmoji(env.SLACK_BOT_TOKEN, promptText(date, kind));
  return `${base}${memberIds.length ? `\n${memberIds.map((id) => `<@${id}>`).join(" ")}` : ""}`;
}
export async function runCommunitySchedule(
  env: CommunityScheduleEnv,
  store: ScheduleStore,
  nowDate: Date,
  clock: ScheduleClock = { now: () => nowDate },
): Promise<{ readonly common: number; readonly personal: number }> {
  const scope = {
    teamId: env.SLACK_TEAM_ID,
    channelId: env.COMMUNITY_CHANNEL_ID,
    userId: env.COMMUNITY_ADMIN_ID,
  };
  const now = nowDate.toISOString();
  const observedAt = clock.now().toISOString();
  const local = new Date(nowDate.getTime() + 9 * 60 * 60 * 1000).toISOString();
  const date = local.slice(0, 10);
  const minute = local.slice(11, 16);
  const settings = await store.getRecord({ ...scope, key: "group-schedule" });
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const schedule = settings ? parseSchedule(settings.body) : null;
  const scheduledKinds = (["goal", "review"] as const).filter((kind) => {
    if (!schedule?.enabled) return false;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || (weekday === 6 && kind === "review")) return false;
    const due = weekday === 6 ? "10:00" : kind === "goal" ? schedule.goalTime : schedule.reviewTime;
    const late = minutes(minute) - minutes(due);
    return late >= 0 && late <= 5;
  });
  let snapshot: ChannelMembershipSnapshot | null = null;
  const publicChannel = env.COMMUNITY_PUBLIC_CHANNEL_ID === scope.channelId;
  const targetedDue =
    !isWeekend(date) && publicChannel
      ? await store.reminderTriggerDue(scope.teamId, scope.channelId, now)
      : false;
  if (!isWeekend(date) && publicChannel && (scheduledKinds.length > 0 || targetedDue)) {
    snapshot = await collectCurrentChannelMembers(
      env.SLACK_BOT_TOKEN,
      scope.channelId,
      env.COMMUNITY_BOT_USER_ID ?? "",
      observedAt,
    );
    await store.reconcileChannelMembers(scope, snapshot);
  }
  let common = 0;
  for (const kind of scheduledKinds) {
    const members = snapshot?.eligibleHumanIds ?? [];
    await enqueueCommonDelivery(
      store,
      scope,
      date,
      kind,
      await commonText(env, date, kind, members),
    );
  }
  common += await sendCommonDeliveries({ token: env.SLACK_BOT_TOKEN, now, scope, store });
  if (isWeekend(date) || (publicChannel && !targetedDue)) return { common, personal: 0 };
  const personal = await sendReminderBatches({
    token: env.SLACK_BOT_TOKEN,
    teamId: scope.teamId,
    channelId: scope.channelId,
    now,
    store,
  });
  return { common, personal };
}
