import type { ReferralSlackPort } from "./community-referral-types";
import { InputError, object, string } from "./input";
import type { NeonStore } from "./store";

type Kind = "admin_decision" | "request_withdrawn" | "join_observed";
type Claimed = {
  readonly outboxId: number;
  readonly requestId: string;
  readonly effectKey: string;
  readonly kind: Kind;
};

function claimed(value: unknown): Claimed | null {
  if (value === null) return null;
  const row = object(value);
  const kind = row.kind;
  if (kind !== "admin_decision" && kind !== "request_withdrawn" && kind !== "join_observed")
    throw new InputError("Invalid referral notification kind");
  if (typeof row.outboxId !== "number" || !Number.isSafeInteger(row.outboxId))
    throw new InputError("Invalid referral notification ID");
  return {
    outboxId: row.outboxId,
    requestId: string(row.requestId),
    effectKey: string(row.effectKey),
    kind,
  };
}

export async function deliverReferralNotifications(input: {
  readonly db: Pick<NeonStore, "queryJson">;
  readonly teamId: string;
  readonly adminId: string;
  readonly slack: ReferralSlackPort;
  readonly now: number;
}): Promise<{ readonly processed: number; readonly possiblyMore: boolean }> {
  let processed = 0;
  for (; processed < 10; processed += 1) {
    const row = claimed(
      await input.db.queryJson(
        `WITH due AS (
        SELECT outbox_id FROM otl.referral_outbox
        WHERE team_id=$1 AND effect_type IN ('admin_decision','request_withdrawn','join_observed')
          AND status IN ('pending','failed','claimed') AND available_at<=$2::timestamptz
        ORDER BY available_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE otl.referral_outbox o SET status='claimed',attempts=attempts+1,
          available_at=$2::timestamptz+interval '5 minutes'
        FROM due WHERE o.outbox_id=due.outbox_id AND o.team_id=$1 RETURNING o.*
      ) SELECT CASE WHEN c.outbox_id IS NULL THEN NULL ELSE jsonb_build_object(
        'outboxId',c.outbox_id,'requestId',c.request_id,'effectKey',c.effect_key,
        'kind',c.effect_type) END FROM (SELECT 1) seed LEFT JOIN claimed c ON true`,
        [input.teamId, new Date(input.now).toISOString()],
      ),
    );
    if (!row) break;
    let status: "sent" | "failed" = "sent";
    try {
      const text =
        row.kind === "admin_decision"
          ? "가입 신청 결정이 기록됐습니다."
          : row.kind === "request_withdrawn"
            ? "가입 신청이 철회됐습니다."
            : "승인된 신청의 Slack 가입이 확인됐습니다.";
      await input.slack.postAdmin({
        adminId: input.adminId,
        effectKey: row.effectKey,
        requestId: row.requestId,
        text,
        blocks: [],
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      status = "failed";
    }
    await input.db.queryJson(
      `WITH changed AS (UPDATE otl.referral_outbox SET status=$3,
        available_at=CASE WHEN $3='failed' THEN $4::timestamptz+interval '5 minutes' ELSE available_at END
        WHERE team_id=$1 AND outbox_id=$2 AND status='claimed' RETURNING 1)
       SELECT to_jsonb(EXISTS(SELECT 1 FROM changed))`,
      [input.teamId, String(row.outboxId), status, new Date(input.now).toISOString()],
    );
  }
  return { processed, possiblyMore: processed === 10 };
}
