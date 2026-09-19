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
import { date, InputError, type Json, object, string } from "./input";
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
  async claimReviewReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly workerId: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid time");
    return reminderBatch(await this.call("claim_review_reminder_batch", input));
  }
  async claimGoalReminderBatch(input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly now: string;
    readonly workerId: string;
    readonly leaseToken: string;
  }): Promise<ReminderBatch | null> {
    if (!Number.isFinite(Date.parse(input.now))) throw new InputError("Invalid time");
    await this.call("due", input);
    return reminderBatch(
      await this.db.queryJson(
        `WITH retry AS (
          SELECT r.reminder_batch_key FROM otl.community_records r
          WHERE r.team_id=$1 AND r.channel_id=$2 AND r.kind='reminder'
            AND r.body->>'kind'='goal' AND r.reminder_attempts<3
            AND r.reminder_batch_key IS NOT NULL
            AND ((r.status='failed' AND coalesce(r.reminder_retry_after,'-infinity')<=$3::timestamptz)
              OR (r.status='claimed' AND r.reminder_lease_expires_at<=$3::timestamptz))
          ORDER BY r.updated_at,r.reminder_batch_key LIMIT 1
        ), candidates AS (
          SELECT r.ctid FROM otl.community_records r
          WHERE r.team_id=$1 AND r.channel_id=$2 AND r.kind='reminder'
            AND r.body->>'kind'='goal' AND r.reminder_attempts<3
            AND ((EXISTS(SELECT 1 FROM retry) AND r.reminder_batch_key=(SELECT reminder_batch_key FROM retry)
                AND r.status IN ('failed','claimed')
                AND coalesce(r.reminder_retry_after,r.reminder_lease_expires_at,'-infinity')<=$3::timestamptz)
              OR (NOT EXISTS(SELECT 1 FROM retry) AND r.status='pending'
                AND r.body->>'date'=($3::timestamptz AT TIME ZONE 'Asia/Seoul')::date::text))
            AND otl.reminder_eligible($1,$2,r.user_id,'goal',$3::timestamptz AT TIME ZONE 'Asia/Seoul')
          ORDER BY r.user_id LIMIT 100
        ), claimed AS (
          UPDATE otl.community_records r SET status='claimed',reminder_attempts=reminder_attempts+1,
            reminder_batch_key=coalesce(r.reminder_batch_key,$4),
            reminder_first_attempt_at=coalesce(reminder_first_attempt_at,$3::timestamptz),
            reminder_lease_token=$4,reminder_lease_expires_at=$3::timestamptz+interval '5 minutes',
            reminder_retry_after=NULL,updated_at=$3::timestamptz
          FROM candidates c WHERE r.ctid=c.ctid RETURNING r.*
        ) SELECT coalesce((SELECT CASE WHEN count(*)=0 THEN NULL ELSE jsonb_build_object(
          'leaseToken',$4,'attempt',max(reminder_attempts),'firstAttemptAt',min(reminder_first_attempt_at),
          'jobs',jsonb_agg(jsonb_build_object('teamId',team_id,'channelId',channel_id,'userId',user_id,
            'key',record_key,'date',body->>'date','kind','goal') ORDER BY user_id)) END FROM claimed),'null'::jsonb)`,
        [input.teamId, input.channelId, input.now, input.leaseToken],
      ),
    );
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
  async finishReviewReminderBatch(
    input: ReminderBatchFinish & { readonly messageTs?: string },
  ): Promise<boolean> {
    return bool(await this.call("finish_review_reminder_batch", input));
  }
  async finishReviewRoot(
    input: CommunityScope & {
      readonly leaseToken: string;
      readonly date: string;
      readonly messageTs: string;
    },
  ): Promise<boolean> {
    date(input.date);
    const finished = JSON.stringify({
      teamId: input.teamId,
      channelId: input.channelId,
      userId: input.userId,
      leaseToken: input.leaseToken,
      status: "sent",
      messageTs: input.messageTs,
    });
    const bound = JSON.stringify({
      teamId: input.teamId,
      channelId: input.channelId,
      userId: input.userId,
      date: input.date,
      messageTs: input.messageTs,
    });
    return (
      (await this.db.queryJson(
        `WITH finished AS MATERIALIZED (
          SELECT otl.community_execute('finish_common_delivery',$1::jsonb) result
        ), bound AS (
          SELECT otl.community_execute('bind_review_root',$2::jsonb) result
          FROM finished WHERE result='true'::jsonb
        ) SELECT to_jsonb(coalesce((SELECT result IS NOT NULL FROM bound),false))`,
        [finished, bound],
      )) === true
    );
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
