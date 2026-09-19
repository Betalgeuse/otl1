import { runInterestDue } from "./community-interest-due";
import { reconcileInterestIntake } from "./community-interest-reconcile";
import { deliverInviteAdminReview } from "./community-invite-admin";
import { deliverLifecycleNotices } from "./community-lifecycle-delivery";
import { runLifecycleMaintenance } from "./community-lifecycle-runtime";
import { CommunityLifecycleRuntimeStore } from "./community-lifecycle-runtime-store";
import { nextMembershipDue } from "./community-membership-due";
import { deliverReferralNotifications } from "./community-referral-notifications";
import { reconcileInvitePrivateIntake } from "./community-referral-reconcile";
import { referralSlackPort } from "./community-referral-slack";
import { CommunityReferralStore } from "./community-referral-store";
import { runRetentionQueues } from "./community-retention-schedule";
import type { CommunityEnv } from "./community-runtime";
import { InputError, object, string } from "./input";
import type { NeonStore } from "./store";

const BATCH = 10;

function serviceDate(now: number): string {
  return new Date(now + 9 * 60 * 60_000 - 86_400_000).toISOString().slice(0, 10);
}

export async function runMembershipDue(
  env: CommunityEnv,
  db: NeonStore,
  channelId: string,
  now: number,
  cursor?: string,
  interestCursor?: string,
): Promise<{
  readonly possiblyMore: boolean;
  readonly nextDue: number | null;
  readonly nextCursor: string | null;
  readonly interestNextCursor: string | null;
}> {
  if (channelId !== env.COMMUNITY_PUBLIC_CHANNEL_ID || env.DATABASE_MAINTENANCE === "true")
    return { possiblyMore: false, nextDue: null, nextCursor: null, interestNextCursor: null };
  let possiblyMore = false;
  let nextCursor: string | null = cursor ?? null;
  let interestNextCursor: string | null = interestCursor ?? null;
  let failed = false;
  async function attempt(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed = true;
      console.error(
        JSON.stringify({
          event: "community.membership.queue.failed",
          queue: name,
          errorType: error.name,
        }),
      );
    }
  }
  if (env.LIFECYCLE_MODE === "shadow" || env.LIFECYCLE_MODE === "enforce") {
    await attempt("lifecycle", async () => {
      if (env.LIFECYCLE_MODE === "enforce" && !env.LIFECYCLE_ACTION_SECRET)
        throw new InputError("Lifecycle action secret missing");
      const day = serviceDate(now);
      const complete = await db.queryJson(
        `SELECT to_jsonb(EXISTS(SELECT 1 FROM otl.community_records r
        JOIN otl.workspace_channels c ON c.team_id=r.team_id AND c.channel_id=r.channel_id
        WHERE r.team_id=$1 AND r.channel_id=$2 AND r.kind='dispatch' AND r.status='sent'
          AND r.body->>'date'=$3 AND r.body->>'kind'='goal'
          AND (c.complete_membership_observed_at AT TIME ZONE 'Asia/Seoul')::date=$3::date))`,
        [env.SLACK_TEAM_ID, channelId, day],
      );
      const lifecycleStore = new CommunityLifecycleRuntimeStore(db);
      const result = await runLifecycleMaintenance({
        store: lifecycleStore,
        teamId: env.SLACK_TEAM_ID,
        channelId,
        token: env.SLACK_BOT_TOKEN,
        signingSecret: env.LIFECYCLE_ACTION_SECRET ?? "",
        mode: env.LIFECYCLE_MODE,
        maintenance: false,
        serviceHealthComplete: complete === true,
        serviceDate: day,
        now,
      });
      possiblyMore ||= result.possiblyMore;
      if (complete !== true && env.LIFECYCLE_MODE === "enforce") {
        const reconciliation = await lifecycleStore.reconcile({
          teamId: env.SLACK_TEAM_ID,
          now: new Date(now).toISOString(),
          limit: BATCH,
        });
        const delivery = await deliverLifecycleNotices({
          store: lifecycleStore,
          teamId: env.SLACK_TEAM_ID,
          token: env.SLACK_BOT_TOKEN,
          signingSecret: env.LIFECYCLE_ACTION_SECRET ?? "",
          now,
        });
        possiblyMore ||= reconciliation.possiblyMore || delivery.possiblyMore;
      }
    });
  }
  if (env.REFERRALS_ENABLED === "true") {
    const referral = new CommunityReferralStore(db, {
      teamId: env.SLACK_TEAM_ID,
      channelId,
      userId: env.COMMUNITY_ADMIN_ID ?? "",
    });
    if (env.COMMUNITY_ADMIN_ID && env.INVITE_PRIVATE_OBJECTS && env.INVITE_PRIVATE_KEK) {
      await attempt("referral_admin", async () => {
        const slack = referralSlackPort(env);
        for (let i = 0; i < BATCH; i += 1) {
          if (!(await deliverInviteAdminReview(env, referral, slack, now))) break;
          if (i === BATCH - 1) possiblyMore = true;
        }
      });
    }
    if (env.COMMUNITY_ADMIN_ID) {
      await attempt("referral_notifications", async () => {
        const result = await deliverReferralNotifications({
          db,
          teamId: env.SLACK_TEAM_ID,
          adminId: env.COMMUNITY_ADMIN_ID ?? "",
          slack: referralSlackPort(env),
          now,
        });
        possiblyMore ||= result.possiblyMore;
      });
    }
    if (env.INVITE_PRIVATE_OBJECTS && env.SITE_CORE_HMAC_SECRET) {
      await attempt("referral_reconcile", async () => {
        const reconciled = await reconcileInvitePrivateIntake(env, referral, now, cursor);
        possiblyMore ||= reconciled.possiblyMore;
        nextCursor = reconciled.nextCursor;
      });
    }
    const retention = await runRetentionQueues(db, env.SLACK_TEAM_ID, now);
    possiblyMore ||= retention.possiblyMore;
    failed ||= retention.failed;
    const bucket = env.INVITE_PRIVATE_OBJECTS;
    if (bucket) {
      await attempt("referral_purge", async () => {
        for (let i = 0; i < BATCH; i += 1) {
          const raw = await db.queryJson(
            "SELECT otl.referral_runtime_execute('claim_purge',$1::jsonb)",
            [JSON.stringify({ teamId: env.SLACK_TEAM_ID, now: new Date(now).toISOString() })],
          );
          if (raw === null) break;
          const claimed = object(raw);
          const requestId = string(claimed.requestId);
          const claimKey = string(claimed.claimKey);
          let status: "purged" | "failed" = "purged";
          try {
            await bucket.delete(string(claimed.opaqueRef));
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            status = "failed";
          }
          await db.queryJson("SELECT otl.referral_runtime_execute('finish_purge',$1::jsonb)", [
            JSON.stringify({
              teamId: env.SLACK_TEAM_ID,
              requestId,
              key: claimKey,
              status,
              now: new Date(now).toISOString(),
            }),
          ]);
          if (i === BATCH - 1) possiblyMore = true;
        }
      });
    }
  }
  if (env.PUBLIC_INTEREST_ENABLED === "true") {
    await attempt("interest", async () => {
      const result = await runInterestDue(env, now);
      possiblyMore ||= result.possiblyMore;
    });
    await attempt("interest_reconcile", async () => {
      const result = await reconcileInterestIntake(env, now, interestCursor);
      possiblyMore ||= result.possiblyMore;
      interestNextCursor = result.nextCursor;
    });
  }
  let nextDue: number | null = null;
  await attempt("next_due", async () => {
    nextDue = await nextMembershipDue(env, db, channelId, now);
  });
  return {
    possiblyMore,
    nextDue: failed ? Math.min(nextDue ?? now + 60_000, now + 60_000) : nextDue,
    nextCursor,
    interestNextCursor,
  };
}
