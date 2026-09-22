import { z } from "zod";
import { interestMemberPromptCard } from "./community-interest-admin";
import { assertPrivateInterestAdminChannel } from "./community-interest-channel";
import { readInterestPrivateObject } from "./community-interest-private";
import { CommunityInterestStore } from "./community-interest-store";
import {
  prepareInvitePrivateObject,
  putPreparedInvitePrivateObject,
} from "./community-invite-private";
import { createInvitePrivateReconciliationMarker } from "./community-referral-reconcile";
import type { CommunityEnv } from "./community-runtime";
import { callSlack } from "./community-social";
import { InputError, object, string } from "./input";
import { sign } from "./signing";
import { NeonStore } from "./store";

const actionIdSchema = /^community_interest_(request|decline|attach):(IREQ-[A-Z0-9-]{4,64}):(\d+)$/;
const confirmationSchema = z
  .object({
    teamId: z.string(),
    interestId: z.string().regex(/^IREQ-[A-Z0-9-]{4,64}$/),
    memberId: z.string(),
    revision: z.number().int().nonnegative(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.number().int(),
  })
  .strict();
const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
const sha = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const randomId = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
const base64url = (hexValue: string): string =>
  btoa(String.fromCharCode(...(hexValue.match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

function configured(env: CommunityEnv): {
  readonly admin: CommunityInterestStore;
  readonly member: CommunityInterestStore;
  readonly actionSecret: string;
} {
  if (
    env.PUBLIC_INTEREST_ENABLED !== "true" ||
    !env.INTEREST_ADMIN_DATABASE_URL ||
    !env.INTEREST_MEMBER_DATABASE_URL ||
    !env.INTEREST_ACTION_SECRET ||
    !env.INTEREST_ADMIN_CHANNEL_ID ||
    env.INTEREST_ADMIN_CHANNEL_ID === env.COMMUNITY_PUBLIC_CHANNEL_ID
  )
    throw new InputError("참여 문의 처리를 사용할 수 없습니다.");
  return {
    admin: new CommunityInterestStore(new NeonStore(env.INTEREST_ADMIN_DATABASE_URL)),
    member: new CommunityInterestStore(new NeonStore(env.INTEREST_MEMBER_DATABASE_URL)),
    actionSecret: env.INTEREST_ACTION_SECRET,
  };
}

export async function handleInterestInteraction(
  data: Record<string, unknown>,
  env: CommunityEnv,
): Promise<boolean> {
  if (data.type !== "block_actions") return false;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  if (!actions[0]) return false;
  const action = object(actions[0]);
  const id = string(action.action_id);
  if (!id.startsWith("community_interest_")) return false;
  const { admin, member, actionSecret } = configured(env);
  const teamId = string(object(data.team).id);
  const userId = string(object(data.user).id);
  const channelId = string(object(data.container).channel_id);
  const actionTs = string(action.action_ts);
  if (teamId !== env.SLACK_TEAM_ID || !/^\d{10}\.\d{1,6}$/.test(actionTs))
    throw new InputError("참여 문의 동작을 확인할 수 없습니다.");
  const now = new Date(Number(actionTs) * 1000).toISOString();
  if (id === "community_interest_confirm") {
    if (!/^D[A-Z0-9]+$/.test(channelId))
      throw new InputError("비공개 소개 요청에서 확인해 주세요.");
    const parsed = confirmationSchema.safeParse(JSON.parse(string(action.value)));
    if (
      !parsed.success ||
      parsed.data.teamId !== teamId ||
      parsed.data.memberId !== userId ||
      parsed.data.expiresAt < Date.now()
    )
      throw new InputError("소개 요청을 확인할 수 없습니다.");
    const nonceDigest = await sha(parsed.data.nonce);
    await member.confirmMember({
      teamId,
      interestId: parsed.data.interestId,
      memberId: userId,
      expectedRevision: parsed.data.revision,
      signedNonceDigest: nonceDigest,
      evidenceDigest: nonceDigest,
      key: `member-${(await sha(`${teamId}:${userId}:${actionTs}:${nonceDigest}`)).slice(0, 64)}`,
      now,
    });
    return true;
  }
  const match = id.match(actionIdSchema);
  if (!match?.[1] || !match[2] || !match[3])
    throw new InputError("참여 문의 동작을 확인할 수 없습니다.");
  const operation = match[1];
  const interestId = match[2];
  const revision = Number(match[3]);
  if (
    userId !== env.COMMUNITY_ADMIN_ID ||
    channelId !== env.INTEREST_ADMIN_CHANNEL_ID ||
    !Number.isSafeInteger(revision)
  )
    throw new InputError("비공개 관리자 카드에서 처리해 주세요.");
  await assertPrivateInterestAdminChannel(env);
  const key = `admin-${(await sha(`${teamId}:${userId}:${id}:${actionTs}`)).slice(0, 64)}`;
  const base = { teamId, adminId: userId, interestId, expectedRevision: revision, key, now };
  if (operation === "decline") {
    await admin.decline(base);
    return true;
  }
  const context = await admin.adminContext(base);
  if (operation === "attach" && context.state === "attached") return true;
  if (context.revision !== revision) throw new InputError("새 카드에서 다시 처리해 주세요.");
  if (operation === "request") {
    const selected = string(action.selected_user);
    if (
      !/^[UW][A-Z0-9]+$/.test(selected) ||
      !context.shareNameEmailWithIntroducer ||
      !context.opaqueRef ||
      !context.objectDigest ||
      !context.envelopeDek ||
      !context.nonce ||
      !context.keyVersion
    )
      throw new InputError("소개 요청을 처리할 수 없습니다.");
    const nonce = base64url(
      await sign(`${teamId}:${interestId}:${selected}:${revision}:${actionTs}`, actionSecret),
    );
    const nonceDigest = await sha(nonce);
    const expiresAt = Date.parse(now) + 24 * 60 * 60_000;
    const payload = await readInterestPrivateObject(
      {
        bucket: env.INVITE_PRIVATE_OBJECTS,
        kek: env.INVITE_PRIVATE_KEK,
        keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
      },
      {
        requestId: interestId,
        revision: 0,
        opaqueRef: context.opaqueRef,
        objectDigest: context.objectDigest,
        envelopeDek: context.envelopeDek,
        nonce: context.nonce,
        keyVersion: context.keyVersion,
        schemaVersion: "interest-application.v1",
      },
    );
    await admin.requestIntroduction({
      ...base,
      memberId: selected,
      nonceDigest,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    const card = interestMemberPromptCard({
      teamId,
      interestId,
      memberId: selected,
      revision,
      nonce,
      expiresAt,
      displayName: payload.displayName,
      email: payload.email,
    });
    await callSlack(env.SLACK_BOT_TOKEN, "chat.postMessage", {
      channel: selected,
      text: card.text,
      blocks: card.blocks,
      client_msg_id: `${nonceDigest.slice(0, 8)}-${nonceDigest.slice(8, 12)}-4${nonceDigest.slice(13, 16)}-8${nonceDigest.slice(17, 20)}-${nonceDigest.slice(20, 32)}`,
    });
    return true;
  }
  if (operation === "attach") {
    if (env.REFERRALS_ENABLED !== "true")
      throw new InputError("일반 가입 신청을 사용할 수 없습니다.");
    if (
      context.state !== "introduction_verified" ||
      !context.memberId ||
      !context.tokenDigest ||
      !context.opaqueRef ||
      !context.objectDigest ||
      !context.envelopeDek ||
      !context.nonce ||
      !context.keyVersion
    )
      throw new InputError("확인된 소개가 없습니다.");
    const payload = await readInterestPrivateObject(
      {
        bucket: env.INVITE_PRIVATE_OBJECTS,
        kek: env.INVITE_PRIVATE_KEK,
        keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
      },
      {
        requestId: interestId,
        revision: 0,
        opaqueRef: context.opaqueRef,
        objectDigest: context.objectDigest,
        envelopeDek: context.envelopeDek,
        nonce: context.nonce,
        keyVersion: context.keyVersion,
        schemaVersion: "interest-application.v1",
      },
    );
    const requestId = randomId("REQ");
    const prepared = await prepareInvitePrivateObject(
      {
        bucket: env.INVITE_PRIVATE_OBJECTS,
        kek: env.INVITE_PRIVATE_KEK,
        keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
      },
      requestId,
      0,
      { email: payload.email, displayName: payload.displayName, intent: payload.intent },
    );
    const marker = await createInvitePrivateReconciliationMarker(env, {
      requestId,
      submissionKey: `interest-attach:${interestId}`,
      objectDigest: prepared.ref.objectDigest,
      opaqueRef: prepared.ref.opaqueRef,
      now,
    });
    await putPreparedInvitePrivateObject(
      {
        bucket: env.INVITE_PRIVATE_OBJECTS,
        kek: env.INVITE_PRIVATE_KEK,
        keyVersion: env.INVITE_PRIVATE_KEK_VERSION,
      },
      prepared,
    );
    await admin.attach({
      ...base,
      referral: {
        teamId,
        tokenDigest: context.tokenDigest,
        emailDigest: context.emailDigest,
        requestId,
        receiptId: randomId("RCP"),
        withdrawalDigest: await sha(`interest-bridge:${interestId}:${actionSecret}`),
        consentVersion: "invite-consent-v1",
        key: `interest-attach:${interestId}`,
        now,
        ...prepared.ref,
      },
    });
    await env.INVITE_PRIVATE_OBJECTS?.delete(marker.key);
    return true;
  }
  throw new InputError("참여 문의 동작을 확인할 수 없습니다.");
}
