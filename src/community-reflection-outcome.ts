import { applyChange } from "./community-records";
import { type CommunityContext, post, textReply } from "./community-runtime";
import { callSlack } from "./community-social";
import type { CommunityDay, CommunityRecord, Outcome } from "./community-types";
import { type Json, koreaDate, object, string } from "./input";

const DELIVERY_KIND = "reflection_outcome_delivery";
const PENDING_KIND = "reflection_outcome";
const MAX_DELIVERY_ATTEMPTS = 3;

type ResolvedOutcome = Exclude<Outcome, "pending"> | "rest";

function pendingKey(sourceKey: string): string {
  return `reflection-outcome:${sourceKey}`;
}

function marker(key: string): string {
  return `reflection_outcome_${key.replace(/[^a-zA-Z0-9]/g, "_").slice(-120)}`;
}

function questionMessage(context: CommunityContext, record: CommunityRecord): Json {
  const data = object(record.body);
  const targetDate = string(data.date);
  const dateLabel = targetDate === koreaDate(Date.now() / 1000) ? "오늘" : targetDate;
  const text = `${dateLabel} 결과는 완료·부분 완료·미완료·휴식 중 무엇인가요?`;
  const value = (outcome: ResolvedOutcome) =>
    JSON.stringify({
      ownerId: context.scope.userId,
      key: record.key,
      thread: string(data.thread),
      source: string(data.source),
      date: targetDate,
      revision: Number(data.revision),
      outcome,
    });
  return {
    text,
    blocks: [
      { block_id: marker(record.key), type: "section", text: { type: "plain_text", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "완료" },
            action_id: "community_complete",
            value: value("complete"),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "부분 완료" },
            action_id: "community_partial",
            value: value("partial"),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "미완료" },
            action_id: "community_not_done",
            value: value("not_done"),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "휴식" },
            action_id: "community_rest",
            value: value("rest"),
          },
        ],
      },
    ],
  };
}

