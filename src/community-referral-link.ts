import { digestReferralToken } from "./community-referral-token";
import type { ReferralRuntimeStore, ReferralSlackPort } from "./community-referral-types";
import { sign } from "./signing";

export type ReferralLinkEnv = {
  readonly SLACK_TEAM_ID: string;
  readonly PUBLIC_APPLICATION_ORIGIN?: string;
  readonly REFERRAL_TOKEN_SECRET?: string;
};

async function stableToken(teamId: string, userId: string, secret: string): Promise<string> {
  return (await sign(`otl.referral-link.v1\n${teamId}\n${userId}`, secret)).slice(0, 32);
}

export async function handleReferralLinkMessage(
  input: {
    readonly teamId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly text: string;
  },
  env: ReferralLinkEnv,
  store: ReferralRuntimeStore,
  slack: ReferralSlackPort,
): Promise<boolean> {
  if (input.text.trim() !== "내 초대 링크") return false;
  if (
    input.teamId !== env.SLACK_TEAM_ID ||
    !/^[UW][A-Z0-9]+$/.test(input.userId) ||
    !env.REFERRAL_TOKEN_SECRET ||
    !env.PUBLIC_APPLICATION_ORIGIN
  ) {
    await slack.postEphemeral({
      channelId: input.channelId,
      userId: input.userId,
      text: "지금은 초대 링크를 확인할 수 없어요. 운영자에게 문의해 주세요.",
    });
    return true;
  }
  const token = await stableToken(input.teamId, input.userId, env.REFERRAL_TOKEN_SECRET);
  const digest = await digestReferralToken(token);
  const issued = await store.issueLink({
    teamId: input.teamId,
    userId: input.userId,
    linkId: `LNK-${digest.slice(0, 24).toUpperCase()}`,
    tokenDigest: digest,
    now: new Date().toISOString(),
  });
  await slack.postEphemeral({
    channelId: input.channelId,
    userId: input.userId,
    text:
      issued.kind === "issued"
        ? `${env.PUBLIC_APPLICATION_ORIGIN.replace(/\/$/, "")}/r/${token}`
        : "현재는 초대 링크가 쉬고 있어요. 오늘의 ONE THING을 새로 등록하면 같은 링크를 다시 사용할 수 있어요.",
  });
  return true;
}
