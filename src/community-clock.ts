import { DurableObject } from "cloudflare:workers";
import {
  BUG_DELIVERY_CLOCK_ROLE,
  type BugDeliveryArm,
  type BugDeliveryArmResult,
  type ClockInspection,
  COMMUNITY_SCHEDULE_CLOCK_ROLE,
  type GardenRequest,
} from "./community-bug-clock-client";
import {
  nextBugClockAlarm,
  readBugClockState,
  runBugDeliveryClockAlarm,
} from "./community-clock-bug";
import { nextCommunityAlarm } from "./community-clock-client";
import { publishGardenRequest } from "./community-clock-garden";
import { runDueGardenDeliveries } from "./community-garden-delivery";
import type { CommunityEnv } from "./community-runtime";
import { runCommunitySchedule } from "./community-scheduler";
import { CommunitySlackError } from "./community-social";
import { CommunityStore } from "./community-store";
import { InputError, object, string } from "./input";
import { NeonStore } from "./store";

export { armBugDeliveryClock, bugDeliveryClockName } from "./community-bug-clock-client";

export { armCommunityClock, nextAlarmTime } from "./community-clock-client";

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

  publishGarden(input: GardenRequest): Promise<string> {
    return this.serialize(() => publishGardenRequest(this.env, this.ctx.storage, input));
  }

  refresh(channelId: string): Promise<{ readonly next: number | null }> {
    return this.serialize(() => this.refreshSchedule(channelId));
  }

  armBugDelivery(input: BugDeliveryArm): Promise<BugDeliveryArmResult> {
    return this.serialize(async () => {
      if (
        !Number.isFinite(input.observedAt) ||
        (input.reason === "due" && !Number.isFinite(input.nextDue))
      )
        throw new InputError("Invalid clock time");
      const [role, channelId] = await Promise.all([
        this.ctx.storage.get<string>("role"),
        this.ctx.storage.get<string>("channel"),
      ]);
      if (role && role !== BUG_DELIVERY_CLOCK_ROLE)
        throw new InputError("Clock role cannot change");
      if (channelId) throw new InputError("Clock channel scope cannot become global");
      await this.ctx.storage.put("role", BUG_DELIVERY_CLOCK_ROLE);
      const state = await readBugClockState(this.ctx.storage, input.observedAt);
      await this.ctx.storage.put("bugSafetyDue", state.safetyDue);
      if (input.reason === "activity") {
        const activityDue = input.observedAt + 5 * 60 * 1_000;
        await this.ctx.storage.put(
          "bugActivityDue",
          Math.min(state.activityDue ?? activityDue, activityDue),
        );
      }
      if (input.reason === "due")
        await this.ctx.storage.put(
          "bugNextDue",
          Math.min(state.nextDue ?? input.nextDue, input.nextDue),
        );
      const desired = nextBugClockAlarm(
        await readBugClockState(this.ctx.storage, input.observedAt),
      );
      const alarmAt = Math.max(input.observedAt + 1_000, desired);
      const previous = await this.ctx.storage.getAlarm();
      if (previous === null || previous <= input.observedAt || alarmAt < previous)
        await this.ctx.storage.setAlarm(alarmAt);
      return {
        role: BUG_DELIVERY_CLOCK_ROLE,
        armed: true,
        next: await this.ctx.storage.getAlarm(),
      };
    });
  }

  private async refreshSchedule(channelId: string): Promise<{ readonly next: number | null }> {
    if (this.env.DATABASE_MAINTENANCE === "true") throw new InputError("Database maintenance");
    if (
      ![this.env.COMMUNITY_CHANNEL_ID, this.env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(channelId) ||
      !channelId
    )
      throw new InputError("Channel is outside clock scope");
    const [role, previousChannel] = await Promise.all([
      this.ctx.storage.get<string>("role"),
      this.ctx.storage.get<string>("channel"),
    ]);
    if (role && role !== COMMUNITY_SCHEDULE_CLOCK_ROLE)
      throw new InputError("Clock role cannot change");
    if (previousChannel && previousChannel !== channelId)
      throw new InputError("Clock channel cannot change");
    await this.ctx.storage.put("role", COMMUNITY_SCHEDULE_CLOCK_ROLE);
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
    const observedNow = Date.now();
    const [settings, members, deliveryDue] = await Promise.all([
      store.getRecord({ ...scope, key: "group-schedule" }),
      store.members(scope.teamId, channelId),
      store.nextScheduleDue(scope.teamId, channelId, new Date(observedNow).toISOString()),
    ]);
    const times: string[] = [];
    if (settings) {
      const body = object(settings.body);
      if (body.enabled === true)
        times.push("10:00", string(body.goalTime), string(body.reviewTime));
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
    const next = nextCommunityAlarm(times, deliveryDue, observedNow);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    return { next };
  }

  async inspect(): Promise<ClockInspection> {
    return {
      next: await this.ctx.storage.getAlarm(),
      role: (await this.ctx.storage.get<string>("role")) ?? null,
      lastRun: (await this.ctx.storage.get<Readonly<Record<string, unknown>>>("lastRun")) ?? null,
    };
  }

  alarm(): Promise<void> {
    return this.serialize(async () => {
      const role = await this.ctx.storage.get<string>("role");
      const channelId = await this.ctx.storage.get<string>("channel");
      if (role === BUG_DELIVERY_CLOCK_ROLE) {
        if (channelId) throw new InputError("Global clock has a channel collision");
        await runBugDeliveryClockAlarm(this.env, this.ctx.storage, Date.now());
        return;
      }
      if (role && role !== COMMUNITY_SCHEDULE_CLOCK_ROLE)
        throw new InputError("Unsupported clock role");
      if (this.env.DATABASE_MAINTENANCE === "true") {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
      if (!channelId) return;
      if (!role) await this.ctx.storage.put("role", COMMUNITY_SCHEDULE_CLOCK_ROLE);
      try {
        const now = new Date();
        const garden = await runDueGardenDeliveries(this.env, channelId, now.getTime());
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
        if (garden.nextDue !== null) {
          const current = await this.ctx.storage.getAlarm();
          if (current === null || garden.nextDue < current)
            await this.ctx.storage.setAlarm(garden.nextDue);
        }
      } catch (error) {
        await this.ctx.storage.put("lastRun", {
          at: Date.now(),
          failure: error instanceof Error ? error.name : "UnknownError",
        });
        const retrySeconds =
          error instanceof CommunitySlackError ? (error.retryAfterSeconds ?? 60) : 60;
        await this.ctx.storage.setAlarm(Date.now() + Math.min(retrySeconds, 3_600) * 1_000);
      }
    });
  }
}
