import { GardenDeliveryStore, type GardenRetirement } from "./community-garden-store";
import type { CommunityEnv } from "./community-runtime";
import { payloadRecord } from "./community-runtime";
import { CommunitySlackError, callSlack } from "./community-social";
import { NeonStore } from "./store";

const WORKER = "garden-publication.v1";

function errorCode(error: unknown): string {
  if (error instanceof CommunitySlackError) {
    if (error.code === "rate_limited") return "rate_limited";
    if (error.code === "transport_error" || error.code.startsWith("http_5"))
      return "transport_error";
    return "provider_error";
  }
  return "internal_error";
}

export async function updateRetiredGarden(
  token: string,
  channelId: string,
  retirement: GardenRetirement,
): Promise<void> {
  const payload = payloadRecord(retirement.restorePayload);
  await callSlack(token, "chat.update", {
    channel: channelId,
    ts: retirement.messageTs,
    text:
      typeof payload.text === "string"
        ? payload.text
        : "이 잔디는 후기 스레드의 새 메시지로 갱신됐어요. 기존 댓글은 이곳에 남아 있어요.",
    blocks: [],
    attachments: [],
  });
}

export async function runDueGardenRetirements(
  env: CommunityEnv,
  channelId: string,
  now: number,
  observeDue?: (nextDue: number) => Promise<void>,
): Promise<number> {
  const deliveries = new GardenDeliveryStore(new NeonStore(env.DATABASE_URL));
  let processed = 0;
  let nextDue: number | null = null;
  while (processed < 10) {
    const leaseToken = crypto.randomUUID();
    const retirement = await deliveries.claimRetirement({
      teamId: env.SLACK_TEAM_ID,
      channelId,
      workerId: WORKER,
      leaseToken,
      now: new Date(now).toISOString(),
    });
    if (!retirement) break;
    try {
      await updateRetiredGarden(env.SLACK_BOT_TOKEN, channelId, retirement);
      await deliveries.finishRetirement({
        teamId: env.SLACK_TEAM_ID,
        channelId,
        retirementId: retirement.retirementId,
        leaseToken,
        status: "retired",
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      nextDue = now + 60_000;
      await deliveries.finishRetirement({
        teamId: env.SLACK_TEAM_ID,
        channelId,
        retirementId: retirement.retirementId,
        leaseToken,
        status: "failed",
        errorCode: errorCode(error),
        retryAfter: new Date(nextDue).toISOString(),
      });
    }
    processed += 1;
  }
  if (nextDue !== null && observeDue) await observeDue(nextDue);
  return processed;
}

export async function restoreRetiredGarden(
  env: CommunityEnv,
  channelId: string,
  retirementId: number,
  now: number,
): Promise<boolean> {
  const deliveries = new GardenDeliveryStore(new NeonStore(env.DATABASE_URL));
  const leaseToken = crypto.randomUUID();
  const retirement = await deliveries.claimRestore({
    teamId: env.SLACK_TEAM_ID,
    channelId,
    retirementId,
    workerId: WORKER,
    leaseToken,
    now: new Date(now).toISOString(),
  });
  if (!retirement) return false;
  try {
    await callSlack(env.SLACK_BOT_TOKEN, "chat.update", {
      channel: channelId,
      ts: retirement.messageTs,
      ...payloadRecord(retirement.restorePayload),
    });
    return deliveries.finishRestore({
      teamId: env.SLACK_TEAM_ID,
      channelId,
      retirementId,
      leaseToken,
      status: "restored",
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await deliveries.finishRestore({
      teamId: env.SLACK_TEAM_ID,
      channelId,
      retirementId,
      leaseToken,
      status: "restore_failed",
      errorCode: errorCode(error),
    });
    return false;
  }
}
