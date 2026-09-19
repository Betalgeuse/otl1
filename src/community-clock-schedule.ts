import { COMMUNITY_SCHEDULE_CLOCK_ROLE } from "./community-bug-clock-client";
import { nextCommunityAlarm } from "./community-clock-client";
import { nextGardenDue, nextMembershipDue } from "./community-membership-due";
import type { CommunityEnv } from "./community-runtime";
import { CommunityStore } from "./community-store";
import { InputError, object, string } from "./input";
import { NeonStore } from "./store";

export async function refreshCommunitySchedule(
  env: CommunityEnv,
  storage: DurableObjectStorage,
  channelId: string,
): Promise<{ readonly next: number | null }> {
  if (env.DATABASE_MAINTENANCE === "true") throw new InputError("Database maintenance");
  if (
    ![env.COMMUNITY_CHANNEL_ID, env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(channelId) ||
    !channelId
  )
    throw new InputError("Channel is outside clock scope");
  const [role, previousChannel] = await Promise.all([
    storage.get<string>("role"),
    storage.get<string>("channel"),
  ]);
  if (role && role !== COMMUNITY_SCHEDULE_CLOCK_ROLE)
    throw new InputError("Clock role cannot change");
  if (previousChannel && previousChannel !== channelId)
    throw new InputError("Clock channel cannot change");
  await storage.put("role", COMMUNITY_SCHEDULE_CLOCK_ROLE);
  await storage.put("channel", channelId);
  if (env.COMMUNITY_ENABLED !== "true" || !env.COMMUNITY_ADMIN_ID) {
    await storage.deleteAlarm();
    return { next: null };
  }
  const store = new CommunityStore(new NeonStore(env.DATABASE_URL));
  const scope = {
    teamId: env.SLACK_TEAM_ID,
    channelId,
    userId: env.COMMUNITY_ADMIN_ID,
  };
  const observedNow = Date.now();
  const [settings, members, deliveryDue, gardenDue, membershipDue] = await Promise.all([
    store.getRecord({ ...scope, key: "group-schedule" }),
    store.members(scope.teamId, channelId),
    store.nextScheduleDue(scope.teamId, channelId, new Date(observedNow).toISOString()),
    nextGardenDue(
      new NeonStore(env.DATABASE_URL),
      scope.teamId,
      channelId,
      env.GARDEN_RECONCILIATION === "true",
    ),
    nextMembershipDue(env, new NeonStore(env.DATABASE_URL), channelId),
  ]);
  const times: string[] = [];
  if (settings) {
    const body = object(settings.body);
    if (body.enabled === true) times.push("10:00", string(body.goalTime), string(body.reviewTime));
  }
  for (let start = 0; start < members.length; start += 10) {
    const preferences = await Promise.all(
      members.slice(start, start + 10).map((userId) => store.preferences({ ...scope, userId })),
    );
    for (const preference of preferences) {
      if (preference.enabled)
        times.push(
          ...[preference.goalTime, preference.reviewTime].filter(
            (time) => time >= "08:00" && time < "22:00",
          ),
        );
    }
  }
  const next = nextCommunityAlarm(
    times,
    [
      deliveryDue,
      gardenDue === null ? null : new Date(gardenDue).toISOString(),
      membershipDue === null ? null : new Date(membershipDue).toISOString(),
    ]
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null,
    observedNow,
  );
  if (next === null) await storage.deleteAlarm();
  else {
    const alarmAt = Math.max(observedNow + 1_000, next);
    const previous = await storage.getAlarm();
    await storage.setAlarm(
      previous !== null && previous > observedNow ? Math.min(previous, alarmAt) : alarmAt,
    );
  }
  return { next: await storage.getAlarm() };
}
