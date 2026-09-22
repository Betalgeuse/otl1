import { mock } from "bun:test";
import assert from "node:assert/strict";

const applied = [];
const confirmed = [];
const questions = [];
mock.module("../src/community-records.ts", () => ({
  applyChange: async (context, change) => {
    applied.push({ context, change });
    context.store.current = {
      ...context.store.current,
      reflection: change.text,
      revision: context.store.current.revision + 1,
    };
  },
  confirmChange: async (...args) => confirmed.push(args),
}));
mock.module("../src/community-reflection-outcome.ts", () => ({
  captureReflectionAwaitingOutcome: async (...args) => questions.push(args),
  resolveNaturalReflectionOutcome: async () => false,
}));
mock.module("../src/community-runtime.ts", () => ({ ephemeral: async () => undefined }));

const { handleReflectionReport } = await import("../src/community-reflection.ts");
const originalNow = Date.now;
Date.now = () => Date.parse("2026-09-18T03:00:00Z");
const scope = { teamId: "TQA", channelId: "CPUBLIC", userId: "UYUNSU" };
const day = {
  ...scope,
  date: "2026-09-15",
  goal: "2027년 메인 프로젝트 아이템 구상",
  outcome: "pending",
  reflection: "",
  resting: false,
  revision: 1,
};
const store = {
  current: day,
  async history() {
    return [this.current];
  },
  async day() {
    return this.current;
  },
};
const context = {
  env: {},
  key: "incoming:1789541204.889939",
  scope,
  source: "1789541204.889939",
  thread: "1789432863.093679",
  date: "2026-09-15",
  store,
};

try {
  const text = "후기: 자료조사 대략적인 방향성/진행안, 의사결정 필요한 내용 정리";
  assert.equal(await handleReflectionReport(context, text), true);
  assert.equal(applied.length, 1, "reflection must be canonical before an optional status answer");
  assert.equal(applied[0].change.action, "reflection");
  assert.equal(applied[0].change.outcome, undefined);
  assert.equal(applied[0].change.date, "2026-09-15");
  assert.equal(applied[0].change.expectedRevision, 1);
  assert.equal(confirmed.length, 0, "reflection storage must not require a button");
  assert.equal(questions.length, 1, "an optional public outcome question must follow storage");

  store.current = { ...day, revision: 1 };
  const numericContext = {
    ...context,
    key: "incoming:1789541205.000001",
    source: "1789541205.000001",
  };
  assert.equal(await handleReflectionReport(numericContext, "후기: 3시간 정리 ABC123"), true);
  assert.equal(applied.at(-1).change.text, "3시간 정리 ABC123");
  assert.equal(applied.at(-1).change.date, "2026-09-15");
  assert.equal(confirmed.length, 0, "body digits do not become a target date warning");

  store.current = { ...day, revision: 1 };
  const reasonContext = {
    ...context,
    key: "incoming:1789541206.000001",
    source: "1789541206.000001",
  };
  assert.equal(await handleReflectionReport(reasonContext, "후기: 어제보다 v2 정리를 2배 빠르게 했어요"), true);
  assert.equal(applied.at(-1).change.text, "어제보다 v2 정리를 2배 빠르게 했어요");
  assert.equal(applied.at(-1).change.date, "2026-09-15");
  console.log("PASS historical, numeric and reason-word reflections store body-only");
} finally {
  Date.now = originalNow;
}
