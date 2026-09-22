import assert from "node:assert/strict";
import { deliverReferralNotifications } from "../src/community-referral-notifications.ts";
import { CommunityReferralStore } from "../src/community-referral-store.ts";
import { NeonStore } from "../src/store.ts";
import { StoreError } from "../src/store-types.ts";

const connection = "postgresql://runtime:synthetic@fixture.neon.tech/neondb";
const originalFetch = globalThis.fetch;
const responses = [];
const calls = [];
const slackCalls = [];

globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://fixture.neon.tech/sql");
  calls.push(JSON.parse(init.body));
  const next = responses.shift();
  if (!next) throw new Error("missing Neon fixture response");
  return next;
};

const expectResponseError = async (response) => {
  responses.push(response);
  await assert.rejects(
    new NeonStore(connection).queryJson("SELECT fixture"),
    (error) => error instanceof StoreError && error.code === "response",
  );
};

try {
  // Given: Neon Raw Text + Array Mode represents SQL NULL as a null cell.
  responses.push(
    Response.json({ rows: [[null]] }),
    Response.json({ rows: [[null]] }),
    Response.json({ rows: [[null]] }),
    Response.json({ rows: [[null]] }),
  );
  const store = new NeonStore(connection);
  const referrals = new CommunityReferralStore(store, {
    teamId: "TQA",
    channelId: "CPUBLIC",
    userId: "UADMIN",
  });
  const slack = { async postAdmin(input) { slackCalls.push(input); } };

  // When: an optional value, an admin-review claim, a notification claim, and a submission lookup
  // all receive the production-shaped empty result.
  const [optional, adminReview, notifications, submission] = await Promise.all([
    store.queryJson("SELECT NULL::jsonb"),
    referrals.claimAdminReview("2026-09-21T00:00:00.000Z"),
    deliverReferralNotifications({
      db: store,
      teamId: "TQA",
      adminId: "UADMIN",
      slack,
      now: Date.parse("2026-09-21T00:00:00.000Z"),
    }),
    referrals.findSubmission("TQA", "missing-submission"),
  ]);

  // Then: the empty queue is observable as null and cannot cause an external Slack effect.
  assert.equal(optional, null);
  assert.equal(adminReview, null);
  assert.deepEqual(notifications, { processed: 0, possiblyMore: false });
  assert.equal(submission, null);
  assert.deepEqual(slackCalls, []);

  // Given: a valid JSON text cell spelling JSON null.
  responses.push(Response.json({ rows: [["null"]] }));
  // When: it is decoded by the existing raw-text path.
  const jsonNull = await new NeonStore(connection).queryJson("SELECT 'null'::jsonb");
  // Then: it remains JavaScript null.
  assert.equal(jsonNull, null);

  // Given: malformed structural or raw JSON transport results.
  // When: they cross the transport boundary.
  // Then: only the exact SQL NULL cell is accepted; absent, non-string, and malformed cells fail closed.
  await expectResponseError(Response.json({ rows: [] }));
  await expectResponseError(Response.json({ rows: [[]] }));
  await expectResponseError(Response.json({ rows: [[42]] }));
  await expectResponseError(Response.json({ rows: [["{"]] }));

  responses.push(Response.json({ code: "XX000" }, { status: 500 }));
  await assert.rejects(
    new NeonStore(connection).queryJson("SELECT unavailable"),
    (error) => error instanceof StoreError && error.code === "unavailable",
  );

  assert.equal(calls.length, 10);
  console.log("PASS referral empty queues decode SQL NULL without Slack effects and reject malformed cells");
} finally {
  globalThis.fetch = originalFetch;
}
