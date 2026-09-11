import { communityConfirmationMessage } from "./community-messages";
import { requireCommunityAdmin } from "./community-permissions";
import { type CommunityContext, post, scopedValue, textReply } from "./community-runtime";
import { callSlack } from "./community-social";
import { InputError, object, string } from "./input";

export const RELEASES = [
  {
    version: "v0.0.1",
    text: "오늘 원씽을 채널에 한 문장으로 남겨주세요! 등록 결과와 잔디를 보여주고, 잘못 등록했다면 되돌릴 수 있어요. 써보시고 이 스레드에 의견 남겨주세요 🙌",
  },
  {
    version: "v0.0.19",
    text: "원씽을 아직 등록하지 않았다면 설정한 시각에 한 번 챙겨드려요. 개인 안내는 알림 설정에서 켜거나 끌 수 있어요. 불편한 점은 이 스레드에 남겨주세요!",
  },
  {
    version: "v0.0.20",
    text: "매일 오전 10시, 봇이 원씽을 적을 스레드를 열어요. 오늘 중요한 한 가지와 이유를 남겨주세요!!! 🌱",
  },
  {
    version: "v0.0.21",
    text: "매일 오후 6시, 봇이 후기 스레드를 열어요. 해낸 만큼과 느낀 점을 남겨주세요. 다 못했어도 괜찮아요! 📝",
  },
  {
    version: "v0.0.22",
    text: "기존 Slack 반복 알림을 우리 봇의 오전 10시·오후 6시 안내로 전환했어요. 원씽과 후기는 봇이 연 스레드에 남겨주세요!",
  },
] as const;

function controlScope(context: CommunityContext) {
  const userId = context.env.COMMUNITY_ADMIN_ID;
  const channelId = context.env.COMMUNITY_CHANNEL_ID;
  if (!userId || !channelId) throw new InputError("운영자 채널 설정이 필요합니다.");
  return { ...context.scope, userId, channelId };
}
function release(version: string) {
  const item = RELEASES.find((x) => x.version === version);
  if (!item) throw new InputError("등록되지 않은 업데이트입니다.");
  return item;
}
async function isVerified(context: CommunityContext, version: string): Promise<boolean> {
  const marker = await context.store.getRecord({
    ...controlScope(context),
    key: `verified-release:${version}`,
  });
  return marker?.kind === "qa_approval" && object(marker.body).verified === true;
}
export async function releasePreview(context: CommunityContext, version: string): Promise<void> {
  requireCommunityAdmin(context.scope, context.env);
  const item = release(version);
  if (!(await isVerified(context, version))) {
    await textReply(
      context,
      `${version} 미리보기 · 검증 전\n${item.text}\n검증이 끝나면 게시할 수 있어요.`,
    );
    return;
  }
  const target = context.env.COMMUNITY_RELEASE_CHANNEL_ID;
  if (!target || !/^C[A-Z0-9]+$/.test(target)) throw new InputError("게시 대상을 확인해 주세요.");
  const scope = controlScope(context);
  const key = `release-preview:${crypto.randomUUID()}`;
  await context.store.putRecord({
    ...scope,
    key,
    kind: "release_preview",
    body: { version, text: item.text, target, expiresAt: Date.now() + 30 * 60 * 1000 },
  });
  await post(
    context,
    communityConfirmationMessage(
      `${version} 미리보기 · 검증 완료\n게시 대상: ${target === context.scope.channelId ? "현재 채널" : "all-townhall"}\n${item.text}\n이 미리보기는 30분 동안 유효해요.`,
      [
        {
          label: target === context.scope.channelId ? "이 채널에 게시" : "townhall에 게시",
          actionId: "community_publish",
          value: scopedValue(scope, key),
        },
      ],
    ),
  );
}
export async function publishRelease(
  context: CommunityContext,
  previewKey: string,
  actionKey: string,
): Promise<void> {
  requireCommunityAdmin(context.scope, context.env);
  const control = controlScope(context);
  const preview = await context.store.getRecord({ ...control, key: previewKey });
  if (!previewKey.startsWith("release-preview:") || preview?.kind !== "release_preview")
    throw new InputError("업데이트 관리에서 새 미리보기를 열어 주세요.");
  const body = object(preview.body);
  const version = string(body.version);
  const item = release(version);
  const target = string(body.target);
  if (typeof body.expiresAt !== "number" || body.expiresAt < Date.now())
    throw new InputError("미리보기가 만료됐어요. 다시 열어 주세요.");
  if (target !== context.env.COMMUNITY_RELEASE_CHANNEL_ID || body.text !== item.text)
    throw new InputError("게시 대상이나 내용이 바뀌었어요. 미리보기를 다시 확인해 주세요.");
  if (!(await isVerified(context, version))) throw new InputError("검증 전에는 게시할 수 없어요.");
  if (!(await context.store.claimRecord({ ...control, key: previewKey }))) {
    await textReply(context, "이미 처리한 미리보기예요.");
    return;
  }
  const scope = { ...control, channelId: target };
  const dispatch = { ...scope, key: `release-dispatch:${version}` };
  await context.store.putRecord({
    ...dispatch,
    kind: "release_dispatch",
    body: { version, actionKey, previewKey },
  });
  if (!(await context.store.claimRecord(dispatch))) {
    await context.store.finishRecord({ ...control, key: previewKey }, "cancelled");
    await textReply(context, "이미 게시했거나 게시 처리 중인 업데이트예요.");
    return;
  }
  const sent = await callSlack(context.env.SLACK_BOT_TOKEN, "chat.postMessage", {
    channel: target,
    text: `${version}\n${item.text}`,
    unfurl_links: false,
  });
  const ts = string(sent.ts);
  await context.store.putRecord({
    ...scope,
    key: `release:${ts}`,
    kind: "release",
    body: { version, text: item.text, ts },
  });
  await context.store.finishRecord(dispatch, "sent");
  await context.store.finishRecord({ ...control, key: previewKey }, "sent");
  await textReply(context, `${version} 게시 완료! <#${target}>에서 확인할 수 있어요.`);
}