async function acceptedQuestion(
  context: CommunityContext,
  record: CommunityRecord,
): Promise<boolean> {
  let cursor = "";
  do {
    const result = await callSlack(context.env.SLACK_BOT_TOKEN, "conversations.replies", {
      channel: context.scope.channelId,
      ts: context.thread,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (Array.isArray(result.messages))
      for (const message of result.messages) {
        const item = object(message);
        if (
          Array.isArray(item.blocks) &&
          item.blocks.some((block) => object(block).block_id === marker(record.key))
        )
          return true;
      }
    const metadata = result.response_metadata;
    cursor = metadata ? string(object(metadata).next_cursor) : "";
  } while (cursor);
  return false;
}

async function deliverQuestion(context: CommunityContext, record: CommunityRecord): Promise<void> {
  const deliveries = (await context.store.listRecords(context.scope, DELIVERY_KIND)).filter(
    (item) => object(item.body).pendingKey === record.key,
  );
  if (
    deliveries.some((item) => item.status === "sent") ||
    deliveries.length >= MAX_DELIVERY_ATTEMPTS
  )
    return;
  const attempt = deliveries.length + 1;
  const delivery = {
    ...context.scope,
    key: `reflection-outcome-question:${record.key}:${attempt}`,
    kind: DELIVERY_KIND,
    body: { pendingKey: record.key, attempt, source: context.source, thread: context.thread },
  };
  await context.store.putRecord(delivery);
  if (!(await context.store.claimRecord(delivery))) return;
  try {
    const message = questionMessage(context, record);
    if (!(attempt > 1 && (await acceptedQuestion(context, record)))) await post(context, message);
    await context.store.finishRecord(delivery, "sent");
  } catch (error) {
    await context.store.finishRecord(delivery, "failed");
    console.warn(
      JSON.stringify({
        event: "community.reflection_outcome.delivery_failed",
        type: error instanceof Error ? error.name : "Unknown",
        attempt,
      }),
    );
  }
}

export async function captureReflectionAwaitingOutcome(
  context: CommunityContext,
  day: CommunityDay,
): Promise<void> {
  const key = pendingKey(context.key);
  const record = await context.store.putRecord({
    ...context.scope,
    key,
    kind: PENDING_KIND,
    body: {
      date: day.date,
      revision: day.revision,
      source: context.source,
      thread: context.thread,
    },
  });
  if (record.status === "pending") await deliverQuestion(context, record);
}

function naturalOutcome(text: string): ResolvedOutcome | null {
  const normalized = text.trim().replace(/[.!。！\s]+$/u, "");
  if (/^(?:완료|완료했어요|다 했어요|끝냈어요)$/u.test(normalized)) return "complete";
  if (/^(?:부분\s*완료|부분완료|일부\s*완료|절반)$/u.test(normalized)) return "partial";
  if (/^(?:미완료|미완|못 했어요|못했어요|안 했어요|안했어요)$/u.test(normalized))
    return "not_done";
  if (/^(?:휴식|쉬었어요|쉬었음)$/u.test(normalized)) return "rest";
  return null;
}

export async function resolvePendingReflectionOutcome(
  context: CommunityContext,
  key: string,
  outcome: ResolvedOutcome,
  requireSourceBinding: boolean,
  binding?: { readonly date: string; readonly revision: number },
): Promise<boolean> {
  const pending = await context.store.getRecord({ ...context.scope, key });
  if (pending?.kind !== PENDING_KIND || pending.status !== "pending") return false;
  const data = object(pending.body);
  const targetDate = string(data.date);
  const expectedRevision = Number(data.revision);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    string(data.thread) !== context.thread ||
    (requireSourceBinding && string(data.source) !== context.source) ||
    (binding !== undefined &&
      (binding.date !== targetDate || binding.revision !== expectedRevision))
  )
    return false;
  const day = await context.store.day({ ...context.scope, date: targetDate });
  if (
    day.revision !== expectedRevision ||
    !day.reflection ||
    day.outcome !== "pending" ||
    day.resting
  )
    return false;
  await applyChange(
    { ...context, date: targetDate },
    {
      ...context.scope,
      date: targetDate,
      key: `outcome:${key}`,
      expectedRevision,
      action: outcome === "rest" ? "rest" : outcome,
    },
  );
  const applied = await context.store.day({ ...context.scope, date: targetDate });
  const matches =
    applied.revision === expectedRevision + 1 &&
    applied.reflection === day.reflection &&
    (outcome === "rest" ? applied.resting : applied.outcome === outcome && !applied.resting);
  if (!matches || !(await context.store.claimRecord({ ...context.scope, key }))) return false;
  await context.store.finishRecord({ ...context.scope, key }, "sent");
  return true;
}

export async function resolveNaturalReflectionOutcome(
  context: CommunityContext,
  text: string,
): Promise<boolean> {
  const outcome = naturalOutcome(text);
  if (!outcome) return false;
  const matches = (await context.store.listRecords(context.scope, PENDING_KIND)).filter(
    (record) => {
      if (record.status !== "pending") return false;
      const data = object(record.body);
      return data.thread === context.thread;
    },
  );
  if (!matches.length) return false;
  if (matches.length !== 1) {
    await textReply(context, "확인할 날짜가 여러 개예요. 날짜와 결과를 함께 알려주세요.");
    return true;
  }
  if (!(await resolvePendingReflectionOutcome(context, matches[0]?.key ?? "", outcome, false)))
    await textReply(context, "그 뒤에 기록이 바뀌었어요. 현재 상태를 확인하고 다시 알려주세요.");
  return true;
}

export async function replayReflectionOutcomeDelivery(context: CommunityContext): Promise<void> {
  const records = (await context.store.listRecords(context.scope, PENDING_KIND)).filter(
    (record) => {
      if (record.status !== "pending") return false;
      const data = object(record.body);
      return data.source === context.source && data.thread === context.thread;
    },
  );
  for (const record of records) await deliverQuestion(context, record);
}
