import type { CommunityLifecycleAdminStore } from "./community-lifecycle-runtime-store";
import { escapeSlackText } from "./community-messages";
import { InputError, list, object, string } from "./input";

type AdminMessage = {
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly text: string;
  readonly key: string;
  readonly now: string;
};

type AdminIdentity = {
  readonly SLACK_TEAM_ID: string;
  readonly COMMUNITY_CHANNEL_ID?: string;
  readonly COMMUNITY_PUBLIC_CHANNEL_ID?: string;
  readonly COMMUNITY_ADMIN_ID?: string;
};

export async function handleLifecycleAdminMessage(
  message: AdminMessage,
  env: AdminIdentity,
  store: Pick<CommunityLifecycleAdminStore, "candidate" | "restoreError">,
  reply: (text: string) => Promise<void>,
): Promise<boolean> {
  if (!message.text.startsWith("생애주기 ")) return false;
  if (
    !env.COMMUNITY_CHANNEL_ID ||
    env.COMMUNITY_CHANNEL_ID === env.COMMUNITY_PUBLIC_CHANNEL_ID ||
    message.teamId !== env.SLACK_TEAM_ID ||
    message.channelId !== env.COMMUNITY_CHANNEL_ID ||
    message.userId !== env.COMMUNITY_ADMIN_ID
  )
    throw new InputError("운영자 전용 기능입니다.");

  const inspect = /^생애주기 검토 ([UW][A-Z0-9]+)$/.exec(message.text);
  const correct = /^생애주기 정정 ([UW][A-Z0-9]+) (\d{1,9}) ([A-Za-z0-9._:-]{8,120})$/.exec(
    message.text,
  );
  if (!inspect && !correct) throw new InputError("생애주기 명령 형식이 올바르지 않습니다.");
  const targetId = inspect?.[1] ?? correct?.[1];
  if (!targetId) throw new InputError("회원 ID가 필요합니다.");
  const candidateValue = await store.candidate(
    message.teamId,
    env.COMMUNITY_PUBLIC_CHANNEL_ID ?? "",
    targetId,
  );
  if (candidateValue === null) throw new InputError("해당 회원의 생애주기를 찾을 수 없습니다.");
  const candidate = object(candidateValue);
  const revision = candidate.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new InputError("생애주기 버전을 확인할 수 없습니다.");
  const state = string(candidate.state);
  if (inspect) {
    const evaluations = list(candidate.evaluations)
      .slice(0, 7)
      .map((value) => {
        const row = object(value);
        return `${string(row.serviceDate)}: ${escapeSlackText(JSON.stringify({ eligible: row.eligible, exclusionReason: row.exclusionReason, signalKind: row.signalKind, candidate: row.candidate, explanation: row.explanation }))}`;
      });
    await reply(
      `생애주기 검토 · 상태 ${escapeSlackText(state)} · 버전 ${revision}\n${evaluations.join("\n") || "평가 기록 없음"}`,
    );
    return true;
  }
  if (!correct?.[3] || state !== "dormant" || revision !== Number(correct[2]))
    throw new InputError("정정 대상 상태 또는 버전이 일치하지 않습니다.");
  await store.restoreError(
    {
      actionId: "lifecycle_restore_error",
      teamId: message.teamId,
      channelId: env.COMMUNITY_PUBLIC_CHANNEL_ID ?? "",
      ownerId: targetId,
      revision,
      key: `admin:${message.key}`,
    },
    message.now,
    correct[3],
  );
  console.info(
    JSON.stringify({ event: "lifecycle_admin_correction", status: "applied", count: 1 }),
  );
  await reply("생애주기 정정을 기록했습니다.");
  return true;
}
