import { z } from "zod";

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
