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
import { publishGardenRequest } from "./community-clock-garden";
import { refreshCommunitySchedule } from "./community-clock-schedule";
import { runDueGardenDeliveries } from "./community-garden-delivery";
import { runMembershipDue } from "./community-membership-schedule";
import type { CommunityEnv } from "./community-runtime";
import { runCommunitySchedule } from "./community-scheduler";
import { CommunitySlackError } from "./community-social";
import { CommunityStore } from "./community-store";
import { InputError } from "./input";
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

  armMembershipScan(channelId: string, cursor: string | null): Promise<void> {
    return this.serialize(async () => {
      if (channelId !== this.env.COMMUNITY_PUBLIC_CHANNEL_ID || cursor === "")
        throw new InputError("Invalid membership scan scope");
      const role = await this.ctx.storage.get<string>("role");
      const bound = await this.ctx.storage.get<string>("channel");
      if (role && role !== COMMUNITY_SCHEDULE_CLOCK_ROLE)
        throw new InputError("Clock role cannot change");
      if (bound && bound !== channelId) throw new InputError("Clock channel cannot change");
      await this.ctx.storage.put("role", COMMUNITY_SCHEDULE_CLOCK_ROLE);
      await this.ctx.storage.put("channel", channelId);
      if (cursor === null) await this.ctx.storage.delete("referralReconcileCursor");
      else if (!(await this.ctx.storage.get<string>("referralReconcileCursor")))
        await this.ctx.storage.put("referralReconcileCursor", cursor);
      const due = Date.now() + 1_000;
      const previous = await this.ctx.storage.getAlarm();
      if (previous === null || previous < Date.now() || due < previous)
        await this.ctx.storage.setAlarm(due);
    });
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

  private refreshSchedule(channelId: string): Promise<{ readonly next: number | null }> {
    return refreshCommunitySchedule(this.env, this.ctx.storage, channelId);
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
        const now = new Date(Date.now());
        let scheduleRetry: number | null = null;
        let garden: { readonly processed: number; readonly nextDue: number | null } = {
          processed: 0,
          nextDue: null,
        };
        try {
          garden = await runDueGardenDeliveries(this.env, channelId, now.getTime());
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          console.error(
            JSON.stringify({
              event: "community.clock.queue.failed",
              queue: "garden",
              errorType: error.name,
            }),
          );
          garden = { processed: 0, nextDue: now.getTime() + 60_000 };
        }
        const membership = await runMembershipDue(
          this.env,
          new NeonStore(this.env.DATABASE_URL),
          channelId,
          now.getTime(),
          await this.ctx.storage.get<string>("referralReconcileCursor"),
          await this.ctx.storage.get<string>("interestReconcileCursor"),
        );
        if (membership.nextCursor === null)
          await this.ctx.storage.delete("referralReconcileCursor");
        else await this.ctx.storage.put("referralReconcileCursor", membership.nextCursor);
        if (membership.interestNextCursor === null)
          await this.ctx.storage.delete("interestReconcileCursor");
        else await this.ctx.storage.put("interestReconcileCursor", membership.interestNextCursor);
        if (
          this.env.COMMUNITY_ENABLED === "true" &&
          this.env.COMMUNITY_ADMIN_ID &&
          [this.env.COMMUNITY_CHANNEL_ID, this.env.COMMUNITY_PUBLIC_CHANNEL_ID].includes(channelId)
        ) {
          try {
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
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            console.error(
              JSON.stringify({
                event: "community.clock.queue.failed",
                queue: "reminders",
                errorType: error.name,
              }),
            );
            const retrySeconds =
              error instanceof CommunitySlackError ? (error.retryAfterSeconds ?? 60) : 60;
            scheduleRetry = now.getTime() + Math.min(retrySeconds, 3_600) * 1_000;
          }
        }
        if (scheduleRetry !== null) {
          const current = await this.ctx.storage.getAlarm();
          const candidates = [scheduleRetry, garden.nextDue, membership.nextDue].filter(
            (candidate): candidate is number => candidate !== null,
          );
          const due = Math.max(now.getTime() + 1_000, Math.min(...candidates));
          if (current === null || current <= now.getTime() || due < current)
            await this.ctx.storage.setAlarm(due);
          return;
        }
        await this.refreshSchedule(channelId);
        if (garden.nextDue !== null || garden.processed >= 10 || membership.possiblyMore) {
          const current = await this.ctx.storage.getAlarm();
          const immediate = garden.processed >= 10 || membership.possiblyMore;
          const candidates = [garden.nextDue, membership.nextDue].filter(
            (candidate): candidate is number => candidate !== null,
          );
          const due = immediate
            ? now.getTime() + 1_000
            : candidates.length
              ? Math.min(...candidates)
              : null;
          if (due !== null && (current === null || Math.max(now.getTime() + 1_000, due) < current))
            await this.ctx.storage.setAlarm(Math.max(now.getTime() + 1_000, due));
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
