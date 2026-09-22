import { assertPrivateInterestAdminChannel } from "./community-interest-channel";
import type { CommunityEnv } from "./community-runtime";
import { callSlack } from "./community-social";
import { sign } from "./signing";

const sha = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

export type Marker = {
  readonly interestId: string;
  readonly submissionKeyDigest: string;
  readonly objectDigest: string;
  readonly opaqueRef: string;
  readonly createdAt: string;
  readonly status: "pending" | "dead";
  readonly alertStatus?: "alert_pending" | "alerted";
  readonly alertStartedAt?: string;
  readonly alertLeaseUntil?: string;
  readonly alertedAt?: string;
};

type StoredMarker = { readonly etag: string };
type MarkerBucket = NonNullable<CommunityEnv["INVITE_PRIVATE_OBJECTS"]>;

export async function updateMarker(
  bucket: MarkerBucket,
  key: string,
  etag: string,
  value: Marker,
  secret: string,
): Promise<StoredMarker | null> {
  const body = JSON.stringify(value);
  return bucket.put(
    key,
    new TextEncoder().encode(
      JSON.stringify({
        marker: body,
        signature: await sign(body, secret),
      }),
    ).buffer,
    { onlyIf: { etagMatches: etag } },
  );
}

async function wasAlertPosted(
  env: CommunityEnv,
  channel: string,
  text: string,
  oldest: string,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await callSlack(env.SLACK_BOT_TOKEN, "conversations.history", {
      channel,
      oldest: String(Date.parse(oldest) / 1000),
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(response.messages)) throw new Error("Interest alert history unavailable");
    if (
      response.messages.some(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          item.text === text &&
          "bot_id" in item &&
          typeof item.bot_id === "string",
      )
    )
      return true;
    if (response.has_more !== true) return false;
    const metadata = response.response_metadata;
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("next_cursor" in metadata) ||
      typeof metadata.next_cursor !== "string" ||
      !metadata.next_cursor
    )
      throw new Error("Interest alert history cursor unavailable");
    cursor = metadata.next_cursor;
  }
  throw new Error("Interest alert history scan incomplete");
}

export async function alertDeadMarker(
  env: CommunityEnv,
  bucket: MarkerBucket,
  key: string,
  stored: StoredMarker,
  value: Marker,
  now: number,
): Promise<boolean> {
  if (value.alertStatus === "alerted") return false;
  if (value.alertLeaseUntil && Date.parse(value.alertLeaseUntil) > now) return true;
  const channel = await assertPrivateInterestAdminChannel(env);
  const claimed: Marker = {
    ...value,
    status: "dead",
    alertStatus: "alert_pending",
    alertStartedAt: value.alertStartedAt ?? new Date(now).toISOString(),
    alertLeaseUntil: new Date(now + 120_000).toISOString(),
  };
  const lease = await updateMarker(
    bucket,
    key,
    stored.etag,
    claimed,
    env.SITE_CORE_HMAC_SECRET ?? "",
  );
  if (!lease) return true;
  const text = `참여 문의 보관 오류 ${value.interestId} · interest-dead-alert:${value.interestId}`;
  if (!(await wasAlertPosted(env, channel, text, claimed.alertStartedAt ?? value.createdAt))) {
    const digest = await sha(`interest-dead-alert:${env.SLACK_TEAM_ID}:${value.interestId}`);
    await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel,
      text,
      client_msg_id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    });
  }
  const alerted: Marker = {
    ...claimed,
    alertStatus: "alerted",
    alertedAt: new Date(now).toISOString(),
  };
  const receipt = await updateMarker(
    bucket,
    key,
    lease.etag,
    alerted,
    env.SITE_CORE_HMAC_SECRET ?? "",
  );
  return !receipt;
}
