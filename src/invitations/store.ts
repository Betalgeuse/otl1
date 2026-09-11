import { object, string } from "../input";
import { NeonStore, StoreError } from "../store";

export type MemberStatus = {
  readonly admitted: boolean;
  readonly founder: boolean;
  readonly remaining: number;
  readonly month: string;
  readonly invitedBy: string | null;
};
export type IssueStatus = "issued" | "existing" | "used" | "quota_used" | "month_changed";
export type RedeemStatus = "joined" | "already_joined" | "invalid" | "wrong_recipient" | "expired";

export interface InvitationStore {
  member(workspace: string, user: string): Promise<MemberStatus>;
  issue(
    identity: { readonly workspace: string; readonly user: string; readonly month: string },
    proof: { readonly emailHash: string; readonly tokenHash: string },
  ): Promise<{ readonly status: IssueStatus; readonly expiresAt: string | null }>;
  redeem(
    identity: { readonly workspace: string; readonly user: string },
    proof: { readonly emailHash: string; readonly tokenHash: string },
  ): Promise<RedeemStatus>;
  check(
    identity: { readonly workspace: string; readonly user: string },
    emailHash: string,
  ): Promise<{
    readonly valid: boolean;
    readonly inviterId: string | null;
    readonly expiresAt: string | null;
  }>;
}

export class NeonInvitations implements InvitationStore {
  private readonly db: NeonStore;
  constructor(connectionString: string) {
    this.db = new NeonStore(connectionString);
  }

  async member(workspace: string, user: string): Promise<MemberStatus> {
    const result = object(
      await this.db.queryJson("SELECT otl.member_status($1,$2)", [workspace, user], 1200),
    );
    if (
      typeof result.admitted !== "boolean" ||
      typeof result.founder !== "boolean" ||
      (result.remaining !== 0 && result.remaining !== 1) ||
      typeof result.month !== "string" ||
      !/^\d{4}-\d{2}$/.test(result.month)
    )
      throw new StoreError("response");
    return {
      admitted: result.admitted,
      founder: result.founder,
      remaining: result.remaining,
      month: result.month,
      invitedBy: nullableString(result.invitedBy),
    };
  }

  async issue(
    identity: { readonly workspace: string; readonly user: string; readonly month: string },
    proof: { readonly emailHash: string; readonly tokenHash: string },
  ): Promise<{ readonly status: IssueStatus; readonly expiresAt: string | null }> {
    const result = object(
      await this.db.queryJson("SELECT otl.issue_invite($1,$2,$3,$4,$5)", [
        identity.workspace,
        identity.user,
        proof.emailHash,
        proof.tokenHash,
        identity.month,
      ]),
    );
    const status = result.status;
    if (
      status !== "issued" &&
      status !== "existing" &&
      status !== "used" &&
      status !== "quota_used" &&
      status !== "month_changed"
    )
      throw new StoreError("response");
    return { status, expiresAt: nullableString(result.expiresAt) };
  }

  async redeem(
    identity: { readonly workspace: string; readonly user: string },
    proof: { readonly emailHash: string; readonly tokenHash: string },
  ): Promise<RedeemStatus> {
    const result = object(
      await this.db.queryJson("SELECT otl.redeem_invite($1,$2,$3,$4)", [
        identity.workspace,
        identity.user,
        proof.emailHash,
        proof.tokenHash,
      ]),
    );
    const status = result.status;
    if (
      status !== "joined" &&
      status !== "already_joined" &&
      status !== "invalid" &&
      status !== "wrong_recipient" &&
      status !== "expired"
    )
      throw new StoreError("response");
    return status;
  }

  async check(
    identity: { readonly workspace: string; readonly user: string },
    emailHash: string,
  ): Promise<{
    readonly valid: boolean;
    readonly inviterId: string | null;
    readonly expiresAt: string | null;
  }> {
    const result = object(
      await this.db.queryJson("SELECT otl.check_invite($1,$2,$3)", [
        identity.workspace,
        identity.user,
        emailHash,
      ]),
    );
    if (typeof result.valid !== "boolean") throw new StoreError("response");
    return {
      valid: result.valid,
      inviterId: nullableString(result.inviterId),
      expiresAt: nullableString(result.expiresAt),
    };
  }
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
