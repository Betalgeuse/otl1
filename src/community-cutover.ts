import { armCommunityClock } from "./community-clock";
import { requireCommunityAdmin } from "./community-permissions";
import { type CommunityContext, textReply } from "./community-runtime";
import { InputError } from "./input";

export async function enablePublicSchedule(context: CommunityContext): Promise<void> {
  requireCommunityAdmin(context.scope, context.env);
  const channel = context.env.COMMUNITY_PUBLIC_CHANNEL_ID;
  if (
    context.scope.userId !== context.env.COMMUNITY_ADMIN_ID ||
    !channel ||
    channel === context.scope.channelId
  )
    throw new InputError("운영자가 QA 채널에서 전환해 주세요.");
  if (!context.env.COMMUNITY_CLOCK) throw new InputError("예약 알람 연결을 확인하지 못했어요.");
  await context.store.setGroupSchedule(
    { ...context.scope, channelId: channel },
    { enabled: true, goalTime: "10:00", reviewTime: "18:00" },
  );
  const armed = await armCommunityClock(context.env, channel);
  if (armed.next === null)
    throw new InputError(
      "설정은 저장됐지만 다음 예약을 확인하지 못했어요. 기존 알림은 유지해 주세요.",
    );
  await textReply(
    context,
    `원씽 채널의 봇 안내를 켰어요. 매일 오전 10시 원씽, 오후 6시 후기입니다.\n다음 예약: ${new Date(armed.next + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ")} (한국 시간)\n기존 Slack 반복 알림은 별도로 제거해야 중복되지 않아요.`,
  );
}
