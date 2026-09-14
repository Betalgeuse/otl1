import { escapeSlackText, slackMention } from "./community-messages";
import { requireCommunityAdmin } from "./community-permissions";
import { RELEASES } from "./community-releases";
import { type CommunityContext, post, scopedValue, textReply } from "./community-runtime";
import { InputError, object, string } from "./input";

export { publishRelease, releasePreview } from "./community-releases";

function adminScope(context: CommunityContext) {
  const adminId = context.env.COMMUNITY_ADMIN_ID;
  if (!adminId) throw new InputError("운영자 설정이 필요합니다.");
  return { ...context.scope, userId: adminId };
}

export async function adminCommand(context: CommunityContext, text: string): Promise<boolean> {
  if (!["회원 현황", "업데이트 관리", "피드백 보기"].includes(text.trim())) return false;
  requireCommunityAdmin(context.scope, context.env);
  switch (text.trim()) {
    case "회원 현황": {
      const days = await context.store.listDays(
        context.scope.teamId,
        context.env.COMMUNITY_PUBLIC_CHANNEL_ID ?? context.scope.channelId,
        context.date,
      );
      const labels = {
        pending: "완료 여부 미확인",
        complete: "완료",
        partial: "일부 진행",
        not_done: "미수행",
      } as const;
      const rows = days.map(
        (day) =>
          `${slackMention(day.userId)} · *ONE THING* ${day.goal ? "등록" : "미등록"} · ${day.resting ? "휴식" : labels[day.outcome]} · 후기 ${day.reflection ? "제출" : "미제출"}`,
      );
      await textReply(
        context,
        `${context.date} 회원 현황\n${rows.join("\n") || "아직 기록한 회원이 없어요."}`,
      );
      return true;
    }
    case "업데이트 관리":
      await post(context, {
        text: "게시할 업데이트 버전을 선택해 주세요. 미리보기 후에만 게시됩니다.",
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              text: "게시할 업데이트 버전을 선택해 주세요. 미리보기 후에만 게시됩니다.",
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "static_select",
                action_id: "community_release_preview",
                placeholder: { type: "plain_text", text: "업데이트 버전 선택" },
                options: RELEASES.map((entry) => ({
                  text: { type: "plain_text", text: entry.version },
                  value: scopedValue(context.scope, entry.version),
                })),
              },
            ],
          },
        ],
      });
      return true;
    case "피드백 보기": {
      const target = context.env.COMMUNITY_RELEASE_CHANNEL_ID;
      if (!target) throw new InputError("피드백 채널을 설정해 주세요.");
      const records = await context.store.listRecords(
        { ...adminScope(context), channelId: target },
        "feedback",
      );
      const rows = records.slice(-20).map((record) => {
        const body = object(record.body);
        return `${escapeSlackText(string(body.version))} · ${slackMention(string(body.authorId))}\n${escapeSlackText(string(body.text))}`;
      });
      await textReply(
        context,
        `townhall 최근 피드백 ${rows.length}개\n${rows.join("\n\n") || "아직 남겨진 의견이 없어요."}`,
      );
      return true;
    }
    default:
      return false;
  }
}

export async function captureFeedback(context: CommunityContext, text: string): Promise<boolean> {
  if (!text.trim() || context.thread === context.source) return false;
  const scope = adminScope(context);
  const published = await context.store.getRecord({ ...scope, key: `release:${context.thread}` });
  if (published?.kind !== "release") return false;
  const version = string(object(published.body).version);
  const record = { ...scope, key: `feedback:${context.source}` };
  await context.store.putRecord({
    ...record,
    kind: "feedback",
    body: {
      authorId: context.scope.userId,
      text,
      version,
      source: context.source,
      thread: context.thread,
    },
  });
  if (await context.store.claimRecord(record)) {
    await textReply(context, "의견 남겨줘서 고마워요!! 이 버전의 피드백으로 기록했어요 🙌");
    await context.store.finishRecord(record, "sent");
  }
  return true;
}
