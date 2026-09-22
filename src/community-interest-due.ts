import { interestReviewCard, interestVerifiedCard } from "./community-interest-admin";
import { assertPrivateInterestAdminChannel } from "./community-interest-channel";
import {
  deleteInterestPrivateObject,
  readInterestPrivateObject,
} from "./community-interest-private";
import { CommunityInterestStore } from "./community-interest-store";
import type { CommunityEnv } from "./community-runtime";
import { callSlack } from "./community-social";
import { InputError, type Json, object, string } from "./input";
import { NeonStore } from "./store";

async function clientMessageId(effectKey: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`interest:${effectKey}`)),
  );
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function runInterestDue(
  env: CommunityEnv,
  now = Date.now(),
): Promise<{ readonly processed: number; readonly possiblyMore: boolean }> {
  if (env.DATABASE_MAINTENANCE === "true") return { processed: 0, possiblyMore: false };
  if (
    !env.INTEREST_RUNTIME_DATABASE_URL ||
    !env.INVITE_PRIVATE_OBJECTS ||
    !env.INVITE_PRIVATE_KEK ||
    !env.INVITE_PRIVATE_KEK_VERSION
  )
    throw new InputError("Interest retention configuration unavailable");
  const runtime = new CommunityInterestStore(new NeonStore(env.INTEREST_RUNTIME_DATABASE_URL));
  const iso = new Date(now).toISOString();
  await runtime.expireDue(env.SLACK_TEAM_ID, iso, 10);
  let processed = 0;
  if (env.PUBLIC_INTEREST_ENABLED === "true") {
    if (
      !env.INTEREST_ADMIN_DATABASE_URL ||
      !env.INTEREST_ADMIN_CHANNEL_ID ||
      env.INTEREST_ADMIN_CHANNEL_ID === env.COMMUNITY_PUBLIC_CHANNEL_ID ||
      !env.COMMUNITY_ADMIN_ID
    )
      throw new InputError("Interest delivery configuration unavailable");
    const admin = new CommunityInterestStore(new NeonStore(env.INTEREST_ADMIN_DATABASE_URL));
    for (; processed < 2; processed += 1) {
      const claimed = await admin.claimDelivery(
        env.SLACK_TEAM_ID,
        env.COMMUNITY_ADMIN_ID,
        iso,
        crypto.randomUUID(),
      );
      if (claimed === null) break;
      const row = object(claimed);
      const interestId = string(row.interestId);
      const effectKey = string(row.effectKey);
      const effectType = string(row.effectType);
      const claimKey = string(row.claimKey);
      const outboxId = row.outboxId;
      if (typeof outboxId !== "number" || !Number.isSafeInteger(outboxId))
        throw new InputError("Interest outbox unavailable");
      let status: "sent" | "failed" = "sent";
      try {
        let text = `참여 문의 처리 기록 ${interestId}`;
        let blocks: readonly Json[] = [];
        if (effectType === "admin_review" && row.state === "pending_introduction") {
          const payload = await readInterestPrivateObject(
            {
              bucket: env.INVITE_PRIVATE_OBJECTS,
              kek: env.INVITE_PRIVATE_KEK,
              keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
            },
            {
              requestId: interestId,
              revision: 0,
              opaqueRef: string(row.opaqueRef),
              objectDigest: string(row.objectDigest),
              envelopeDek: string(row.envelopeDek),
              nonce: string(row.nonce),
              keyVersion: string(row.keyVersion),
              schemaVersion: "interest-application.v1",
            },
          );
          const card = interestReviewCard({
            interestId,
            revision: Number(row.revision),
            email: payload.email,
            displayName: payload.displayName,
            intent: payload.intent,
            knownMemberClue: payload.knownMemberClue ?? "",
            shareNameEmailWithIntroducer: row.shareNameEmailWithIntroducer === true,
          });
          text = card.text;
          blocks = card.blocks;
        } else if (effectType === "introduction_verified") {
          const card = interestVerifiedCard({ interestId, revision: Number(row.revision) });
          text = card.text;
          blocks = card.blocks;
        }
        const privateChannel = await assertPrivateInterestAdminChannel(env);
        await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
          channel: privateChannel,
          text,
          blocks,
          client_msg_id: await clientMessageId(effectKey),
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        status = "failed";
      }
      await admin.finishDelivery({
        teamId: env.SLACK_TEAM_ID,
        adminId: env.COMMUNITY_ADMIN_ID,
        now: iso,
        claimKey,
        outboxId,
        status,
      });
    }
  }
  for (let index = 0; index < 2; index += 1) {
    const key = crypto.randomUUID();
    const claimed = await runtime.claimPurge(env.SLACK_TEAM_ID, iso, key);
    if (claimed === null) break;
    const row = object(claimed);
    let status: "purged" | "failed" = "purged";
    try {
      await deleteInterestPrivateObject(
        {
          bucket: env.INVITE_PRIVATE_OBJECTS,
          kek: env.INVITE_PRIVATE_KEK,
          keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
        },
        string(row.opaqueRef),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      status = "failed";
    }
    await runtime.finishPurge({
      teamId: env.SLACK_TEAM_ID,
      now: iso,
      key,
      interestId: string(row.interestId),
      status,
    });
  }
  await runtime.auditRetention(env.SLACK_TEAM_ID, iso, 10);
  return { processed, possiblyMore: processed === 2 };
}
