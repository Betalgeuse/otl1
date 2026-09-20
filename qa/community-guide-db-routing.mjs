import { mock } from "bun:test";
import assert from "node:assert/strict";

const stores = [];
const operations = [];
mock.module("../src/store.ts", () => ({
  NeonStore: class {
    constructor(url) {
      stores.push(url);
    }
    async queryJson(sql, params) {
      operations.push({ sql, op: params[0] });
      if (params[0] === "publish") return JSON.parse(params[1]).hash;
      if (params[0] === "latest" || params[0] === "repair_latest")
        return {
          version: "v0.0.55",
          hash: "a".repeat(64),
          body: "safe",
          orderedFileIds: ["FLOGO1", "FDAILY2"],
        };
      return true;
    }
  },
}));

const { deliverWelcomeGuide, executeWelcomeGuideCommand, replaceWelcomeGuideForUser } =
  await import("../src/community-guide.ts");
const env = {
  SLACK_TEAM_ID: "TQA",
  SLACK_BOT_TOKEN: "xoxb",
  DATABASE_URL: "postgresql://general",
  GUIDE_DATABASE_URL: "postgresql://runtime",
  GUIDE_ADMIN_DATABASE_URL: "postgresql://admin",
  BOARD_SIGNING_SECRET: "unused",
  PUBLIC_BASE_URL: "unused",
  COMMUNITY_WELCOME_CHANNEL_ID: "CWELCOME",
  COMMUNITY_BOT_USER_ID: "UBOT",
  COMMUNITY_ADMIN_ID: "UADMIN",
  COMMUNITY_GUIDE_FILE_IDS: "FLOGO1,FDAILY2",
};
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("conversations.history"))
    return Response.json({
      ok: true,
      messages: [
        {
          ts: "123.456",
          user: "UADMIN",
          text: body,
          files: [{ id: "FLOGO1" }, { id: "FDAILY2" }],
          edited: { ts: "123.789" },
        },
      ],
    });
  if (parsed.pathname.endsWith("users.info"))
    return Response.json({
      ok: true,
      user: { id: parsed.searchParams.get("user"), is_bot: false, deleted: false },
    });
  if (parsed.pathname.endsWith("chat.postMessage"))
    return Response.json({ ok: true, ts: "456.789", message: { user: "UBOT", bot_id: "BGUIDE" } });
  throw new Error(`unexpected endpoint ${parsed.pathname} ${String(options?.method)}`);
};

await executeWelcomeGuideCommand({ kind: "publish", apply: true }, env);
await replaceWelcomeGuideForUser("UREPAIR", env);
await deliverWelcomeGuide(
  { type: "member_joined_channel", channel: "CWELCOME", user: "UJOIN" },
  env,
);

assert.deepEqual(stores, ["postgresql://admin", "postgresql://admin", "postgresql://runtime"]);
assert.ok(
  operations.some(({ sql, op }) => sql.includes("guide_admin_execute") && op === "publish"),
);
assert.ok(
  operations.some(({ sql, op }) => sql.includes("guide_admin_execute") && op === "repair_claim"),
);
assert.ok(
  operations.some(({ sql, op }) => sql.includes("guide_runtime_execute") && op === "claim"),
);
assert.ok(operations.every(({ sql }) => !sql.includes("guide_execute(")));
console.log("PASS welcome publisher/repair use admin DB while join delivery uses runtime-only DB");
