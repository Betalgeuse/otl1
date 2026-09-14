import { classifyRecordEdit, parseEditDate } from "./community-edit-language";
import { communityConfirmationMessage } from "./community-messages";
import { type CommunityContext, ephemeral, scopedValue } from "./community-runtime";
import type { DayChange } from "./community-types";
import { InputError, koreaDate, object, string } from "./input";

export async function prepareRecordEdit(context: CommunityContext, text: string): Promise<boolean> {
  const hasDate = /어제|그제|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}월\s*\d{1,2}일/.test(text);
  const hasEdit = /수정|바꿔|바꾸|정정|변경/.test(text) && /목표|원씽|후기/.test(text);
  if (!hasEdit && !(hasDate && /달성|완료|했|쉬|후기/.test(text))) return false;
  if (text.length > 1000) {
    await ephemeral(context, { text: "수정할 내용을 1,000자 이내로 알려주세요." });
    return true;
  }
  const history = await context.store.history(context.scope);
  const today = koreaDate(Date.now() / 1000);
  let target: ReturnType<typeof parseEditDate>;
  try {
    target = parseEditDate(
      text,
      today,
      history.map((d) => d.date),
    );
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    await ephemeral(context, { text: error.message });
    return true;
  }
  if (!target && /이전|지난|과거/.test(text)) {
    await ephemeral(context, {
      text: "수정할 날짜를 알려주세요. 예: ‘9/13 목표를 책 20쪽 읽기로 바꿔줘’.",
    });
    return true;
  }
  const targetDate = target?.date ?? context.date;
  const day = history.find((d) => d.date === targetDate);
  if (!day?.goal) {
    await ephemeral(context, {
      text: `${targetDate}에는 수정할 ONE THING이 없어요. 날짜를 다시 확인해 주세요.`,
    });
    return true;
  }
  if (!context.env.AI) {
    await ephemeral(context, {
      text: "수정 내용을 해석할 수 없어요. 잠시 후 다시 알려주세요. 기록은 유지했어요.",
    });
    return true;
  }
  const allowed = await context.env.INTENT_RATE_LIMITER?.limit({
    key: `community:${context.scope.userId}`,
  });
  if (allowed && !allowed.success) {
    await ephemeral(context, { text: "잠시 후 다시 수정해 주세요. 기록은 유지했어요." });
    return true;
  }
  const edit = await classifyRecordEdit(context.env.AI, target?.text ?? text);
  if (edit.kind === "unclear") {
    await ephemeral(context, {
      text: `${targetDate}의 어떤 내용을 바꿀까요? 목표 제목, 완료 여부, 후기를 구분해 알려주세요. 아직 수정하지 않았어요.`,
    });
    return true;
  }
  const key = `edit:${context.key}`;
  await context.store.putRecord({
    ...context.scope,
    key,
    kind: "pending",
    body: {
      action: "edit",
      changeAction: edit.kind,
      text: edit.text,
      outcome: edit.outcome,
      date: targetDate,
      revision: day.revision,
      source: context.source,
      thread: context.thread,
    },
  });
  const labels = {
    complete: "완료",
    partial: "일부 진행",
    not_done: "미완료",
    rest: "휴식",
    goal: "목표 내용",
    reflection: "후기",
  };
  const before =
    edit.kind === "goal"
      ? day.goal
      : edit.kind === "reflection"
        ? day.reflection || "아직 없음"
        : day.resting
          ? "휴식"
          : day.outcome;
  const next = edit.text ?? labels[edit.kind];
  await ephemeral(
    context,
    communityConfirmationMessage(
      `${targetDate} ONE THING 수정 확인\n대상 목표: ${day.goal}\n변경 항목: ${labels[edit.kind]}\n이전: ${before}\n수정: ${next}${edit.outcome ? `\n완료 여부: ${labels[edit.outcome]}` : ""}\n${edit.kind === "goal" ? "후기·완료 여부·휴식은 그대로 유지해요." : "이 날짜의 기록만 바꿔요."}`,
      [
        {
          label: "이 날짜 기록 수정",
          actionId: "community_confirm",
          value: scopedValue(context.scope, key),
        },
      ],
    ),
  );
  return true;
}

export function confirmedRecordEdit(base: Omit<DayChange, "action">, body: unknown): DayChange {
  const data = object(body);
  const action = string(data.changeAction);
  if (action === "goal") return { ...base, action, text: string(data.text), preserveOutcome: true };
  if (action === "reflection") {
    const outcome = data.outcome;
    if (
      outcome !== null &&
      outcome !== "complete" &&
      outcome !== "partial" &&
      outcome !== "not_done"
    )
      throw new InputError("수행 상태를 확인해 주세요.");
    return { ...base, action, text: string(data.text), ...(outcome ? { outcome } : {}) };
  }
  if (action === "complete" || action === "partial" || action === "not_done" || action === "rest")
    return { ...base, action };
  throw new InputError("수정 항목을 확인해 주세요.");
}
