import { CommunityScheduleStore, parseCommunityRecord } from "./community-schedule-store";
import type {
  ChangeResult,
  CommunityDay,
  CommunityRecord,
  CommunityScope,
  DayChange,
  DayScope,
  MemberIntroduction,
  Outcome,
} from "./community-types";
import { date, InputError, type Json, list, object, string } from "./input";

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

export class CommunityStore extends CommunityScheduleStore {
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
      const result = parseCommunityRecord(value);
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
      ...(typeof v.gardenDeliveryKey === "string"
        ? { gardenDeliveryKey: v.gardenDeliveryKey }
        : {}),
    };
  }
}
