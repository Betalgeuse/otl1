import { applyChange, confirmChange } from "./community-records";
import {
  captureReflectionAwaitingOutcome,
  resolveNaturalReflectionOutcome,
} from "./community-reflection-outcome";
import { type CommunityContext, ephemeral } from "./community-runtime";
import { InputError, koreaDate } from "./input";
import { parseReflectionDraftHeader, parseReflectionHeader } from "./reflection-header";

function hasReflectionSubstance(text: string): boolean {
  const body = text
    .replace(/^[\s*#>-]*(?:후기|회고)[\s*]*[:：\n]/u, "")
    .trim()
    .replace(
      /^(?:완료하지\s*못했어요|완료(?:했어요|했습니다|했다|\s*예정(?:입니다)?)?|부분\s*완료|일부\s*완료|미완료|미완|못\s*했어요|안\s*했어요|휴식|쉬었어요)[\s.!。！,:：]*/u,
      "",
    )
    .trim();
  return (
    !/[?？]/.test(text) &&
    !/(?:완료|미완|못\s*했|안\s*했|휴식|쉬었)/u.test(text) &&
    /[\p{L}\p{N}]/u.test(body)
  );
}

export async function handleReflectionReport(
  context: CommunityContext,
  text: string,
): Promise<boolean> {
  if (await resolveNaturalReflectionOutcome(context, text)) return true;
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
    let draft: ReturnType<typeof parseReflectionDraftHeader>;
    try {
      draft = parseReflectionDraftHeader(text, today);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      await ephemeral(context, { text: error.message });
      return true;
    }
    if (!draft) return false;
    if (/(?:목표|원씽|후기)(?:를|을)?[\s\S]*?(?:수정해|바꿔줘|정정해|변경해)/.test(text))
      return false;
    const targetDate = draft.date ?? context.date;
    const target = (await context.store.history(context.scope)).find(
      (day) => day.date === targetDate,
    );
    if (!target?.goal) {
      await ephemeral(context, {
        text: `${targetDate}에는 등록된 ONE THING이 없어요. 목표와 날짜를 먼저 확인해 주세요. 후기는 아직 저장하지 않았어요.`,
      });
      return true;
    }
    if (!hasReflectionSubstance(draft.text)) {
      await ephemeral(context, {
        text: "후기 내용과 수행 상태를 확실히 구분하지 못했어요. 완료·부분 완료·미완료·휴식 중 하나를 함께 알려주세요. 아직 저장하지 않았어요.",
      });
      return true;
    }
    const targetContext = { ...context, date: targetDate };
    await applyChange(targetContext, {
      ...context.scope,
      date: targetDate,
      key: `change:${context.key}`,
      expectedRevision: target.revision,
      action: "reflection",
      text: draft.text,
    });
    const stored = await context.store.day({ ...context.scope, date: targetDate });
    if (stored.reflection === draft.text && stored.outcome === "pending")
      await captureReflectionAwaitingOutcome(targetContext, stored);
    return true;
  }
  const targetDate = report.date ?? context.date;
  const day = (await context.store.history(context.scope)).find((d) => d.date === targetDate);
  if (!day?.goal) {
    await ephemeral(context, {
      text: `${targetDate}에는 등록된 ONE THING이 없어요. 목표와 날짜를 먼저 확인해 주세요. 후기는 아직 저장하지 않았어요.`,
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
      report.outcome === "rest" ? "rest" : report.hasReflection ? "reflection" : report.outcome,
    );
    return true;
  }
  const base = {
    ...context.scope,
    date: targetDate,
    key: `change:${context.key}`,
    expectedRevision: day.revision,
  };
  await applyChange(
    target,
    report.outcome === "rest"
      ? { ...base, action: "rest" }
      : report.hasReflection
        ? { ...base, action: "reflection", text: report.text, outcome: report.outcome }
        : { ...base, action: report.outcome },
  );
  return true;
}
