import { z } from "zod";
import type { Json } from "./input";

export const INVITE_CONSENT_VERSION = "invite-consent-v1" as const;
export const INVITE_PRIVATE_SCHEMA_VERSION = "invite-application.v1" as const;
export const inviteEmailSchema = z.string().trim().toLowerCase().email().max(320);

export const invitePrivatePayloadSchema = z
  .object({
    email: inviteEmailSchema,
    displayName: z.string().trim().min(1).max(80),
    intent: z.string().trim().min(1).max(1000),
  })
  .strict()
  .readonly();

export type InvitePrivatePayload = z.infer<typeof invitePrivatePayloadSchema>;

export type InvitePrivateObjectRef = {
  readonly opaqueRef: string;
  readonly objectDigest: string;
  readonly envelopeDek: string;
  readonly keyVersion: string;
  readonly nonce: string;
  readonly schemaVersion: typeof INVITE_PRIVATE_SCHEMA_VERSION;
};

export const referralApplicationSchema = z
  .object({
    referralToken: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    submissionKey: z.string().trim().min(8).max(120),
    consentVersion: z.literal(INVITE_CONSENT_VERSION),
    consentedAt: z.string().datetime({ offset: true }),
    email: inviteEmailSchema,
    displayName: z.string().trim().min(1).max(80),
    intent: z.string().trim().min(1).max(1000),
  })
  .strict()
  .readonly();

export type ReferralApplication = z.infer<typeof referralApplicationSchema>;

export type ReferralReceipt = {
  readonly kind: "receipt";
  readonly receiptId: string;
  readonly state: string;
  readonly revision: number;
  readonly requestId: string;
};

export type ReferralWithdrawal = {
  readonly teamId: string;
  readonly receiptId: string;
  readonly withdrawalDigest: string;
  readonly key: string;
  readonly now: string;
};

export type ReferralSubmit = {
  readonly teamId: string;
  readonly tokenDigest: string;
  readonly emailDigest: string;
  readonly requestId: string;
  readonly receiptId: string;
  readonly withdrawalDigest: string;
  readonly consentVersion: typeof INVITE_CONSENT_VERSION;
  readonly consentedAt: string;
  readonly key: string;
  readonly now: string;
  readonly privateRef: InvitePrivateObjectRef;
};

export interface ReferralRuntimeStore {
  claimServiceNonce(digest: string, expiresAt: string): Promise<boolean>;
  resolveLink(teamId: string, tokenDigest: string): Promise<boolean>;
  findSubmission(teamId: string, submissionKey: string): Promise<ReferralReceipt | null>;
  findPrivateIntake(
    teamId: string,
    requestId: string,
    objectDigest: string,
  ): Promise<"adopted" | "absent" | "conflict">;
  issueLink(input: {
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
        readonly remaining?: number;
      }
    | { readonly kind: "unavailable" }
  >;
  submit(input: ReferralSubmit): Promise<ReferralReceipt | { readonly kind: "rejected" }>;
  withdraw(input: ReferralWithdrawal): Promise<ReferralReceipt | { readonly kind: "rejected" }>;
  claimAdminReview(now: string): Promise<InviteAdminReview | null>;
  finishOutbox(input: {
    readonly outboxId: number;
    readonly status: "sent" | "failed";
    readonly now: string;
  }): Promise<boolean>;
  decide(input: InviteAdminDecision): Promise<Omit<ReferralReceipt, "kind" | "requestId">>;
  markInvited(input: InviteAdminAction): Promise<
    Omit<ReferralReceipt, "kind" | "requestId"> & {
      readonly manualInviteAsserted: true;
      readonly deliveryProven: false;
    }
  >;
  observeJoinedMember(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly isBot: boolean;
    readonly isApp: boolean;
    readonly deleted: boolean;
    readonly observedAt: string;
  }): Promise<void>;
  attributeJoin(input: {
    readonly teamId: string;
    readonly userId: string;
    readonly emailDigest: string;
    readonly eventId: string;
    readonly now: string;
  }): Promise<{ readonly kind: "attributed" | "unmatched"; readonly receiptId?: string }>;
}

export type InviteAdminReview = {
  readonly outboxId: number;
  readonly effectKey: string;
  readonly requestId: string;
  readonly revision: number;
  readonly privateRef: InvitePrivateObjectRef & {
    readonly requestId: string;
    readonly revision: number;
  };
};

export type InviteAdminAction = {
  readonly teamId: string;
  readonly adminId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly key: string;
  readonly now: string;
};

export type InviteAdminDecision = InviteAdminAction & {
  readonly decision: "approved" | "declined" | "duplicate" | "suspected_abuse";
};

export interface ReferralSlackPort {
  postEphemeral(input: {
    readonly channelId: string;
    readonly userId: string;
    readonly text: string;
  }): Promise<string>;
  postAdmin(input: {
    readonly adminId: string;
    readonly effectKey: string;
    readonly requestId: string;
    readonly text: string;
    readonly blocks: readonly Json[];
  }): Promise<string>;
  person(userId: string): Promise<{
    readonly id: string;
    readonly teamId: string;
    readonly email: string;
    readonly isBot: boolean;
    readonly isApp: boolean;
    readonly deleted: boolean;
  }>;
}
