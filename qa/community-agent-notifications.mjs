import assert from "node:assert/strict";
import { sendAgentNotifications } from "../src/community-agent-notifications.ts";

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const body = options.body ? JSON.parse(options.body) : {};
  calls.push({ url: parsed.toString(), body });
  if (parsed.pathname === "/sql") {
    if (body.query.includes("bug_runner_claim_notifications"))
      return Response.json({
        rows: [
          [
            JSON.stringify([
              {
                notification_id: 7,
                bug_id: "BUG-ABCDEF123456",
                channel_id: "CFEEDBACK",
                thread_ts: "1790252981.933479",
                kind: "change_merged",
                payload: {
                  taskUrl:
                    "https://chatgpt.com/codex/tasks/task_e_0123456789abcdef0123456789abcdef",
                  attempt: 1,
                  reporterId: "UREPORTER",
                  adminId: "UADMIN",
                  summary: "입력 경계를 수정하고 회귀 검사를 통과했습니다.",
                },
              },
            ]),
          ],
        ],
      });
    if (body.query.includes("bug_runner_finish_notification"))
      return Response.json({ rows: [[JSON.stringify({ status: "sent" })]] });
  }
  if (parsed.pathname.endsWith("/chat.postMessage"))
    return Response.json({ ok: true, ts: "1790253000.000001" });
  if (parsed.pathname.endsWith("/reactions.remove") || parsed.pathname.endsWith("/reactions.add"))
    return Response.json({ ok: true });
  throw new Error(`unexpected request ${parsed.pathname}`);
};
try {
  const result = await sendAgentNotifications(
    {
      SLACK_TEAM_ID: "TQA",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATABASE_URL:
        "postgresql://runtime:secret@ep-example-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
    },
    new Date("2026-09-24T13:00:00Z"),
  );
  assert.deepEqual(result, { claimed: 1, sent: 1, failed: 0 });
  const post = calls.find((call) => call.url.includes("chat.postMessage"));
  assert.equal(post.body.thread_ts, "1790252981.933479");
  assert.match(post.body.text, /<@UADMIN> <@UREPORTER>/);
  assert.match(post.body.text, /입력 경계를 수정하고 회귀 검사를 통과했습니다/);
  assert.doesNotMatch(post.body.text, /github[.]com/);
  assert.doesNotMatch(post.body.text, /chatgpt[.]com/);
  const reactionMethods = calls
    .filter((call) => call.url.includes("reactions."))
    .map((call) => new URL(call.url).pathname.split("/").at(-1));
  assert.deepEqual(reactionMethods, ["reactions.remove", "reactions.add"]);
  const finish = calls.find((call) => call.body.query?.includes("bug_runner_finish_notification"));
  assert.match(finish.body.params[0], /"status":"sent"/);
  console.log("PASS agent notifications: merged result returns to the exact feedback thread and loading becomes check");
} finally {
  globalThis.fetch = originalFetch;
}
