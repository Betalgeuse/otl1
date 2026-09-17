import { CommunitySlackError, callSlack } from "./community-social";
import type { ChannelMember, ChannelMembershipSnapshot } from "./community-types";
import { InputError, list, object, string } from "./input";

const PROFILE_CONCURRENCY = 5;

function memberProfile(value: unknown, expectedUserId: string): ChannelMember {
  const profile = object(object(value).user);
  const userId = string(profile.id);
  if (userId !== expectedUserId) throw new InputError("Slack member profile mismatch");
  return {
    userId,
    isBot: profile.is_bot === true,
    isAppUser: profile.is_app_user === true,
    deleted: profile.deleted === true,
  };
}

async function mapProfiles(
  token: string,
  userIds: readonly string[],
): Promise<readonly ChannelMember[]> {
  const results: ChannelMember[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < userIds.length) {
      const index = next;
      next += 1;
      const userId = userIds[index];
      if (!userId) throw new InputError("Slack member index missing");
      results[index] = memberProfile(
        await callSlack(token, "users.info", { user: userId }),
        userId,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROFILE_CONCURRENCY, userIds.length) }, () => worker()),
  );
  return results;
}

export async function collectCurrentChannelMembers(
  token: string,
  channelId: string,
  botUserId: string,
  observedAt: string,
): Promise<ChannelMembershipSnapshot> {
  if (!Number.isFinite(Date.parse(observedAt))) throw new InputError("Invalid observation time");
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor = "";
  do {
    if (seenCursors.has(cursor)) throw new CommunitySlackError("invalid_cursor");
    seenCursors.add(cursor);
    const page = object(
      await callSlack(token, "conversations.members", {
        channel: channelId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const value of list(page.members)) {
      const userId = string(value);
      if (!/^[UW][A-Z0-9]+$/.test(userId)) throw new InputError("Invalid Slack member ID");
      ids.add(userId);
    }
    const metadata = page.response_metadata === undefined ? {} : object(page.response_metadata);
    cursor = metadata.next_cursor === undefined ? "" : string(metadata.next_cursor);
  } while (cursor);
  const userIds = [...ids].sort();
  const members = await mapProfiles(token, userIds);
  return {
    observedAt,
    members,
    eligibleHumanIds: members
      .filter(
        (member) =>
          !member.deleted && !member.isBot && !member.isAppUser && member.userId !== botUserId,
      )
      .map((member) => member.userId),
  };
}
