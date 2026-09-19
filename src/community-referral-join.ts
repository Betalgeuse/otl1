import { digestNormalizedInviteEmail } from "./community-referral-token";
import type { ReferralRuntimeStore, ReferralSlackPort } from "./community-referral-types";

export type ReferralJoinEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly INVITE_EMAIL_PEPPER?: string;
};

export async function handleReferralTeamJoin(
  input: { readonly teamId: string; readonly eventId: string; readonly userId: string },
  env: ReferralJoinEnv,
  store: ReferralRuntimeStore,
  slack: ReferralSlackPort,
): Promise<boolean> {
  if (input.teamId !== env.SLACK_TEAM_ID || !/^[UW][A-Z0-9]+$/.test(input.userId)) return false;
  const person = await slack.person(input.userId);
  if (
    person.id !== input.userId ||
    person.teamId !== input.teamId ||
    person.isBot ||
    person.isApp ||
    person.deleted ||
    !env.INVITE_EMAIL_PEPPER
  )
    return true;
  const observedAt = new Date().toISOString();
  await store.observeJoinedMember({
    teamId: input.teamId,
    userId: input.userId,
    isBot: person.isBot,
    isApp: person.isApp,
    deleted: person.deleted,
    observedAt,
  });
  await store.attributeJoin({
    teamId: input.teamId,
    userId: input.userId,
    emailDigest: await digestNormalizedInviteEmail(person.email, env.INVITE_EMAIL_PEPPER),
    eventId: input.eventId,
    now: observedAt,
  });
  return true;
}
