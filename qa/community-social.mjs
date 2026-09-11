import assert from "node:assert/strict";
import { communityStatusMessage, communityConfirmationMessage, shoutoutSuggestionMessage, escapeSlackText } from "../src/community-messages.ts";
import { addReactions, removeReactions, callSlack, socialReactions } from "../src/community-social.ts";

// Given a partial outcome with a submitted reflection, when rendering, then state and reflection remain independent.
const card = communityStatusMessage({ userId: "U123", date: "2026-09-11", goal: "<@U456>", outcome: "partial", reflection: "five", rest: false, undoValue: "opaque", statusValue: "actor" });
assert.equal(card.blocks[1].text.type, "plain_text");
assert.equal(card.blocks.at(-1).elements[0].action_id, "community_undo");
assert.equal(card.blocks.at(-1).elements[0].value, "opaque");
assert.equal(escapeSlackText("<@U456> & <!channel>"), "&lt;@U456&gt; &amp; &lt;!channel&gt;");
assert.throws(() => communityConfirmationMessage("x", Array.from({ length: 6 }, () => ({ label: "x", actionId: "x", value: "x" }))));
assert.equal(shoutoutSuggestionMessage({ userId: "U123", text: "hi", value: "target" }).blocks[2].elements[0].action_id, "community_shoutout");

// Given the same user and event, when selecting reactions, then retries are stable and completion has a distinct anchor.
assert.deepEqual(socialReactions("U123", "E1", "registered"), socialReactions("U123", "E1", "registered"));
assert.notEqual(socialReactions("U123", "E1", "registered")[0], socialReactions("U123", "E1", "complete")[0]);
assert.equal(socialReactions("U123", "E1", "registered")[1], socialReactions("U123", "E2", "complete")[1]);

const originalFetch = globalThis.fetch;
const calls = [];
try {
  // Given a wire stub with an existing reaction, when adding, then only newly added names are returned for undo.
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json(JSON.parse(init.body).name === "seedling" ? { ok: false, error: "already_reacted" } : { ok: true });
  };
  assert.deepEqual(await addReactions("secret", { channel: "C1", ts: "123.1", names: ["seedling", "clap", "clap"] }), ["clap"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.timestamp, "123.1");
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  // Given a missing reaction, when removing, then no new change is reported.
  globalThis.fetch = async () => Response.json({ ok: false, error: "no_reaction" });
  assert.deepEqual(await removeReactions("secret", { channel: "C1", ts: "123.1", names: ["clap"] }), []);
  // Given API rejection, when posting, then failure cannot be mistaken for delivery.
  globalThis.fetch = async () => Response.json({ ok: false, error: "missing_scope" });
  await assert.rejects(callSlack("secret", "chat.postMessage", {}), (error) => error.code === "missing_scope");
  globalThis.fetch = async () => { throw new Error("secret token in upstream message"); };
  await assert.rejects(callSlack("secret", "chat.postMessage", {}), (error) => !error.message.includes("secret"));
} finally {
  globalThis.fetch = originalFetch;
}
console.log("community social: structure, actor values, stable reactions, undo ownership, API errors passed");
