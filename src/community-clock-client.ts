import type { ClockBinding } from "./community-bug-clock-client";
import type { CommunityEnv } from "./community-runtime";
import { InputError } from "./input";

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

export function nextCommunityAlarm(
  times: readonly string[],
  durableDue: string | null,
  now: number,
): number | null {
  const scheduled = nextAlarmTime(times, now);
  if (durableDue === null) return scheduled;
  const parsed = Date.parse(durableDue);
  if (!Number.isFinite(parsed)) throw new InputError("Invalid durable due time");
  return scheduled === null ? parsed : Math.min(scheduled, parsed);
}

export async function armCommunityClock(
  env: CommunityEnv & { readonly COMMUNITY_CLOCK?: ClockBinding },
  channelId: string,
): Promise<{ readonly next: number | null }> {
  if (!env.COMMUNITY_CLOCK) return { next: null };
  return env.COMMUNITY_CLOCK.getByName(`${env.SLACK_TEAM_ID}:${channelId}`).refresh(channelId);
}
