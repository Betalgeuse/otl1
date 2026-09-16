import type { ConfirmedBugPacket } from "./community-bug-schema";
import type { Json } from "./input";

export const BUG_STATES = [
  "new",
  "needs_info",
  "needs_info_exhausted",
  "duplicate",
  "private_incident",
  "triaged",
  "queued",
  "reproducing",
  "reproduced",
  "reproduce_failed",
  "fixing",
  "fix_failed",
  "reviewing",
  "review_failed",
  "pr_open",
  "stale_pr",
  "merge_eligible",
  "merge_failed",
  "merged",
  "staging",
  "observing",
  "deploy_failed",
  "rolled_back",
  "resolved",
  "reopened",
  "blocked_capacity",
  "blocked",
  "paused_policy",
  "rejected",
] as const;

export type BugState = (typeof BUG_STATES)[number];

export type BugPacketFields = {
  readonly actual: string | null;
  readonly expected: string | null;
  readonly steps: readonly Json[];
  readonly location: string | null;
  readonly occurredAt: string | null;
  readonly frequency: string | null;
  readonly impact: string | null;
};

export type SanitizedBugFields = BugPacketFields & {
  readonly title: string;
  readonly severity?: "low" | "medium" | "high" | "critical";
  readonly privacy?: boolean;
};

export type EncryptedObjectRef = {
  readonly opaqueRef: string;
  readonly objectDigest: string;
  readonly envelopeDek: string;
  readonly kekVersion: string;
  readonly nonce: string;
};

export type CreateBugDraft = EncryptedObjectRef & {
  readonly bugId: string;
  readonly teamId: string;
  readonly publicAlias: string;
  readonly reporterId: string;
  readonly source: "slack" | "admin" | "api";
  readonly sourceOpaqueRef: string;
  readonly sourceChannelId?: string;
  readonly sourceThread?: string;
  readonly idempotencyKey: string;
  readonly sanitizedFields: SanitizedBugFields;
};

export type AnswerBugRevision = EncryptedObjectRef & {
  readonly bugId: string;
  readonly reporterId: string;
  readonly questionId: string;
  readonly answerDigest: string;
  readonly answerOpaqueRef: string;
  readonly expectedPacketRevision: number;
  readonly idempotencyKey: string;
  readonly privacy: boolean;
  readonly sanitizedFields: BugPacketFields;
  readonly completeness: Readonly<Record<string, Json>>;
};

export type ConfirmPacketInput = {
  readonly packet: ConfirmedBugPacket;
  readonly storage: EncryptedObjectRef & {
    readonly canonicalEvidence: string;
    readonly evidenceObjectDigest: string;
    readonly teamId: string;
    readonly reporterId: string;
    readonly expectedPacketRevision: number;
    readonly idempotencyKey: string;
  };
};

export type TransitionBug = {
  readonly bugId: string;
  readonly toState: BugState;
  readonly variant?: string;
  readonly actors: readonly string[];
  readonly guard: Readonly<Record<string, Json>>;
  readonly evidence: Readonly<Record<string, Json>>;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly now?: string;
};

export type TransitionResult = {
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly eventId: number;
  readonly state: BugState;
  readonly revision: number;
};

export type EnqueueBugJob = {
  readonly bugId: string;
  readonly kind: "reproduce" | "fix" | "review" | "deploy";
  readonly payload: Readonly<Record<string, Json>>;
  readonly payloadDigest: string;
  readonly assignedAlias?: string;
  readonly availableAt?: string;
};

export type LeaseBugJob = {
  readonly workerId: string;
  readonly accountAlias: string;
  readonly leaseToken: string;
  readonly kinds: readonly EnqueueBugJob["kind"][];
  readonly leaseSeconds?: number;
  readonly now?: string;
};

export type HeartbeatBugJob = {
  readonly jobId: number;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseSeconds?: number;
  readonly now?: string;
};

export type FinishBugJob = {
  readonly jobId: number;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly status: "succeeded" | "failed";
  readonly resultDigest: string;
  readonly now?: string;
};

export type CancelBugJob = {
  readonly jobId: number;
  readonly actor: "admin" | "signed_safety_policy";
  readonly reason: string;
  readonly now?: string;
};

export type BugJob = {
  readonly jobId: number;
  readonly bugId: string;
  readonly kind: EnqueueBugJob["kind"];
  readonly status: "queued" | "leased" | "succeeded" | "failed" | "cancelled";
  readonly assignedAlias: string | null;
  readonly leaseToken: string | null;
  readonly attempt: number;
};

export type BugDraft = {
  readonly bugId: string;
  readonly state: BugState;
  readonly revision: number;
  readonly packetRevision: number;
  readonly publicAlias: string;
};

export type GetBugDraft = {
  readonly teamId: string;
  readonly bugId: string;
  readonly reporterId: string;
  readonly expectedRevision?: number;
};

type FindActiveBugDraftOwner = {
  readonly teamId: string;
  readonly reporterId: string;
};

export type FindActiveBugDraft = FindActiveBugDraftOwner &
  (
    | { readonly sourceOpaqueRef: string }
    | { readonly sourceChannelId: string; readonly sourceThread: string }
  );

export type BugRevisionRead = {
  readonly packetRevision: number;
  readonly schemaVersion: "bug_intake.v1" | "bug_packet.v1";
  readonly status: "draft" | "answered" | "confirmed";
  readonly latestOpaqueRef: string;
  readonly objectDigest: string;
  readonly kekVersion: string;
  readonly nonce: string;
  readonly evidenceDigest: string | null;
  readonly packetDigest: string | null;
  readonly confirmedPacket: ConfirmedBugPacket | null;
};

export type BugQuestionRead = {
  readonly questionId: string;
  readonly fieldName: string;
  readonly templateVersion: string;
  readonly questionText: string;
  readonly askedPacketRevision: number;
  readonly askedAt: string;
  readonly answered: boolean;
  readonly answerDigest: string | null;
  readonly answerOpaqueRef: string | null;
  readonly answerPacketRevision: number | null;
  readonly completeness: Json;
};

export type BugDraftRead = {
  readonly bugId: string;
  readonly teamId: string;
  readonly state: BugState;
  readonly revision: number;
  readonly packetRevision: number;
  readonly needsInfoStartedAt: string | null;
  readonly reporterId: string;
  readonly sanitizedFields: Readonly<Record<string, Json>>;
  readonly source: {
    readonly kind: string;
    readonly opaqueRef: string;
    readonly channelId?: string;
    readonly thread?: string;
  };
  readonly currentRevision: BugRevisionRead;
  readonly questions: readonly BugQuestionRead[];
};

export class BugStoreError extends Error {
  constructor(readonly kind: "response") {
    super(`bug store ${kind}`);
    this.name = "BugStoreError";
  }
}
