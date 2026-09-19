import {
  finishGardenPublication,
  type GardenPublication,
  postPreparedGarden,
  prepareGardenPublication,
} from "./community-garden";
import { runDueGardenRetirements } from "./community-garden-retirement";
import { type GardenDelivery, GardenDeliveryStore } from "./community-garden-store";
import { type CommunityContext, type CommunityEnv, payloadRecord } from "./community-runtime";
import { CommunitySlackError } from "./community-social";
import { CommunityStore } from "./community-store";
import { NeonStore } from "./store";

const WORKER = "garden-publication.v1";

async function hexDigest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function gardenMarker(
  delivery: Pick<
    GardenDelivery,
    "teamId" | "channelId" | "userId" | "date" | "revision" | "thread" | "source"
  >,
  payloadDigest: string,
): Promise<string> {
  const identity = [
    delivery.teamId,
    delivery.channelId,
    delivery.userId,
    delivery.date,
    String(delivery.revision),
    delivery.thread,
    delivery.source,
    payloadDigest,
  ].join("\u001f");
  return `garden_${(await hexDigest(identity)).slice(0, 24)}`;
}

function contextFor(
  env: CommunityEnv,
  store: CommunityStore,
  delivery: GardenDelivery,
): CommunityContext {
  return {
    env,
    store,
    scope: {
      teamId: delivery.teamId,
      channelId: delivery.channelId,
      userId: delivery.userId,
    },
    date: delivery.date,
    thread: delivery.thread,
    source: delivery.source,
    key: delivery.deliveryKey,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof CommunitySlackError) {
    if (error.code === "rate_limited") return "rate_limited";
    if (error.code === "transport_error" || error.code.startsWith("http_5"))
      return "transport_error";
    return "provider_error";
  }
  return "internal_error";
}

async function deliverClaimed(
  context: CommunityContext,
  deliveries: GardenDeliveryStore,
  claimed: GardenDelivery,
  leaseToken: string,
  now: number,
): Promise<{ readonly messageTs: string | null; readonly nextDue: number | null }> {
  let publication: GardenPublication | null = null;
  try {
    const rendered = await prepareGardenPublication(context, claimed.date);
    const digest = await hexDigest(JSON.stringify(rendered.message));
    const prepared = await deliveries.prepare({
      teamId: claimed.teamId,
      channelId: claimed.channelId,
      userId: claimed.userId,
      deliveryKey: claimed.deliveryKey,
      leaseToken,
      payloadDigest: digest,
      payload: rendered.message,
    });
    if (!prepared) return { messageTs: null, nextDue: null };
    publication = await postPreparedGarden(
      context,
      claimed.date,
      await gardenMarker(claimed, prepared.payloadDigest),
      claimed.projectionKey,
      claimed.revision,
      { prior: rendered.prior, message: payloadRecord(prepared.payload) },
    );
    await deliveries.finish({
      teamId: claimed.teamId,
      channelId: claimed.channelId,
      userId: claimed.userId,
      deliveryKey: claimed.deliveryKey,
      leaseToken,
      status: "sent",
      messageTs: publication.sent,
    });
    await finishGardenPublication(context, publication, claimed.date, claimed.undoKey);
    return { messageTs: publication.sent, nextDue: null };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const nextDue = claimed.attempts < 3 ? now + 60_000 : null;
    await deliveries.finish({
      teamId: claimed.teamId,
      channelId: claimed.channelId,
      userId: claimed.userId,
      deliveryKey: claimed.deliveryKey,
      leaseToken,
      status: "failed",
      errorCode: errorCode(error),
      ...(nextDue === null ? {} : { retryAfter: new Date(nextDue).toISOString() }),
    });
    console.error(
      JSON.stringify({ event: "community.garden.delivery_failed", code: errorCode(error) }),
    );
    return { messageTs: null, nextDue };
  }
}

export async function deliverGardenByKey(
  env: CommunityEnv,
  channelId: string,
  deliveryKey: string,
  now: number,
  observeDue?: (nextDue: number) => Promise<void>,
): Promise<string | null> {
  const db = new NeonStore(env.DATABASE_URL);
  const deliveries = new GardenDeliveryStore(db);
  const leaseToken = crypto.randomUUID();
  const claimed = await deliveries.claim({
    teamId: env.SLACK_TEAM_ID,
    channelId,
    deliveryKey,
    leaseToken,
    now: new Date(now).toISOString(),
  });
  if (!claimed) return null;
  const result = await deliverClaimed(
    contextFor(env, new CommunityStore(db), claimed),
    deliveries,
    claimed,
    leaseToken,
    now,
  );
  if (result.nextDue !== null && observeDue) await observeDue(result.nextDue);
  return result.messageTs;
}

export async function runDueGardenDeliveries(
  env: CommunityEnv,
  channelId: string,
  now: number,
  observeDue?: (nextDue: number) => Promise<void>,
): Promise<{ readonly processed: number; readonly nextDue: number | null }> {
  const db = new NeonStore(env.DATABASE_URL);
  const deliveries = new GardenDeliveryStore(db);
  const store = new CommunityStore(db);
  let processed = 0;
  let nextDue: number | null = null;
  while (processed < 10) {
    const leaseToken = crypto.randomUUID();
    const claimed = await deliveries.claim({
      teamId: env.SLACK_TEAM_ID,
      channelId,
      leaseToken,
      now: new Date(now).toISOString(),
    });
    if (!claimed) break;
    const result = await deliverClaimed(
      contextFor(env, store, claimed),
      deliveries,
      claimed,
      leaseToken,
      now,
    );
    processed += 1;
    if (result.nextDue !== null) nextDue = Math.min(nextDue ?? result.nextDue, result.nextDue);
  }
  await runDueGardenRetirements(env, channelId, now, async (retirementDue) => {
    nextDue = Math.min(nextDue ?? retirementDue, retirementDue);
  });
  if (nextDue !== null && observeDue) await observeDue(nextDue);
  return { processed, nextDue };
}

export const GARDEN_DELIVERY_WORKER = WORKER;
