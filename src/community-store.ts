import { reminderBatch, snapshotPayload } from "./community-reminder-store";
import type {
  ChangeResult,
  ChannelMembershipSnapshot,
  CommunityDay,
  CommunityRecord,
  CommunityScope,
  DayChange,
  DayScope,
  GroupSchedule,
  MemberIntroduction,
  Outcome,
  PreferencePatch,
  RecordKey,
  ReminderBatch,
  ReminderBatchFinish,
  SupportPreferences,
} from "./community-types";
import { date, InputError, type Json, list, object, string } from "./input";
import type { NeonStore } from "./store";

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InputError("Boolean required");
  return value;
}
function scope(value: unknown): CommunityScope {
  const v = object(value);
  return { teamId: string(v.teamId), channelId: string(v.channelId), userId: string(v.userId) };
}
function outcome(value: unknown): Outcome {
  switch (value) {
    case "pending":
    case "complete":
    case "partial":
    case "not_done":
      return value;
    default:
      throw new InputError("Invalid outcome");
  }
}
function day(value: unknown): CommunityDay {
  const v = object(value);
  if (typeof v.revision !== "number" || !Number.isSafeInteger(v.revision))
    throw new InputError("Invalid revision");
  return {
    ...scope(v),
    date: date(v.date),
    goal: string(v.goal),
    outcome: outcome(v.outcome),
    reflection: string(v.reflection),
    resting: bool(v.resting),
    revision: v.revision,
  };
}
function time(value: unknown): string {
  const result = string(value);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result))
    throw new InputError("시간은 HH:MM으로 입력해 주세요.");
  return result;
}
function preferences(value: unknown): SupportPreferences {
  const v = object(value);
  if (v.timezone !== "Asia/Seoul") throw new InputError("Invalid timezone");
  return {
    ...scope(v),
    enabled: bool(v.enabled),
    goalTime: time(v.goalTime),
    reviewTime: time(v.reviewTime),
    timezone: v.timezone,
  };
}
function record(value: Json): CommunityRecord | null {
  if (value === null) return null;
  const v = object(value);
  const body = Object.entries(value).find(([key]) => key === "body")?.[1] ?? null;
  return { ...scope(v), key: string(v.key), kind: string(v.kind), status: string(v.status), body };
}

function introduction(value: unknown): MemberIntroduction | null {
  if (value === null) return null;
  const v = object(value);
  if (typeof v.revision !== "number" || !Number.isSafeInteger(v.revision))
    throw new InputError("Invalid introduction revision");
  return {
    teamId: string(v.teamId),
    userId: string(v.userId),
    intro: string(v.intro),
    linkedin: v.linkedin === null ? null : string(v.linkedin),
    details: v.details === null ? null : string(v.details),
    channelId: v.channelId === null ? null : string(v.channelId),
    messageTs: v.messageTs === null ? null : string(v.messageTs),
    revision: v.revision,
  };
}

export class CommunityStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}
  private call(operation: string, payload: Json): Promise<Json> {
    return this.db.queryJson("SELECT otl.community_execute($1,$2::jsonb)", [
      operation,
      JSON.stringify(payload),
    ]);
  }
  private introductionCall(operation: string, payload: Json): Promise<Json> {
    return this.db.queryJson("SELECT otl.introduction_execute($1,$2::jsonb)", [
      operation,
      JSON.stringify(payload),
    ]);
  }
  async day(input: DayScope): Promise<CommunityDay> {
    date(input.date);
    return day(await this.call("day", input));
  }
  async listDays(
    teamId: string,
    channelId: string,
    forDate: string,
  ): Promise<readonly CommunityDay[]> {
    date(forDate);
    return list(await this.call("list_days", { teamId, channelId, date: forDate })).map(day);
  }
  async members(teamId: string, channelId: string): Promise<readonly string[]> {
    return list(await this.call("members", { teamId, channelId })).map(string);
  }
  async history(input: CommunityScope): Promise<readonly CommunityDay[]> {
    return list(await this.call("history", input)).map(day);
  }
  async listRecords(input: CommunityScope, kind: string): Promise<readonly CommunityRecord[]> {
    const values = await this.call("list_records", { ...input, kind });
    if (!Array.isArray(values)) throw new InputError("Record list required");
    return values.map((value: Json) => {
      const result = record(value);
      if (!result) throw new InputError("Record missing");
      return result;
    });
  }
  async introduction(teamId: string, userId: string): Promise<MemberIntroduction | null> {
    return introduction(await this.introductionCall("get", { teamId, userId }));
  }
  async introductions(teamId: string): Promise<readonly MemberIntroduction[]> {
    return list(await this.introductionCall("list", { teamId })).map((value) => {
      const result = introduction(value);
      if (!result) throw new InputError("Introduction missing");
      return result;
    });
  }
  async prepareIntroduction(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly intro: string;
    readonly linkedin: string | null;
    readonly details: string | null;
    readonly expectedRevision: number;
    readonly token: string;
  }): Promise<MemberIntroduction | null> {
    return introduction(await this.introductionCall("prepare", input));
  }
  async finishIntroduction(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly token: string;
    readonly channelId: string;
    readonly messageTs: string;
  }): Promise<MemberIntroduction | null> {
    return introduction(await this.introductionCall("finish", input));
  }
  async abortIntroduction(teamId: string, userId: string, token: string): Promise<boolean> {
    return bool(await this.introductionCall("abort", { teamId, userId, token }));
  }
  async change(input: DayChange): Promise<ChangeResult> {
    date(input.date);
    if (input.action === "goal" && (!input.text?.trim() || [...input.text].length > 200))
      throw new InputError("ONE THING은 1~200자로 적어 주세요.");
    if (input.action === "reflection" && (!input.text?.trim() || [...input.text].length > 2000))
      throw new InputError("후기는 1~2000자로 적어 주세요.");
    const v = object(await this.call("change", input));
    return {
      day: day(v.day),
      changed: bool(v.changed),
      conflict: bool(v.conflict),
      firstGoal: bool(v.firstGoal),
      firstRegistration: v.firstRegistration === true,
      firstReflection: bool(v.firstReflection),
      undoKey: string(v.undoKey),
    };
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
    const result = record(await this.call("put_record", input));
    if (!result) throw new InputError("Record missing");
    return result;
  }
  async setGroupSchedule(input: CommunityScope, settings: GroupSchedule): Promise<CommunityRecord> {
    time(settings.goalTime);
    time(settings.reviewTime);
    const result = record(await this.call("set_group_schedule", { ...input, ...settings }));
    if (!result) throw new InputError("Schedule missing");
    return result;
  }
  async getRecord(input: RecordKey): Promise<CommunityRecord | null> {
    return record(await this.call("get_record", input));
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
  async finishReminderBatch(input: ReminderBatchFinish): Promise<boolean> {
    return bool(await this.call("finish_reminder_batch", input));
  }
}
