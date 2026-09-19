import { CommunityLifecycleRuntimeStore } from "./community-lifecycle-runtime-store";
import { nextInvitePrivateReconciliationDue } from "./community-referral-reconcile";
import { nextRetentionDue } from "./community-retention-schedule";
import type { CommunityEnv } from "./community-runtime";
import { InputError, string } from "./input";
import type { NeonStore } from "./store";

function millis(value: string | null): number | null {
  if (value === null) return null;
  const due = Date.parse(value);
  if (!Number.isFinite(due)) throw new InputError("Invalid membership due time");
  return due;
}

function earliest(...values: readonly (number | null)[]): number | null {
  const due = values.filter((value): value is number => value !== null);
  return due.length ? Math.min(...due) : null;
}

export async function nextMembershipDue(
  env: CommunityEnv,
  db: NeonStore,
  channelId: string,
  now = Date.now(),
): Promise<number | null> {
  if (channelId !== env.COMMUNITY_PUBLIC_CHANNEL_ID || env.DATABASE_MAINTENANCE === "true")
    return null;
  const lifecycle =
    env.LIFECYCLE_MODE === "enforce"
      ? millis(await new CommunityLifecycleRuntimeStore(db).nextDue(env.SLACK_TEAM_ID))
      : null;
  const deadlineRaw =
    env.LIFECYCLE_MODE === "enforce"
      ? await db.queryJson(
          `SELECT to_jsonb(min(grace_deadline::timestamp AT TIME ZONE 'Asia/Seoul'))
       FROM otl.member_lifecycles WHERE team_id=$1 AND state='grace'`,
          [env.SLACK_TEAM_ID],
        )
      : null;
  const deadline = millis(deadlineRaw === null ? null : string(deadlineRaw));
  const localDay = Math.floor((now + 9 * 60 * 60_000) / 86_400_000);
  const nextServiceDay = (localDay + 1) * 86_400_000 - 9 * 60 * 60_000 + 60_000;
  const referralRaw =
    env.REFERRALS_ENABLED === "true"
      ? await db.queryJson(
          `SELECT coalesce(to_jsonb(min(due_at)), 'null'::jsonb) FROM (
        SELECT available_at AS due_at
        FROM otl.referral_outbox WHERE team_id=$1
          AND status IN ('pending','failed','claimed')
        UNION ALL
        SELECT coalesce(p.purge_retry_at,r.payload_purge_after) FROM otl.referral_private_payloads p
          JOIN otl.referral_requests r USING(team_id,request_id)
          WHERE p.team_id=$1 AND p.purge_status IN ('pending','failed','claimed')
      ) due`,
          [env.SLACK_TEAM_ID],
        )
      : null;
  const referral = millis(referralRaw === null ? null : string(referralRaw));
  const marker =
    env.REFERRALS_ENABLED === "true" && env.INVITE_PRIVATE_OBJECTS && env.SITE_CORE_HMAC_SECRET
      ? millis(await nextInvitePrivateReconciliationDue(env))
      : null;
  const retention =
    env.REFERRALS_ENABLED === "true" ? await nextRetentionDue(db, env.SLACK_TEAM_ID, now) : null;
  return earliest(
    lifecycle,
    deadline,
    referral,
    marker,
    retention,
    env.LIFECYCLE_MODE === "disabled" || env.LIFECYCLE_MODE === undefined ? null : nextServiceDay,
  );
}

export async function nextGardenDue(
  db: NeonStore,
  teamId: string,
  channelId: string,
  includeRetirements: boolean,
): Promise<number | null> {
  const raw = await db.queryJson(
    `SELECT coalesce(to_jsonb(min(due_at)), 'null'::jsonb) FROM (
      SELECT CASE WHEN status='claimed' THEN lease_expires_at
        ELSE coalesce(retry_after,created_at) END AS due_at
      FROM otl.community_garden_deliveries
      WHERE team_id=$1 AND channel_id=$2 AND status IN ('pending','failed','claimed') AND attempts<3
      UNION ALL
      SELECT CASE WHEN status IN ('claimed','restore_claimed') THEN lease_expires_at
        ELSE coalesce(retry_after,created_at) END
      FROM otl.community_garden_retirements
      WHERE team_id=$1 AND channel_id=$2 AND $3::boolean
        AND status IN ('pending','failed','claimed','restore_claimed')
        AND attempts<3
    ) due`,
    [teamId, channelId, String(includeRetirements)],
  );
  return millis(raw === null ? null : string(raw));
}
