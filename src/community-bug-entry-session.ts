import type { CommunityContext } from "./community-runtime";
import type { CommunityRecord, CommunityScope } from "./community-types";
import { object, string } from "./input";

const SESSION_KIND = "bug_text_entry";
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export type BugTextEntryState = "missing" | "active" | "expired" | "consumed";

function sessionKey(thread: string): string {
  return `bug-text-entry:${thread}`;
}

function expiry(record: CommunityRecord): number | null {
  if (record.kind !== SESSION_KIND) return null;
  const value = string(object(record.body).expiresAt);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function bugTextEntryState(
  store: CommunityContext["store"],
  scope: CommunityScope,
  thread: string,
  now = Date.now(),
): Promise<BugTextEntryState> {
  const record = await store.getRecord({ ...scope, key: sessionKey(thread) });
  if (!record) return "missing";
  const expiresAt = expiry(record);
  if (expiresAt === null || expiresAt <= now) return "expired";
  return record.status === "pending" ? "active" : "consumed";
}

export async function startBugTextEntry(
  context: CommunityContext,
  sourceDigest: string,
): Promise<void> {
  const now = Date.now();
  await context.store.putRecord({
    ...context.scope,
    key: sessionKey(context.thread),
    kind: SESSION_KIND,
    body: {
      version: "bug_text_entry.v1",
      sourceDigest,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    },
  });
}

export async function claimBugTextEntry(
  context: CommunityContext,
): Promise<Exclude<BugTextEntryState, "missing"> | "missing"> {
  const state = await bugTextEntryState(context.store, context.scope, context.thread);
  if (state !== "active") return state;
  return (await context.store.claimRecord({
    ...context.scope,
    key: sessionKey(context.thread),
  }))
    ? "active"
    : "consumed";
}

export async function finishBugTextEntry(
  context: CommunityContext,
  status: "sent" | "failed",
): Promise<void> {
  await context.store.finishRecord({ ...context.scope, key: sessionKey(context.thread) }, status);
}
