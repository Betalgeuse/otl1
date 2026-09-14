import type {
  ChangeResult,
  CommunityDay,
  CommunityRecord,
  CommunityScope,
  DayChange,
  DayScope,
  GroupSchedule,
  Outcome,
  PreferencePatch,
  RecordKey,
  ReminderJob,
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

export class CommunityStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}
  private call(operation: string, payload: Json): Promise<Json> {
    return this.db.queryJson("SELECT otl.community_execute($1,$2::jsonb)", [
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
  async due(teamId: string, channelId: string, now: string): Promise<readonly ReminderJob[]> {
    if (!Number.isFinite(Date.parse(now))) throw new InputError("Invalid time");
    return list(await this.call("due", { teamId, channelId, now })).map((item) => {
      const v = object(item);
      if (v.kind !== "goal" && v.kind !== "review") throw new InputError("Invalid reminder kind");
      return { ...scope(v), key: string(v.key), date: date(v.date), kind: v.kind };
    });
  }
  async claimReminder(input: RecordKey, now = new Date().toISOString()): Promise<boolean> {
    if (!Number.isFinite(Date.parse(now))) throw new InputError("Invalid time");
    return bool(await this.call("claim_reminder", { ...input, now }));
  }
  async finishReminder(
    input: RecordKey,
    status: "sent" | "failed" | "cancelled",
  ): Promise<boolean> {
    return this.finishRecord(input, status);
  }
}
