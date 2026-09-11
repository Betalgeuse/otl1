import { DurableObject } from "cloudflare:workers";
import type { CommunityEnv } from "./community-runtime";
import { runCommunitySchedule } from "./community-scheduler";
import { CommunityStore } from "./community-store";
import { InputError, object, string } from "./input";
import { NeonStore } from "./store";

type LastRun = {
  readonly at: number;
  readonly common?: number;
  readonly personal?: number;
  readonly failure?: string;
};
type ClockInspection = { readonly next: number | null; readonly lastRun: LastRun | null };
export interface ClockBinding {
  getByName(name: string): {
    refresh(channelId: string): Promise<{ readonly next: number | null }>;
    inspect(): Promise<ClockInspection>;
  };
}

export function nextAlarmTime(times: readonly string[], now: number): number | null {
  if (!Number.isFinite(now)) throw new InputError("Invalid clock time");
  const offset = 9 * 60 * 60 * 1000;
  const midnight = Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
  let next: number | null = null;
  for (const time of new Set(times)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new InputError("Invalid schedule time");
    const candidate = midnight + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60_000;
    const future = candidate > now ? candidate : candidate + 86_400_000;
    next = next === null ? future : Math.min(next, future);
  }
  return next;
}

export async function armCommunityClock(
  env: CommunityEnv & { readonly COMMUNITY_CLOCK?: ClockBinding },
  channelId: string,
): Promise<{ readonly next: number | null }> {
  if (!env.COMMUNITY_CLOCK) return { next: null };
  return env.COMMUNITY_CLOCK.getByName(`${env.SLACK_TEAM_ID}:${channelId}`).refresh(channelId);
}

export class CommunityClock extends DurableObject<CommunityEnv> {
  private queue: Promise<void> = Promise.resolve();

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  refresh(channelId: string): Promise<{ readonly next: number | null }> {
    return this.serialize(() => this.refreshSchedule(channelId));
  }

  private async refreshSchedule(channelId: string): Promise<{ readonly next: number | null }> {
    if (this.env.DATABASE_MAINTENANCE === "true") throw new InputError("Database maintenance");
    if (
      ![this.env.COMMUNITY_CHANNEL_ID, this.env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(channelId) ||
      !channelId
    )
      throw new InputError("Channel is outside clock scope");
    const previousChannel = await this.ctx.storage.get<string>("channel");
    if (previousChannel && previousChannel !== channelId)
      throw new InputError("Clock channel cannot change");
    await this.ctx.storage.put("channel", channelId);
    if (this.env.COMMUNITY_ENABLED !== "true" || !this.env.COMMUNITY_ADMIN_ID) {
      await this.ctx.storage.deleteAlarm();
      return { next: null };
    }
    const store = new CommunityStore(new NeonStore(this.env.DATABASE_URL));
    const scope = {
      teamId: this.env.SLACK_TEAM_ID,
      channelId,
      userId: this.env.COMMUNITY_ADMIN_ID,
    };
    const [settings, members] = await Promise.all([
      store.getRecord({ ...scope, key: "group-schedule" }),
      store.members(scope.teamId, channelId),
    ]);
    const times: string[] = [];
    if (settings) {
      const body = object(settings.body);
      if (body.enabled === true) times.push(string(body.goalTime), string(body.reviewTime));
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
    const next = nextAlarmTime(times, Date.now());
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    return { next };
  }

  async inspect(): Promise<ClockInspection> {
    return {
      next: await this.ctx.storage.getAlarm(),
      lastRun: (await this.ctx.storage.get<LastRun>("lastRun")) ?? null,
    };
  }

  alarm(): Promise<void> {
    return this.serialize(async () => {
      if (this.env.DATABASE_MAINTENANCE === "true") {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
      const channelId = await this.ctx.storage.get<string>("channel");
      if (!channelId) return;
      try {
        const now = new Date();
        if (
          this.env.COMMUNITY_ENABLED === "true" &&
          this.env.COMMUNITY_ADMIN_ID &&
          [this.env.COMMUNITY_CHANNEL_ID, this.env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(channelId)
        ) {
          const result = await runCommunitySchedule(
            {
              ...this.env,
              COMMUNITY_CHANNEL_ID: channelId,
              COMMUNITY_ADMIN_ID: this.env.COMMUNITY_ADMIN_ID,
            },
            new CommunityStore(new NeonStore(this.env.DATABASE_URL)),
            now,
          );
          await this.ctx.storage.put("lastRun", { at: now.getTime(), ...result });
        }
        await this.refreshSchedule(channelId);
      } catch (error) {
        await this.ctx.storage.put("lastRun", {
          at: Date.now(),
          failure: error instanceof Error ? error.name : "UnknownError",
        });
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    });
  }
}
