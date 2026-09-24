import type { CommunityBugStore } from "./community-bug-store";
import type { BugDraftRead } from "./community-bug-types";
import type { CommunityContext } from "./community-runtime";

export async function findActiveBugDraftForContext(
  store: CommunityBugStore,
  context: CommunityContext,
): Promise<BugDraftRead | null> {
  const identity = {
    teamId: context.scope.teamId,
    reporterId: context.scope.userId,
  };
  const byLegacyRef = await store.findActiveDraft({
    ...identity,
    sourceOpaqueRef: `slack:${context.scope.teamId}:${context.scope.channelId}:${context.thread}`,
  });
  if (byLegacyRef) return byLegacyRef;
  return store.findActiveDraft({
    ...identity,
    sourceChannelId: context.scope.channelId,
    sourceThread: context.thread,
  });
}
