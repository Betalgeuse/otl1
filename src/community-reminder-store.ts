import type {
  ChannelMembershipSnapshot,
  CommonDelivery,
  ReminderBatch,
  ReminderJob,
} from "./community-types";
import { date, InputError, list, object, string } from "./input";

function reminderJob(value: unknown): ReminderJob {
  const item = object(value);
  if (item.kind !== "goal" && item.kind !== "review") throw new InputError("Invalid reminder kind");
  return {
    teamId: string(item.teamId),
    channelId: string(item.channelId),
    userId: string(item.userId),
    key: string(item.key),
    date: date(item.date),
    kind: item.kind,
  };
}

export function reminderBatch(value: unknown): ReminderBatch | null {
  if (value === null) return null;
  const input = object(value);
  if (typeof input.attempt !== "number" || !Number.isSafeInteger(input.attempt))
    throw new InputError("Invalid reminder batch attempt");
  const firstAttemptAt = string(input.firstAttemptAt);
  if (!Number.isFinite(Date.parse(firstAttemptAt)))
    throw new InputError("Invalid reminder first attempt");
  return {
    leaseToken: string(input.leaseToken),
    attempt: input.attempt,
    firstAttemptAt,
    jobs: list(input.jobs).map(reminderJob),
  };
}

export function commonDelivery(value: unknown): CommonDelivery | null {
  if (value === null) return null;
  const input = object(value);
  if (typeof input.attempt !== "number" || !Number.isSafeInteger(input.attempt))
    throw new InputError("Invalid common delivery attempt");
  const firstAttemptAt = string(input.firstAttemptAt);
  if (!Number.isFinite(Date.parse(firstAttemptAt)))
    throw new InputError("Invalid common delivery first attempt");
  if (input.kind !== "goal" && input.kind !== "review")
    throw new InputError("Invalid common delivery kind");
  return {
    leaseToken: string(input.leaseToken),
    attempt: input.attempt,
    firstAttemptAt,
    key: string(input.key),
    text: string(input.text),
    date: date(input.date),
    kind: input.kind,
  };
}

export function snapshotPayload(
  snapshot: ChannelMembershipSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    observedAt: snapshot.observedAt,
    complete: true,
    members: snapshot.members.map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      isBot: member.isBot,
      isAppUser: member.isAppUser,
      deleted: member.deleted,
    })),
  };
}
