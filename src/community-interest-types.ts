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

export type InterestIntroductionPrompt = InterestAdminAction & {
  readonly memberId: string;
  readonly nonceDigest: string;
  readonly expiresAt: string;
};

export const interestAdminContextSchema = z.object({
  interestId: z.string(),
  state: z.string(),
  revision: z.number().int().nonnegative(),
  emailDigest: z.string().regex(/^[0-9a-f]{64}$/),
  memberId: z.string().nullable(),
  tokenDigest: z.string().nullable(),
  shareNameEmailWithIntroducer: z.boolean(),
  opaqueRef: z.string().nullable(),
  objectDigest: z.string().nullable(),
  envelopeDek: z.string().nullable(),
  nonce: z.string().nullable(),
  keyVersion: z.string().nullable(),
  schemaVersion: z.literal(INTEREST_PRIVATE_SCHEMA_VERSION),
});
export type InterestAdminContext = z.infer<typeof interestAdminContextSchema>;

export const interestMemberContextSchema = interestAdminContextSchema
  .pick({
    interestId: true,
    revision: true,
    shareNameEmailWithIntroducer: true,
    opaqueRef: true,
    objectDigest: true,
    envelopeDek: true,
    nonce: true,
    keyVersion: true,
    schemaVersion: true,
  })
  .readonly();
export type InterestMemberContext = z.infer<typeof interestMemberContextSchema>;
