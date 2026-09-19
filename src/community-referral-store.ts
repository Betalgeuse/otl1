import type {
  InviteAdminAction,
  InviteAdminDecision,
  InviteAdminReview,
  ReferralReceipt,
  ReferralRuntimeStore,
  ReferralSubmit,
  ReferralWithdrawal,
} from "./community-referral-types";
import { InputError, type Json, object, string } from "./input";
import type { NeonStore } from "./store";

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InputError("Invalid referral integer");
  return value;
}

function boolean(value: Json): boolean {
  if (typeof value !== "boolean") throw new InputError("Invalid referral boolean");
  return value;
}

function receipt(value: Json): ReferralReceipt {
  const input = object(value);
  return {
    kind: "receipt",
    receiptId: string(input.receiptId),
    state: string(input.state),
    revision: integer(input.revision),
    requestId: string(input.requestId),
  };
}

function adminResult(value: Json) {
  const input = object(value);
  return {
    receiptId: string(input.receiptId),
    state: string(input.state),
    revision: integer(input.revision),
  };
}

function review(value: Json): InviteAdminReview | null {
  if (value === null) return null;
  const input = object(value);
  return {
    outboxId: integer(input.outboxId),
    effectKey: string(input.effectKey),
    requestId: string(input.requestId),
    revision: integer(input.revision),
    privateRef: {
      requestId: string(input.requestId),
      revision: integer(input.revision),
      opaqueRef: string(input.opaqueRef),
      objectDigest: string(input.objectDigest),
      envelopeDek: string(input.envelopeDek),
      keyVersion: string(input.keyVersion),
      nonce: string(input.nonce),
      schemaVersion: "invite-application.v1",
    },
  };
}

export class CommunityReferralStore implements ReferralRuntimeStore {
  constructor(
    private readonly db: Pick<NeonStore, "queryJson">,
    private readonly nonceScope: {
      readonly teamId: string;
      readonly channelId: string;
      readonly userId: string;
    },
  ) {}

  async claimServiceNonce(digest: string, expiresAt: string): Promise<boolean> {
    return boolean(
      await this.db.queryJson(
        `WITH claimed AS (
          INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status)
          VALUES($1,$2,$3,'referral-service-nonce:'||$4,'referral_service_nonce',
            jsonb_build_object('expiresAt',$5::text),'sent')
          ON CONFLICT(team_id,channel_id,user_id,record_key) DO NOTHING RETURNING 1)
        SELECT to_jsonb(EXISTS(SELECT 1 FROM claimed))`,
        [
          this.nonceScope.teamId,
          this.nonceScope.channelId,
          this.nonceScope.userId,
          digest,
          expiresAt,
        ],
      ),
    );
  }

  async resolveLink(teamId: string, tokenDigest: string): Promise<boolean> {
    const result = object(
      await this.db.queryJson("SELECT otl.referral_runtime_execute('resolve',$1::jsonb)", [
        JSON.stringify({ teamId, tokenDigest }),
      ]),
    );
    return result.available === true;
  }

  async findSubmission(teamId: string, submissionKey: string): Promise<ReferralReceipt | null> {
    const value = await this.db.queryJson(
      `SELECT CASE WHEN r.request_id IS NULL THEN NULL ELSE
        otl.referral_receipt(r)||jsonb_build_object('requestId',r.request_id) END
      FROM (SELECT 1) seed
      LEFT JOIN otl.referral_submission_receipts s
        ON s.team_id=$1 AND s.submission_key=$2
      LEFT JOIN otl.referral_requests r
        ON r.team_id=s.team_id AND r.request_id=s.request_id`,
      [teamId, submissionKey],
    );
    return value === null ? null : receipt(value);
  }

  async findPrivateIntake(
    teamId: string,
    requestId: string,
    objectDigest: string,
  ): Promise<"adopted" | "absent" | "conflict"> {
    const value = await this.db.queryJson(
      `SELECT to_jsonb(CASE
        WHEN EXISTS(SELECT 1 FROM otl.referral_private_payloads
          WHERE team_id=$1 AND request_id=$2 AND object_digest=$3) THEN 'adopted'
        WHEN EXISTS(SELECT 1 FROM otl.referral_private_payloads
          WHERE team_id=$1 AND (request_id=$2 OR object_digest=$3)) THEN 'conflict'
        ELSE 'absent' END)`,
      [teamId, requestId, objectDigest],
    );
    if (value === "adopted" || value === "absent" || value === "conflict") return value;
    throw new InputError("Invalid private intake state");
  }

