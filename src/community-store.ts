import { CommunityScheduleStore, parseCommunityRecord } from "./community-schedule-store";
import type {
  ChangeResult,
  CommunityDay,
  CommunityRecord,
  CommunityScope,
  DayChange,
  DayScope,
  GardenSeason,
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
    confirmedName: v.confirmedName === null ? null : string(v.confirmedName),
    intro: string(v.intro),
    linkedin: v.linkedin === null ? null : string(v.linkedin),
    details: v.details === null ? null : string(v.details),
    channelId: v.channelId === null ? null : string(v.channelId),
    messageTs: v.messageTs === null ? null : string(v.messageTs),
    revision: v.revision,
  };
}

function gardenSeason(value: Json): GardenSeason | null {
  if (value === null) return null;
  const input = object(value);
  if (typeof input.seasonId !== "number" || !Number.isSafeInteger(input.seasonId))
    throw new InputError("Invalid garden season");
  return {
    seasonId: input.seasonId,
    openedOn: date(input.openedOn),
    closedOn: input.closedOn === null ? null : date(input.closedOn),
    days: list(input.days).map(day),
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
  async lifecycleEligibility(input: CommunityScope): Promise<{
    readonly state: "active" | "grace" | "dormant";
    readonly revision: number | null;
  }> {
    const value = object(await this.call("lifecycle_eligibility", input));
    const state = string(value.state);
    if (state !== "active" && state !== "grace" && state !== "dormant")
      throw new InputError("Invalid lifecycle eligibility");
    const revision = value.revision;
    if (
      revision !== null &&
      (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    )
      throw new InputError("Invalid lifecycle revision");
    return { state, revision };
  }
  async history(input: CommunityScope): Promise<readonly CommunityDay[]> {
    return list(await this.call("history", input)).map(day);
  }
  async seasonHistory(input: CommunityScope, seasonId?: number): Promise<GardenSeason | null> {
    if (seasonId !== undefined && (!Number.isSafeInteger(seasonId) || seasonId < 1))
      throw new InputError("Invalid garden season");
    return gardenSeason(
      await this.db.queryJson(
        `SELECT coalesce((SELECT jsonb_build_object(
          'seasonId',s.season_id,'openedOn',s.opened_on,'closedOn',s.closed_on,
          'days',coalesce((SELECT jsonb_agg(otl.community_day_json(d) ORDER BY d.day)
            FROM otl.community_days d WHERE d.team_id=s.team_id AND d.channel_id=s.channel_id
              AND d.user_id=s.user_id AND d.day>=s.opened_on
              AND (s.closed_on IS NULL OR d.day<=s.closed_on)),'[]'::jsonb))
          FROM otl.grass_seasons s WHERE s.team_id=$1 AND s.channel_id=$2 AND s.user_id=$3
            AND (nullif($4,'') IS NULL OR s.season_id=nullif($4,'')::bigint)
            AND (nullif($4,'') IS NOT NULL OR s.closed_at IS NULL)
          ORDER BY s.season_id DESC LIMIT 1),'null'::jsonb)`,
        [
          input.teamId,
          input.channelId,
          input.userId,
          seasonId === undefined ? "" : String(seasonId),
        ],
      ),
    );
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
  async introductionNameInput(teamId: string, userId: string): Promise<string | null> {
    const value = await this.introductionCall("name_input", { teamId, userId });
    return value === null ? null : string(value);
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
    readonly confirmedName: string;
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
    const { delivery, reviewThreadV2, ...change } = input;
    const v = object(await this.call("change", change));
    let returnTransition: ChangeResult["returnTransition"];
    if (v.returnTransition !== undefined) {
      const transition = object(v.returnTransition);
      if (transition.kind !== "welcome_back") throw new InputError("Invalid return transition");
      const lifecycleRevision = transition.lifecycleRevision;
      const seasonId = transition.seasonId;
      if (
        typeof lifecycleRevision !== "number" ||
        typeof seasonId !== "number" ||
        !Number.isSafeInteger(lifecycleRevision) ||
        !Number.isSafeInteger(seasonId)
      )
        throw new InputError("Invalid return transition revision");
      returnTransition = {
        kind: "welcome_back",
        lifecycleRevision,
        seasonId,
        effectKey: string(transition.effectKey),
      };
    }
    const result: ChangeResult = {
      day: day(v.day),
      changed: bool(v.changed),
      conflict: bool(v.conflict),
      firstGoal: bool(v.firstGoal),
      firstRegistration: v.firstRegistration === true,
      firstReflection: bool(v.firstReflection),
      undoKey: string(v.undoKey),
      ...(returnTransition ? { returnTransition } : {}),
    };
    if (!result.changed || result.conflict || delivery === undefined || reviewThreadV2 !== true)
      return result;
    const season = await this.seasonHistory(input);
    if (!season || result.day.date < season.openedOn) return result;
    if (
      change.action !== "goal" &&
      result.day.outcome === "pending" &&
      result.day.reflection === ""
    )
      return result;
    const route =
      change.action === "goal" ? "route_member_goal_garden" : "route_member_review_garden";
    const routed = await this.db.queryJson(`SELECT otl.${route}($1::jsonb)`, [
      JSON.stringify({
        teamId: input.teamId,
        channelId: input.channelId,
        userId: input.userId,
        date: result.day.date,
        sourceTs: delivery.source,
        threadTs: delivery.thread,
      }),
    ]);
    if (routed === null) return result;
    return { ...result, gardenDeliveryKey: string(object(routed).deliveryKey) };
  }
}
