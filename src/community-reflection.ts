import { applyChange, confirmChange } from "./community-records";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { InputError, koreaDate } from "./input";
import { parseReflectionHeader } from "./reflection-header";

export async function handleReflectionReport(
  context: CommunityContext,
  text: string,
): Promise<boolean> {
  const today = koreaDate(Date.now() / 1000);
  let report: ReturnType<typeof parseReflectionHeader>;
  try {
    report = parseReflectionHeader(text, today);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    await ephemeral(context, { text: error.message });
    return true;
  }
  if (!report) {
    if (
      /^(?:[\s*#>-]*)(?:(?:\[?\d[\d./\-월일\s]*\]?)[\s:：]*)?(?:후기|회고)[\s*]*[:：\n]/u.test(text)
    ) {
      await ephemeral(context, {
        text: "후기에서 완료 여부를 확실히 구분하지 못했어요. ‘완료’, ‘부분 완료’, ‘미완료’, ‘휴식’ 중 상태와 후기를 알려주세요. 기록은 바꾸지 않았어요.",
      });
      return true;
    }
    return false;
  }
  const targetDate = report.date ?? context.date;
  const day = (await context.store.history(context.scope)).find((d) => d.date === targetDate);
  if (!day?.goal) {
    await ephemeral(context, {
      text: `${targetDate}에는 등록된 원씽이 없어요. 목표와 날짜를 먼저 확인해 주세요. 후기는 아직 저장하지 않았어요.`,
    });
    return true;
  }
  const target = { ...context, date: targetDate };
  if (
    targetDate !== today ||
    day.reflection.trim() ||
    day.resting ||
    (day.outcome !== "pending" && day.outcome !== report.outcome)
  ) {
    await confirmChange(
      target,
      day,
      report.text,
      report.outcome === "rest" ? "rest" : "reflection",
    );
    return true;
  }
  const base = {
    ...context.scope,
    date: targetDate,
    key: `change:${context.source}`,
    expectedRevision: day.revision,
  };
  await applyChange(
    target,
    report.outcome === "rest"
      ? { ...base, action: "rest" }
      : { ...base, action: "reflection", text: report.text, outcome: report.outcome },
  );
  return true;
}
