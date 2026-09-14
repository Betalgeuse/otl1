import { isWeekend } from "./calendar";
import { customBotEmoji } from "./community-emoji";
import { CommunitySlackError, callSlack } from "./community-social";
import type { CommunityStore } from "./community-store";
import type { CommunityScope, ReminderJob } from "./community-types";
import { InputError, object, string } from "./input";

export type CommunityScheduleEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly SLACK_BOT_TOKEN: string;
  readonly COMMUNITY_CHANNEL_ID: string;
  readonly COMMUNITY_ADMIN_ID: string;
};
type ScheduleStore = Pick<
  CommunityStore,
  | "getRecord"
  | "putRecord"
  | "claimRecord"
  | "finishRecord"
  | "due"
  | "claimReminder"
  | "finishReminder"
  | "day"
  | "preferences"
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
async function commonPrompt(
  env: CommunityScheduleEnv,
  store: ScheduleStore,
  scope: CommunityScope,
  date: string,
  kind: Kind,
): Promise<boolean> {
  const dispatch = { ...scope, key: `common:${date}:${kind}` };
  await store.putRecord({ ...dispatch, kind: "dispatch", body: { date, kind } });
  if (!(await store.claimRecord(dispatch))) return false;
  try {
    const response = await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: scope.channelId,
      text: `${await customBotEmoji(env.SLACK_BOT_TOKEN, promptText(date, kind))}${isWeekend(date) ? "" : " <!channel>"}`,
    });
    const ts = string(response.ts);
    if (!/^\d+\.\d+$/.test(ts)) throw new InputError("Slack timestamp missing");
    await store.putRecord({ ...scope, key: `prompt:${ts}`, kind: "prompt", body: { date, kind } });
    await store.putRecord({
      ...scope,
      key: `common-thread:${date}:${kind}`,
      kind: "prompt",
      body: { date, kind, ts },
    });
    await store.finishRecord(dispatch, "sent");
    return true;
  } catch (error) {
    if (error instanceof CommunitySlackError || error instanceof InputError) {
      await store.finishRecord(dispatch, "failed");
    }
    throw error;
  }
}
async function personalReminder(
  env: CommunityScheduleEnv,
  store: ScheduleStore,
  scope: CommunityScope,
  job: ReminderJob,
  nowDate: Date,
): Promise<boolean> {
  const minute = new Date(nowDate.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
  if (minute < "08:00" || minute >= "22:00") return false;
  if (!(await store.claimReminder(job, nowDate.toISOString()))) return false;
  const [day, prefs] = await Promise.all([store.day(job), store.preferences(job)]);
  const eligible =
    prefs.enabled &&
    !day.resting &&
    (job.kind === "goal" ? day.goal === "" : day.goal !== "" && day.reflection === "");
  if (!eligible) {
    await store.finishReminder(job, "cancelled");
    return false;
  }
  const thread = await store.getRecord({ ...scope, key: `common-thread:${job.date}:${job.kind}` });
  const ts = thread ? object(thread.body).ts : undefined;
  const text = await customBotEmoji(
    env.SLACK_BOT_TOKEN,
    job.kind === "goal"
      ? `<@${job.userId}> 오늘 최우선순위로 가장 먼저 해결할 중요한 일 한 가지를 여기 남겨볼까요? 중요한 일부터 시작해봐요!!! :seedling:`
      : `<@${job.userId}> 오늘 *ONE THING*은 어떠셨나요? 해낸 만큼 후기 한 줄 남겨주세요!!! :memo: 오늘 쉬실 거라면 그렇게 말해주셔도 돼요.`,
  );
  try {
    await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: job.channelId,
      ...(typeof ts === "string" ? { thread_ts: ts } : {}),
      text: `${text}\n개인 안내를 끄려면 “알림 설정”이라고 남겨주세요.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${text}\n개인 안내를 끄려면 “알림 설정”이라고 남겨주세요.`,
          },
        },
      ],
    });
    await store.finishReminder(job, "sent");
    return true;
  } catch (error) {
    if (error instanceof CommunitySlackError) await store.finishReminder(job, "failed");
    throw error;
  }
}

export async function runCommunitySchedule(
  env: CommunityScheduleEnv,
  store: ScheduleStore,
  nowDate: Date,
): Promise<{ readonly common: number; readonly personal: number }> {
  const scope = {
    teamId: env.SLACK_TEAM_ID,
    channelId: env.COMMUNITY_CHANNEL_ID,
    userId: env.COMMUNITY_ADMIN_ID,
  };
  const local = new Date(nowDate.getTime() + 9 * 60 * 60 * 1000).toISOString();
  const date = local.slice(0, 10);
  const minute = local.slice(11, 16);
  let common = 0;
  let personal = 0;
  const settings = await store.getRecord({ ...scope, key: "group-schedule" });
  if (settings) {
    const schedule = parseSchedule(settings.body);
    if (schedule.enabled) {
      for (const kind of ["goal", "review"] as const) {
        if (isWeekend(date) && kind === "review") continue;
        const due = kind === "goal" ? schedule.goalTime : schedule.reviewTime;
        const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
        const late = minutes(minute) - minutes(due);
        if (late >= 0 && late <= 5 && (await commonPrompt(env, store, scope, date, kind))) common++;
      }
    }
  }
  if (isWeekend(date)) return { common, personal };
  for (const job of await store.due(scope.teamId, scope.channelId, nowDate.toISOString())) {
    if (job.teamId !== scope.teamId || job.channelId !== scope.channelId || job.date !== date)
      continue;
    if (await personalReminder(env, store, scope, job, nowDate)) personal++;
  }
  return { common, personal };
}
