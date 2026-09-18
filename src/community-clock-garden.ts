import type { GardenRequest } from "./community-bug-clock-client";
import { COMMUNITY_SCHEDULE_CLOCK_ROLE } from "./community-bug-clock-client";
import { publishGardenNow } from "./community-garden";
import { deliverGardenByKey } from "./community-garden-delivery";
import type { CommunityEnv } from "./community-runtime";
import { CommunityStore } from "./community-store";
import { InputError } from "./input";
import { NeonStore } from "./store";

type ClockStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(value: number): Promise<void>;
};

export async function publishGardenRequest(
  env: CommunityEnv,
  storage: ClockStorage,
  input: GardenRequest,
): Promise<string> {
  if (
    env.DATABASE_MAINTENANCE === "true" ||
    ![env.COMMUNITY_CHANNEL_ID, env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(input.channelId) ||
    !/^[UW][A-Z0-9]+$/.test(input.userId) ||
    (input.channelId === env.COMMUNITY_CHANNEL_ID && input.userId !== env.COMMUNITY_ADMIN_ID)
  )
    throw new InputError("Garden scope unavailable");
  const [role, channelId] = await Promise.all([
    storage.get<string>("role"),
    storage.get<string>("channel"),
  ]);
  if (role && role !== COMMUNITY_SCHEDULE_CLOCK_ROLE)
    throw new InputError("Clock role cannot publish a garden");
  if (channelId && channelId !== input.channelId)
    throw new InputError("Clock channel cannot change");
  await storage.put("role", COMMUNITY_SCHEDULE_CLOCK_ROLE);
  await storage.put("channel", input.channelId);
  if (!input.deliveryKey)
    return publishGardenNow(
      {
        env,
        store: new CommunityStore(new NeonStore(env.DATABASE_URL)),
        scope: { teamId: env.SLACK_TEAM_ID, channelId: input.channelId, userId: input.userId },
        date: input.date,
        thread: input.thread,
        source: input.source,
        key: input.key,
      },
      input.date,
      input.undoKey,
    );
  return (
    (await deliverGardenByKey(
      env,
      input.channelId,
      input.deliveryKey,
      Date.now(),
      async (nextDue) => {
        const current = await storage.getAlarm();
        if (current === null || nextDue < current) await storage.setAlarm(nextDue);
      },
    )) ?? input.deliveryKey
  );
}
