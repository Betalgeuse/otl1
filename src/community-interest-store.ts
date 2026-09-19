import type {
  InterestAdminAction,
  InterestAttach,
  InterestMemberConfirmation,
  InterestOfflineEvidence,
  InterestReceipt,
  InterestSubmit,
  InterestWithdraw,
} from "./community-interest-types";
import { InputError, type Json, object, string } from "./input";
import type { NeonStore } from "./store";

function receipt(value: Json): InterestReceipt {
  const data = object(value);
  if (data.accepted !== true) throw new InputError("Interest receipt unavailable");
  return {
    receiptId: string(data.receiptId),
    accepted: true,
    created: data.created === true,
    sameSubmissionKey: data.sameSubmissionKey === true,
  };
}

export class CommunityInterestStore {
  constructor(private readonly db: Pick<NeonStore, "queryJson">) {}

  async submit(input: InterestSubmit): Promise<InterestReceipt> {
    return receipt(
      await this.db.queryJson("SELECT otl.interest_runtime_execute('submit',$1::jsonb)", [
        JSON.stringify({ ...input, ...input.privateRef }),
      ]),
    );
  }

  async withdraw(input: InterestWithdraw): Promise<InterestReceipt> {
    return receipt(
      await this.db.queryJson("SELECT otl.interest_runtime_execute('withdraw',$1::jsonb)", [
        JSON.stringify(input),
      ]),
    );
  }

  async findSubmission(teamId: string, key: string): Promise<InterestReceipt | null> {
    const value = await this.db.queryJson(
      "SELECT otl.interest_runtime_execute('find_submission',$1::jsonb)",
      [JSON.stringify({ teamId, key })],
    );
    return value === null ? null : receipt(value);
  }

  async findPrivateIntake(
    teamId: string,
    interestId: string,
    objectDigest: string,
  ): Promise<"adopted" | "absent" | "conflict"> {
    const value = await this.db.queryJson(
      "SELECT otl.interest_runtime_execute('find_private_intake',$1::jsonb)",
      [JSON.stringify({ teamId, interestId, objectDigest })],
    );
    if (value === "adopted" || value === "absent" || value === "conflict") return value;
    throw new InputError("Invalid interest private state");
  }

  async requestIntroduction(input: InterestAdminAction): Promise<Json> {
    return this.admin("request_introduction", input);
  }

  async verifyOffline(input: InterestOfflineEvidence): Promise<Json> {
    return this.admin("verify_offline", input);
  }

  async attach(input: InterestAttach): Promise<Json> {
    return this.admin("attach", input);
  }

  async decline(input: InterestAdminAction): Promise<Json> {
    return this.admin("decline", input);
  }

  async confirmMember(input: InterestMemberConfirmation): Promise<Json> {
    return this.db.queryJson("SELECT otl.interest_member_confirm($1::jsonb)", [
      JSON.stringify(input),
    ]);
  }

  async claimDelivery(
    teamId: string,
    adminId: string,
    now: string,
    claimKey: string,
  ): Promise<Json> {
    return this.delivery("claim", { teamId, adminId, now, claimKey });
  }

  async finishDelivery(input: {
    readonly teamId: string;
    readonly adminId: string;
    readonly now: string;
    readonly claimKey: string;
    readonly outboxId: number;
    readonly status: "sent" | "failed";
  }): Promise<Json> {
    return this.delivery("finish", input);
  }

  async expireDue(teamId: string, now: string, limit = 10): Promise<Json> {
    return this.retention("expire_due", { teamId, now, limit });
  }

  async claimPurge(teamId: string, now: string, key: string): Promise<Json> {
    return this.retention("claim_purge", { teamId, now, key });
  }

  async finishPurge(input: {
    readonly teamId: string;
    readonly now: string;
    readonly key: string;
    readonly interestId: string;
    readonly status: "purged" | "failed";
  }): Promise<Json> {
    return this.retention("finish_purge", input);
  }

  async auditRetention(teamId: string, now: string, limit = 10): Promise<Json> {
    return this.retention("audit_retention", { teamId, now, limit });
  }

  private admin(
    op: string,
    input: InterestAdminAction | InterestOfflineEvidence | InterestAttach,
  ): Promise<Json> {
    return this.db.queryJson("SELECT otl.interest_admin_execute($1,$2::jsonb)", [
      op,
      JSON.stringify(input),
    ]);
  }

  private delivery(op: string, input: object): Promise<Json> {
    return this.db.queryJson("SELECT otl.interest_delivery_execute($1,$2::jsonb)", [
      op,
      JSON.stringify(input),
    ]);
  }

  private retention(op: string, input: object): Promise<Json> {
    return this.db.queryJson("SELECT otl.interest_retention_execute($1,$2::jsonb)", [
      op,
      JSON.stringify(input),
    ]);
  }
}
