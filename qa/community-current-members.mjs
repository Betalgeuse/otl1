import assert from "node:assert/strict";
import { collectCurrentChannelMembers } from "../src/community-membership.ts";

const originalFetch = globalThis.fetch;
const calls = [];
let active = 0;
let peak = 0;
try {
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith("conversations.members")) {
      const cursor = parsed.searchParams.get("cursor");
      return cursor
        ? Response.json({
            ok: true,
            members: ["U3", "U4", "U5", "U6"],
            response_metadata: { next_cursor: "" },
          })
        : Response.json({
            ok: true,
            members: ["U1", "U2", "U3"],
            response_metadata: { next_cursor: "next" },
          });
    }
    if (parsed.pathname.endsWith("users.info")) {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      const id = parsed.searchParams.get("user");
      return Response.json({
        ok: true,
        user: { id, deleted: id === "U2", is_bot: id === "U3", is_app_user: id === "U4" },
      });
    }
    throw new Error(`unexpected ${url}`);
  };

  const snapshot = await collectCurrentChannelMembers(
    "token",
    "CPUBLIC",
    "U6",
    "2026-09-17T09:00:00.000Z",
  );
  assert.deepEqual(
    snapshot.members.map((member) => member.userId),
    ["U1", "U2", "U3", "U4", "U5", "U6"],
  );
  assert.deepEqual(snapshot.eligibleHumanIds, ["U1", "U5"]);
  assert.equal(snapshot.observedAt, "2026-09-17T09:00:00.000Z");
  assert.ok(peak <= 5);
  assert.equal(calls.filter((call) => call.pathname.endsWith("conversations.members")).length, 2);

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("conversations.members"))
      return Response.json({
        ok: true,
        members: ["U1"],
        response_metadata: { next_cursor: "next" },
      });
    return Response.json({
      ok: true,
      user: { id: "U1", deleted: false, is_bot: false, is_app_user: false },
    });
  };
  await assert.rejects(
    () => collectCurrentChannelMembers("token", "CPUBLIC", "UBOT", "2026-09-17T09:00:00.000Z"),
    /cursor/i,
  );
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("conversations.members"))
      return Response.json({
        ok: true,
        members: ["U1", "U2"],
        response_metadata: { next_cursor: "" },
      });
    const id = parsed.searchParams.get("user");
    return id === "U2"
      ? Response.json({ ok: false, error: "profile_unavailable" })
      : Response.json({
          ok: true,
          user: { id, name: "one", deleted: false, is_bot: false, is_app_user: false },
        });
  };
  await assert.rejects(
    () => collectCurrentChannelMembers("token", "CPUBLIC", "UBOT", "2026-09-17T10:00:00.000Z"),
    /profile_unavailable/,
  );
  console.log(
    "PASS current member snapshot: paginated, deduplicated, bounded human classification and partial failure closed",
  );
} finally {
  globalThis.fetch = originalFetch;
}
