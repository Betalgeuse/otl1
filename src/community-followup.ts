import { isOptionalDay } from "./calendar";
import type { CommunityContext } from "./community-runtime";
import type { CommunityStore } from "./community-store";
import type { CommunityDay, CommunityScope } from "./community-types";
import { date, koreaDate, object, string } from "./input";

export function unresolvedDays(
  history: readonly CommunityDay[],
  before: string,
): readonly CommunityDay[] {
  return history
    .filter(
      (day) =>
        day.date < before &&
        !isOptionalDay(day.date) &&
        day.goal.trim() &&
        !day.resting &&
        (day.outcome === "pending" || !day.reflection.trim()),
    )
    .toSorted((a, b) => b.date.localeCompare(a.date));
}

export function earlierReviewChoices(
  history: readonly CommunityDay[],
  before: string,
  scope: CommunityScope,
) {
  return unresolvedDays(history, before)
    .slice(0, 3)
    .map((day) => ({
      label: `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))} 후기 남기기`,
      actionId: "community_past_review",
      value: JSON.stringify({
        ownerId: scope.userId,
        key: `past-review:${day.date}`,
        date: day.date,
        revision: day.revision,
      }),
    }));
}

export async function earlierDayNotice(
  context: CommunityContext,
  history: readonly CommunityDay[],
  before: string,
): Promise<string | null> {
  const missing = unresolvedDays(history, before);
  if (!missing.length) return null;
  const baselines = await context.store.listRecords(context.scope, "baseline");
  const lines = missing.slice(0, 3).map((day) => {
    const record = baselines.find((item) => object(item.body).date === day.date);
    const urls = record ? object(record.body).sourceUrls : null;
    const link = Array.isArray(urls)
      ? urls.find((value) => {
          if (typeof value !== "string") return false;
          try {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              url.hostname.endsWith(".slack.com") &&
              url.pathname.startsWith(`/archives/${context.scope.channelId}/p`) &&
              /^\/archives\/[^/]+\/p\d+$/.test(url.pathname)
            );
          } catch {
            return false;
          }
        })
      : null;
    const label =
      typeof link === "string" ? `<${link}|${day.date} ONE THING 글>` : `${day.date} ONE THING 글`;
    return `• ${label}: ${day.outcome === "pending" ? (day.reflection.trim() ? "완료 여부" : "완료 여부와 후기") : "후기"}`;
  });
  return `이전 *ONE THING*도 한 번 돌아봐요!!!\n${lines.join("\n")}\n해당 날짜 글의 스레드에 아직 남기지 않은 완료 여부나 후기를 알려주세요. 이미 쓴 후기는 다시 쓰지 않아도 돼요. 일부만 했다면 그대로, 쉬었던 날이면 쉬었다고 알려주세요.${missing.length > 3 ? `\n이외에 확인할 날짜가 ${missing.length - 3}일 더 있어요.` : ""}\n답변하지 않았다고 자동으로 미완료 처리하지 않아요.`;
}

export async function messageDate(
  store: Pick<CommunityStore, "getRecord">,
  scope: CommunityScope,
  adminId: string,
  source: string,
  thread: string,
): Promise<string> {
  const prompt = await store.getRecord({ ...scope, userId: adminId, key: `prompt:${thread}` });
  if (prompt?.kind === "prompt") return date(object(prompt.body).date);
  if (thread !== source) {
    const original = await store.getRecord({ ...scope, key: `incoming:${thread}` });
    if (original?.kind === "incoming") return date(object(original.body).date);
    return koreaDate(Number(string(thread)));
  }
  return koreaDate(Number(source));
}
