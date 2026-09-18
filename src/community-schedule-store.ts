import { commonDelivery, reminderBatch, snapshotPayload } from "./community-reminder-store";
import type {
  ChannelMembershipSnapshot,
  CommonDelivery,
  CommunityRecord,
  CommunityScope,
  GroupSchedule,
  MemberJoinObservation,
  PreferencePatch,
  RecordKey,
  ReminderBatch,
  ReminderBatchFinish,
  SupportPreferences,
} from "./community-types";
import { InputError, type Json, object, string } from "./input";
import type { NeonStore } from "./store";

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InputError("Boolean required");
  return value;
}
function scope(value: unknown): CommunityScope {
  const input = object(value);
  return {
    teamId: string(input.teamId),
    channelId: string(input.channelId),
    userId: string(input.userId),
  };
}
function time(value: unknown): string {
  const result = string(value);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result))
    throw new InputError("시간은 HH:MM으로 입력해 주세요.");
  return result;
}
function preferences(value: unknown): SupportPreferences {
  const input = object(value);
  if (input.timezone !== "Asia/Seoul") throw new InputError("Invalid timezone");
  return {
    ...scope(input),
    enabled: bool(input.enabled),
    goalTime: time(input.goalTime),
    reviewTime: time(input.reviewTime),
    timezone: input.timezone,
  };
}
export function parseCommunityRecord(value: Json): CommunityRecord | null {
  if (value === null) return null;
  const input = object(value);
  const body = Object.entries(value).find(([key]) => key === "body")?.[1] ?? null;
  return {
    ...scope(input),
    key: string(input.key),
    kind: string(input.kind),
    status: string(input.status),
    body,
  };
}

export class CommunityScheduleStore {
  constructor(protected readonly db: Pick<NeonStore, "queryJson">) {}
  protected call(operation: string, payload: Json): Promise<Json> {
    return this.db.queryJson("SELECT otl.community_execute($1,$2::jsonb)", [
      operation,
      JSON.stringify(payload),
    ]);
  }
  async enrollReminders(input: CommunityScope): Promise<SupportPreferences> {
    return preferences(await this.call("enroll_reminders", input));
  }
  async preferences(
    input: CommunityScope,
    patch: PreferencePatch = {},
  ): Promise<SupportPreferences> {
    if (patch.goalTime !== undefined) time(patch.goalTime);
    if (patch.reviewTime !== undefined) time(patch.reviewTime);
    return preferences(await this.call("preferences", { ...input, ...patch }));
  }
  async putRecord(input: Omit<CommunityRecord, "status">): Promise<CommunityRecord> {
    const result = parseCommunityRecord(await this.call("put_record", input));
    if (!result) throw new InputError("Record missing");
    return result;
  }
  async setGroupSchedule(input: CommunityScope, settings: GroupSchedule): Promise<CommunityRecord> {
    time(settings.goalTime);
    time(settings.reviewTime);
    const result = parseCommunityRecord(
      await this.call("set_group_schedule", { ...input, ...settings }),
    );
    if (!result) throw new InputError("Schedule missing");
    return result;
  }
  async getRecord(input: RecordKey): Promise<CommunityRecord | null> {
    return parseCommunityRecord(await this.call("get_record", input));
  }
  async claimRecord(input: RecordKey): Promise<boolean> {
    return bool(await this.call("claim_record", input));
  }
  async finishRecord(input: RecordKey, status: "sent" | "failed" | "cancelled"): Promise<boolean> {
    return bool(await this.call("finish_record", { ...input, status }));
  }
  async reminderTriggerDue(teamId: string, channelId: string, now: string): Promise<boolean> {
    if (!Number.isFinite(Date.parse(now))) throw new InputError("Invalid time");
    return bool(await this.call("reminder_trigger_due", { teamId, channelId, now }));
  }
  async reconcileChannelMembers(
    input: CommunityScope,
    snapshot: ChannelMembershipSnapshot,
  ): Promise<boolean> {
    return bool(
      await this.call("reconcile_channel_members", { ...input, ...snapshotPayload(snapshot) }),
    );
  }
  async observeMemberJoin(input: MemberJoinObservation): Promise<boolean> {
    if (!Number.isFinite(Date.parse(input.observedAt))) throw new InputError("Invalid time");
    return bool(await this.call("observe_member_join", input));
  }
  async claimReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly workerId: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid time");
    return reminderBatch(await this.call("claim_reminder_batch", input));
  }
  async pruneReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid time");
    return reminderBatch(await this.call("prune_reminder_batch", input));
  }
  async finishReminderBatch(input: ReminderBatchFinish): Promise<boolean> {
    return bool(await this.call("finish_reminder_batch", input));
  }
  async claimCommonDelivery(
    input: CommunityScope & { readonly now: string; readonly leaseToken: string },
  ): Promise<CommonDelivery | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid time");
    return commonDelivery(await this.call("claim_common_delivery", input));
  }
  async finishCommonDelivery(
    input: CommunityScope & {
      readonly leaseToken: string;
      readonly status: "sent" | "failed";
      readonly messageTs?: string;
      readonly errorCode?: string;
      readonly retryAfterSeconds?: number;
    },
  ): Promise<boolean> {
    return bool(await this.call("finish_common_delivery", input));
  }
  async nextScheduleDue(teamId: string, channelId: string, now: string): Promise<string | null> {
    if (!Number.isFinite(Date.parse(now))) throw new InputError("Invalid time");
    const value = await this.call("next_schedule_due", { teamId, channelId, now });
    return value === null ? null : string(value);
  }
}
