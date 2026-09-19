import { z } from "zod";
import { inviteEmailSchema } from "./community-referral-types";

export const INTEREST_CONSENT_VERSION = "interest-consent-v1" as const;
export const INTEREST_PRIVATE_SCHEMA_VERSION = "interest-application.v1" as const;

export const interestPrivatePayloadSchema = z
  .object({
    email: inviteEmailSchema,
    displayName: z.string().trim().min(1).max(80),
    intent: z.string().trim().min(1).max(1000),
    knownMemberClue: z.string().trim().max(200).optional(),
  })
  .strict()
  .readonly();

export type InterestPrivatePayload = z.infer<typeof interestPrivatePayloadSchema>;
export type InterestPrivateObjectRef = {
  readonly opaqueRef: string;
  readonly objectDigest: string;
  readonly envelopeDek: string;
  readonly keyVersion: string;
  readonly nonce: string;
  readonly schemaVersion: typeof INTEREST_PRIVATE_SCHEMA_VERSION;
};

export type InterestSubmit = {
  readonly teamId: string;
  readonly interestId: string;
  readonly receiptId: string;
  readonly emailDigest: string;
  readonly contentDigest: string;
  readonly withdrawalDigest: string;
  readonly consentVersion: typeof INTEREST_CONSENT_VERSION;
  readonly consentedAt: string;
  readonly inviteConsentAccepted: true;
  readonly inviteConsentedAt: string;
  readonly shareNameEmailWithIntroducer: boolean;
  readonly key: string;
  readonly now: string;
  readonly privateRef: InterestPrivateObjectRef;
};
export type InterestWithdraw = {
  readonly teamId: string;
  readonly receiptId: string;
  readonly withdrawalDigest: string;
  readonly key: string;
  readonly now: string;
};
export type InterestReceipt = {
  readonly receiptId: string;
  readonly accepted: true;
  readonly created?: boolean;
  readonly sameSubmissionKey?: boolean;
};
export type InterestAdminAction = {
  readonly teamId: string;
  readonly adminId: string;
  readonly interestId: string;
  readonly expectedRevision: number;
  readonly key: string;
  readonly now: string;
};
export type InterestOfflineEvidence = InterestAdminAction & {
  readonly memberId: string;
  readonly evidenceType: "offline_email" | "offline_call" | "offline_document";
  readonly evidenceDigest: string;
  readonly evidenceAt: string;
};
export type InterestMemberConfirmation = {
  readonly teamId: string;
  readonly interestId: string;
  readonly memberId: string;
  readonly signedNonceDigest: string;
  readonly evidenceDigest: string;
  readonly expectedRevision: number;
  readonly key: string;
  readonly now: string;
};
export type InterestAttach = InterestAdminAction & {
  readonly referral: {
    readonly teamId: string;
    readonly tokenDigest: string;
    readonly emailDigest: string;
    readonly requestId: string;
    readonly receiptId: string;
    readonly withdrawalDigest: string;
    readonly consentVersion: "invite-consent-v1";
    readonly key: string;
    readonly now: string;
  } & {
    readonly opaqueRef: string;
    readonly objectDigest: string;
    readonly envelopeDek: string;
    readonly nonce: string;
    readonly keyVersion: string;
    readonly schemaVersion: "invite-application.v1";
  };
};