  async issueLink(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly linkId: string;
    readonly tokenDigest: string;
    readonly now: string;
  }): Promise<
    | {
        readonly kind: "issued";
        readonly linkId: string;
        readonly created: boolean;
        readonly remaining: number;
      }
    | { readonly kind: "unavailable" }
  > {
    const value = object(
      await this.db.queryJson("SELECT otl.referral_runtime_execute('issue',$1::jsonb)", [
        JSON.stringify(input),
      ]),
    );
    if (value.kind === "unavailable") return { kind: "unavailable" };
    return {
      kind: "issued",
      linkId: string(value.linkId),
      created: value.created === true,
      remaining: integer(value.remaining),
    };
  }

  async submit(input: ReferralSubmit): Promise<ReferralReceipt | { readonly kind: "rejected" }> {
    const payload = {
      teamId: input.teamId,
      tokenDigest: input.tokenDigest,
      emailDigest: input.emailDigest,
      requestId: input.requestId,
      receiptId: input.receiptId,
      withdrawalDigest: input.withdrawalDigest,
      consentVersion: input.consentVersion,
      consentedAt: input.consentedAt,
      key: input.key,
      now: input.now,
      ...input.privateRef,
    };
    await this.db.queryJson("SELECT otl.referral_runtime_execute('submit',$1::jsonb)", [
      JSON.stringify(payload),
    ]);
    const stored = await this.findSubmission(input.teamId, input.key);
    if (!stored) throw new InputError("Referral submission receipt missing");
    return stored;
  }

  async withdraw(
    input: ReferralWithdrawal,
  ): Promise<ReferralReceipt | { readonly kind: "rejected" }> {
    try {
      return receipt(
        await this.db.queryJson("SELECT otl.referral_runtime_execute('withdraw',$1::jsonb)", [
          JSON.stringify(input),
        ]),
      );
    } catch (error) {
      if (error instanceof Error) return { kind: "rejected" };
      throw error;
    }
  }

  async claimAdminReview(now: string): Promise<InviteAdminReview | null> {
    return review(
      await this.db.queryJson(
        `WITH due AS (
          SELECT o.outbox_id FROM otl.referral_outbox o
          WHERE o.team_id=$2 AND o.effect_type='admin_review'
            AND (o.status IN ('pending','failed') OR (o.status='claimed' AND o.available_at<=$1::timestamptz))
            AND o.available_at<=$1::timestamptz
          ORDER BY o.available_at,o.outbox_id FOR UPDATE SKIP LOCKED LIMIT 1),
        claimed AS (
          UPDATE otl.referral_outbox o SET status='claimed',attempts=attempts+1,
            available_at=$1::timestamptz+interval '5 minutes'
          FROM due WHERE o.outbox_id=due.outbox_id AND o.team_id=$2 RETURNING o.*)
        SELECT CASE WHEN c.outbox_id IS NULL THEN NULL ELSE jsonb_build_object(
          'outboxId',c.outbox_id,'effectKey',c.effect_key,'requestId',c.request_id,
          'revision',r.revision,'opaqueRef',p.opaque_ref,'objectDigest',p.object_digest,
          'envelopeDek',p.envelope_dek,'nonce',p.nonce,'keyVersion',p.key_version) END
        FROM (SELECT 1) seed LEFT JOIN claimed c ON true
        LEFT JOIN otl.referral_requests r USING(team_id,request_id)
        LEFT JOIN otl.referral_private_payloads p USING(team_id,request_id)`,
        [now, this.nonceScope.teamId],
      ),
    );
  }

  async finishOutbox(input: {
    readonly outboxId: number;
    readonly status: "sent" | "failed";
    readonly now: string;
  }): Promise<boolean> {
    return boolean(
      await this.db.queryJson(
        `WITH changed AS (
          UPDATE otl.referral_outbox SET status=$2,
            available_at=CASE WHEN $2='failed' THEN $3::timestamptz+interval '5 minutes' ELSE available_at END
          WHERE outbox_id=$1 AND team_id=$4 AND status='claimed' RETURNING 1)
        SELECT to_jsonb(EXISTS(SELECT 1 FROM changed))`,
        [String(input.outboxId), input.status, input.now, this.nonceScope.teamId],
      ),
    );
  }

  async decide(input: InviteAdminDecision) {
    return adminResult(
      await this.db.queryJson("SELECT otl.referral_admin_execute('decide',$1::jsonb)", [
        JSON.stringify(input),
      ]),
    );
  }

  async markInvited(input: InviteAdminAction) {
    const result = adminResult(
      await this.db.queryJson("SELECT otl.referral_admin_execute('mark_invited',$1::jsonb)", [
        JSON.stringify(input),
      ]),
    );
    return { ...result, manualInviteAsserted: true as const, deliveryProven: false as const };
  }

  async observeJoinedMember(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly isBot: boolean;
    readonly isApp: boolean;
    readonly deleted: boolean;
    readonly observedAt: string;
  }): Promise<void> {
    await this.db.queryJson(
      `WITH workspace AS (
        INSERT INTO otl.workspaces(team_id) VALUES($1) ON CONFLICT DO NOTHING)
      INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted,directory_synced_at)
      VALUES($1,$2,$3::boolean,$4::boolean,$5::boolean,$6::timestamptz)
      ON CONFLICT(team_id,user_id) DO UPDATE SET is_bot=excluded.is_bot,
        is_app_user=excluded.is_app_user,slack_deleted=excluded.slack_deleted,
        directory_synced_at=excluded.directory_synced_at
      RETURNING jsonb_build_object('observed',true)`,
      [
        input.teamId,
        input.userId,
        String(input.isBot),
        String(input.isApp),
        String(input.deleted),
        input.observedAt,
      ],
    );
  }

  async attributeJoin(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly emailDigest: string;
    readonly eventId: string;
    readonly now: string;
  }): Promise<{ readonly kind: "attributed" | "unmatched"; readonly receiptId?: string }> {
    const value = await this.db.queryJson(
      `SELECT CASE WHEN EXISTS(
        SELECT 1 FROM otl.referral_requests r
        JOIN otl.referral_manual_invite_assertions a USING(team_id,request_id)
        WHERE r.team_id=$2 AND r.email_digest=$3 AND r.state='approved')
      THEN otl.referral_runtime_execute('attribute_join',$1::jsonb) ELSE NULL END`,
      [JSON.stringify(input), input.teamId, input.emailDigest],
    );
    if (value === null) return { kind: "unmatched" };
    return { kind: "attributed", receiptId: string(object(value).receiptId) };
  }
}
