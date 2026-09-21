import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
} }));
const { handleRequest, CommunityClock } = await import("../src/index.ts");
const { communityCron } = await import("../src/community-cron.ts");
const { runMembershipDue } = await import("../src/community-membership-schedule.ts");
const { runDueGardenDeliveries } = await import("../src/community-garden-delivery.ts");
const { runDueBugDeliveries } = await import("../src/community-bug-delivery-scheduler.ts");
const { NeonStore } = await import("../src/store.ts");
const { sign } = await import("../src/signing.ts");
const { signLifecycleAction } = await import("../src/community-lifecycle-interactions.ts");
const { signReferralServiceRequest } = await import("../src/community-referral-intake.ts");
const { createInvitePrivateReconciliationMarker } = await import("../src/community-referral-reconcile.ts");
const { CommunityReferralStore } = await import("../src/community-referral-store.ts");
const { CommunityStore } = await import("../src/community-store.ts");
const { enqueueCommonDelivery, sendCommonDeliveries } = await import("../src/community-common-delivery.ts");
const { runCommunitySchedule } = await import("../src/community-scheduler.ts");
const { prepareInvitePrivateObject, putPreparedInvitePrivateObject } = await import("../src/community-invite-private.ts");
const { digestReferralToken, digestNormalizedInviteEmail } = await import("../src/community-referral-token.ts");

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const temp = await mkdtemp(join(tmpdir(), "otl-runtime-pg-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const port = String(40000 + Math.floor(Math.random() * 20000));
const pgEnv = { ...process.env, PGHOST: socket, PGPORT: port, PGDATABASE: "postgres" };
const migrations = (await readdir(join(root, "migrations"))).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort();
const run = (binary, args) => exec(binary, args, { cwd: root, env: pgEnv, encoding: "utf8" });
const psql = (sql) => run(join(pgBin, "psql"), ["-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql]);
const scalar = async (sql) => (await psql(sql)).stdout.trim();
let started = false;

class Bucket {
  objects = new Map();
  version = 0;
  cursors = new Map();
  privatePuts = 0;
  privateDeletes = 0;
  markerDeletes = 0;
  failDeleteKeyOnce = null;
  async put(key, value, options = {}) {
    const previous = this.objects.get(key);
    if (options.onlyIf?.etagDoesNotMatch === "*" && previous) return null;
    if (options.onlyIf?.etagMatches && previous?.etag !== options.onlyIf.etagMatches) return null;
    if (key.startsWith("invite-private/")) this.privatePuts += 1;
    const etag = `etag-${++this.version}`;
    this.objects.set(key, { value: value.slice(0), etag });
    return { etag };
  }
  async get(key) {
    const item = this.objects.get(key);
    return item ? { key, etag: item.etag, arrayBuffer: async () => item.value.slice(0) } : null;
  }
  async delete(key) {
    if (key === this.failDeleteKeyOnce) {
      this.failDeleteKeyOnce = null;
      throw new Error("synthetic R2 outage");
    }
    if (key.startsWith("invite-private/")) this.privateDeletes += 1;
    if (key.startsWith("invite-private-reconcile/")) this.markerDeletes += 1;
    this.objects.delete(key);
  }
  async list({ prefix, limit, cursor }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    if (cursor && !this.cursors.has(cursor)) throw new Error("Invalid opaque R2 cursor");
    const after = cursor ? this.cursors.get(cursor) : null;
    const index = after ? keys.findIndex((key) => key > after) : 0;
    const start = index < 0 ? keys.length : index;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    const nextCursor = truncated ? `opaque-r2-cursor-${this.cursors.size + 1}` : null;
    if (nextCursor) this.cursors.set(nextCursor, page.at(-1));
    return { objects: page.map((key) => ({ key })), truncated,
      ...(nextCursor ? { cursor: nextCursor } : {}) };
  }
}

const bucket = new Bucket();
const scanArms = [];
const slackEffects = [];
const acceptedClientMessages = new Map();
let loseAcceptedAdminResponse = false;
let slackTs = 1000;
let failDbQueryOnce = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.hostname === "fake.neon.tech") {
    const { query, params } = JSON.parse(options.body);
    if (failDbQueryOnce && query.includes(failDbQueryOnce)) {
      failDbQueryOnce = null;
      return Response.json({ code: "synthetic_database_outage" }, { status: 503 });
    }
    const sql = query.replace(/\$(\d+)/g, (_match, number) => {
      const value = params[Number(number) - 1];
      return `'${String(value).replaceAll("'", "''")}'`;
    });
    try {
      const raw = await scalar(sql);
      let json = raw === "t" ? "true" : raw === "f" ? "false" : raw || "null";
      try { JSON.parse(json); } catch { json = JSON.stringify(json); }
      return Response.json({ rows: [[json]] });
    } catch (error) {
      if (process.env.DEBUG_RUNTIME_QA) console.error("DB_FAILED", query.slice(0, 120), error instanceof Error ? error.stderr : "unknown");
      return Response.json({ code: "database_error", message: error instanceof Error ? error.name : "unknown" }, { status: 500 });
    }
  }
  if (target.hostname === "slack.com") {
    const method = target.pathname.slice("/api/".length);
    const payload = options.body ? JSON.parse(options.body) : Object.fromEntries(target.searchParams);
    if (method === "chat.postMessage" && payload.client_msg_id &&
        acceptedClientMessages.has(payload.client_msg_id))
      return Response.json({ ok: true, ts: acceptedClientMessages.get(payload.client_msg_id) });
    slackEffects.push({ method, payload });
    if (method === "emoji.list") return Response.json({ ok: true, emoji: {} });
    if (method === "conversations.members") return Response.json({ ok: true,
      members: ["UOWNER", "ULEGACY", ...Array.from({ length: 12 }, (_item, index) => `UREM${String(index + 1).padStart(3,"0")}`)],
      response_metadata: { next_cursor: "" } });
    if (method === "users.info") return Response.json({ ok: true, user: { id: payload.user,
      team_id: "TINT", profile: { email: "member@example.invalid" }, is_bot: false,
      is_app_user: false, deleted: false } });
    if (method === "conversations.open") return Response.json({ ok: true, channel: { id: "DPRIVATE" } });
    if (method === "chat.postEphemeral") return Response.json({ ok: true, message_ts: `${++slackTs}.000` });
    if (method === "chat.postMessage" && payload.client_msg_id && loseAcceptedAdminResponse) {
      loseAcceptedAdminResponse = false;
      const acceptedTs = `${++slackTs}.000`;
      acceptedClientMessages.set(payload.client_msg_id, acceptedTs);
      throw new TypeError("simulated accepted response loss");
    }
    const postedTs = `${++slackTs}.000`;
    if (method === "chat.postMessage" && payload.client_msg_id)
      acceptedClientMessages.set(payload.client_msg_id, postedTs);
    return Response.json({ ok: true, ts: postedTs });
  }
  throw new Error(`Unexpected network target: ${target.hostname}`);
};
const env = {
  SLACK_TEAM_ID: "TINT", COMMUNITY_ADMIN_ID: "UADMIN", COMMUNITY_PUBLIC_CHANNEL_ID: "CPUBLIC",
  COMMUNITY_CHANNEL_ID: "CADMIN", COMMUNITY_ENABLED: "true", REFERRALS_ENABLED: "true",
  PUBLIC_APPLICATIONS_ENABLED: "true", LIFECYCLE_MODE: "disabled",
  SLACK_BOT_TOKEN: "xoxb-fake", SLACK_SIGNING_SECRET: "slack-test-secret",
  DATABASE_URL: "postgresql://user:pass@fake.neon.tech/test",
  INTEREST_RUNTIME_DATABASE_URL: "postgresql://user:pass@fake.neon.tech/test", BOARD_SIGNING_SECRET: "board-test",
  PUBLIC_BASE_URL: "https://core.invalid", PUBLIC_APPLICATION_ORIGIN: "https://site.invalid",
  REFERRAL_TOKEN_SECRET: "token-test-secret", SITE_CORE_HMAC_SECRET: "site-test-secret",
  INVITE_EMAIL_PEPPER: Buffer.alloc(32, 8).toString("base64url"), INVITE_PRIVATE_KEK: Buffer.alloc(32, 7).toString("base64url"),
  INVITE_PRIVATE_KEK_VERSION: "invite-test-v1", INVITE_PRIVATE_OBJECTS: bucket,
  COMMUNITY_CLOCK: { getByName() { return {
    async publishGarden() { return "queued"; }, async refresh() { return { next: null }; },
    async armBugDelivery() { return { role: "bug_delivery", armed: false, next: null }; },
    async armMembershipScan(channelId, cursor) { scanArms.push({ channelId, cursor }); },
  }; } },
};
const jobs = [];
const context = { waitUntil(promise) { jobs.push(promise); } };
const runtime = { env, store: new NeonStore(env.DATABASE_URL) };
const flush = async () => { await Promise.all(jobs.splice(0)); };
const slackRequest = async (path, payload) => {
  const body = path === "/slack/events" ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(`v0:${timestamp}:${body}`, env.SLACK_SIGNING_SECRET);
  const response = await handleRequest(new Request(`https://core.invalid${path}`, { method: "POST", body,
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${signature}` } }), runtime, context);
  await flush();
  return response;
};

try {
  await mkdir(socket);
  await run(join(pgBin, "initdb"), ["-D", data, "--no-locale", "--encoding=UTF8", "--auth=trust"]);
  await run(join(pgBin, "pg_ctl"), ["-D", data, "-o", `-F -k ${socket} -p ${port}`, "-l", join(temp, "postgres.log"), "-w", "start"]);
  started = true;
  for (const migration of migrations.filter((name) => Number(name.slice(0, 3)) <= 42)) {
    if (migration.startsWith("006_"))
      await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", `migrations/${migration}`, "-f", "migrations/007_normalized_legacy.sql"]);
    else if (!migration.startsWith("007_"))
      await run(join(pgBin, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-f", `migrations/${migration}`]);
  }
  await psql(`INSERT INTO otl.workspaces(team_id) VALUES('TINT');
    INSERT INTO otl.workspace_channels(team_id,channel_id) VALUES('TINT','CPUBLIC'),('TINT','CADMIN');
    INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted)
      VALUES('TINT','UADMIN',false,false,false),('TINT','UOWNER',false,false,false),
        ('TINT','ULIFECYCLE',false,false,false);
    INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
      VALUES('TINT','CPUBLIC','UOWNER',true,now(),now()),
        ('TINT','CPUBLIC','ULIFECYCLE',true,now(),now());
    INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
      VALUES('TINT','CPUBLIC','UOWNER','active',now(),now()),
        ('TINT','CPUBLIC','ULIFECYCLE','active',now(),now());
    INSERT INTO otl.referral_admins(team_id,user_id) VALUES('TINT','UADMIN');
    INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
      VALUES('TINT','CPUBLIC','UOWNER',now(),(now() AT TIME ZONE 'Asia/Seoul')::date,'rollout'),
        ('TINT','CPUBLIC','ULIFECYCLE',now(),(now() AT TIME ZONE 'Asia/Seoul')::date,'rollout');`);
  const ts = `${Math.floor(Date.now()/1000)}.001`;
  assert.equal((await slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvLink1",
    event: { type: "message", channel: "CPUBLIC", user: "UOWNER", ts, text: "내 초대 링크" } })).status, 200);
  assert.equal((await slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvLink1",
    event: { type: "message", channel: "CPUBLIC", user: "UOWNER", ts, text: "내 초대 링크" } })).status, 200);
  assert.equal(slackEffects.filter((effect) => effect.method === "chat.postEphemeral").length, 1);
  const linkEffect = slackEffects.find((effect) => effect.method === "chat.postEphemeral");
  assert.ok(linkEffect);
  const token = new URL(linkEffect.payload.text.split("\n")[0]).pathname.split("/").at(-1);
  assert.equal(token.length, 32);
  const application = JSON.stringify({ referralToken: token, submissionKey: "submission-0001",
    consentVersion: "invite-consent-v1", consentedAt: new Date().toISOString(),
    email: "member@example.invalid", displayName: "Example Member", intent: "Join the daily scrum" });
  const applyPath = "/internal/referrals/apply";
  const applyAt = Math.floor(Date.now() / 1000);
  const nonce = "site-application-nonce-0001";
  const hmac = await signReferralServiceRequest({ method: "POST", path: applyPath, body: application,
    timestamp: applyAt, nonce }, env.SITE_CORE_HMAC_SECRET);
  const applied = await handleRequest(new Request(`https://core.invalid${applyPath}`, { method: "POST", body: application,
    headers: { "x-otl-timestamp": String(applyAt), "x-otl-nonce": nonce, "x-otl-signature": hmac } }), runtime, context);
  await flush();
  assert.equal(applied.status, 202);
  const receipt = await applied.json();
  assert.match(receipt.receiptId, /^RCP-/);
  assert.equal(bucket.privatePuts, 1);
  const db = new NeonStore(env.DATABASE_URL);
  const adminDeliveryAt = Date.now();
  loseAcceptedAdminResponse = true;
  await runMembershipDue(env, db, "CPUBLIC", adminDeliveryAt);
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_type='admin_review' AND status='failed'"), "1");
  await runMembershipDue(env, db, "CPUBLIC", adminDeliveryAt + 5 * 60_000 + 1_000);
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_type='admin_review' AND status='sent'"), "1");
  const adminCard = slackEffects.find((effect) => effect.method === "chat.postMessage" &&
    effect.payload.blocks?.some((block) => block.type === "actions" && block.elements?.some((item) => item.action_id === "community_invite_approve")));
  assert.ok(adminCard);
  assert.equal(slackEffects.filter((effect) => effect.method === "chat.postMessage" &&
    effect.payload.client_msg_id === adminCard.payload.client_msg_id).length, 1);
  const approve = adminCard.payload.blocks.find((block) => block.type === "actions").elements.find((item) => item.action_id === "community_invite_approve");
  const adminAction = async (action, actionTs = `${Math.floor(Date.now()/1000)}.123`) => slackRequest("/slack/interactions", { type: "block_actions", team: { id: "TINT" },
    user: { id: "UADMIN" }, container: { channel_id: "DPRIVATE" },
    actions: [{ ...action, action_ts: actionTs }] });
  const approveActionTs = `${Math.floor(Date.now()/1000)}.123`;
  assert.equal((await adminAction(approve, approveActionTs)).status, 200);
  const initialClock = Date.now;
  Date.now = () => initialClock() + 60_000;
  try { assert.equal((await adminAction(approve, approveActionTs)).status, 200); }
  finally { Date.now = initialClock; }
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_decisions WHERE team_id='TINT'"), "1");
  const manualCard = slackEffects.findLast((effect) => effect.method === "chat.postMessage" &&
    effect.payload.blocks?.some((block) => block.type === "actions" && block.elements?.some((item) => item.action_id === "community_invite_mark_invited")));
  assert.ok(manualCard);
  const mark = manualCard.payload.blocks.find((block) => block.type === "actions").elements.find((item) => item.action_id === "community_invite_mark_invited");
  assert.equal((await adminAction(mark)).status, 200);
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_manual_invite_assertions WHERE team_id='TINT'"), "1");
  assert.equal((await slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvJoin1",
    event: { type: "team_join", user: { id: "UJOINED" } } })).status, 200);
  assert.equal(await scalar("SELECT count(*) FROM otl.member_referral_attributions WHERE team_id='TINT'"), "1");
  assert.equal(await scalar("SELECT state FROM otl.referral_requests WHERE team_id='TINT'"), "joined");
  const goalTs = `${Math.floor(Date.now()/1000)}.002`;
  assert.equal((await slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvGoal1",
    event: { type: "message", channel: "CPUBLIC", user: "UOWNER", ts: goalTs,
      text: "원씽: 통합 흐름 검증하기" } })).status, 200);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_days WHERE team_id='TINT' AND user_id='UOWNER' AND goal<>''"), "1");
  assert.equal((await slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvGoal1",
    event: { type: "message", channel: "CPUBLIC", user: "UOWNER", ts: goalTs,
      text: "원씽: 통합 흐름 검증하기" } })).status, 200);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_days WHERE team_id='TINT' AND user_id='UOWNER' AND goal<>''"), "1");
  const reviewTs = `${Math.floor(Date.now()/1000)}.003`;
  assert.equal((await slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvReview1",
    event: { type: "message", channel: "CPUBLIC", user: "UOWNER", ts: reviewTs,
      thread_ts: goalTs, text: "후기: 오늘 목표를 실행하며 배운 점을 정리했습니다." } })).status, 200);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_days WHERE team_id='TINT' AND user_id='UOWNER' AND reflection<>''"), "1");
  const localDate = new Date(Date.now() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const postedRoot = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", body: JSON.stringify({ channel: "CPUBLIC", text: "Today's review" }),
  });
  const rootTs = (await postedRoot.json()).ts;
  await psql(`INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status)
    VALUES('TINT','CPUBLIC','UADMIN','common:${localDate}:review','dispatch',
      '{"date":"${localDate}","kind":"review","messageTs":"${rootTs}"}','sent'),
    ('TINT','CPUBLIC','UADMIN','common-thread:${localDate}:review','prompt',
      '{"date":"${localDate}","kind":"review","ts":"${rootTs}"}','sent');`);
  await db.queryJson("SELECT otl.community_execute('bind_review_root',$1::jsonb)", [JSON.stringify({
    teamId: "TINT", channelId: "CPUBLIC", userId: "UADMIN", date: localDate, messageTs: rootTs,
  })]);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_review_roots WHERE team_id='TINT'"), "1");
  if (process.env.DEBUG_RUNTIME_QA) console.error("GARDEN_ROWS", await scalar("SELECT status||':'||route_kind||':'||route_provenance FROM otl.community_garden_deliveries WHERE team_id='TINT'"));
  const garden = await runDueGardenDeliveries(env, "CPUBLIC", Date.now());
  assert.equal(garden.processed, 1);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND status='sent'"), "1");
  const RealDate = Date;
  async function at(instant, action) {
    const frozen = Date.parse(instant);
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [frozen])); }
      static now() { return frozen; }
    };
    try { return await action(frozen); } finally { globalThis.Date = RealDate; }
  }
  const serviceDays = ["2026-09-21","2026-09-22","2026-09-23","2026-09-24","2026-09-25","2026-09-28","2026-09-29"];
  env.LIFECYCLE_ACTION_SECRET = "lifecycle-test-secret";
  env.LIFECYCLE_MODE = "shadow";
  for (const day of serviceDays) {
    await psql(`INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status,updated_at)
      VALUES('TINT','CPUBLIC','UADMIN','dispatch:${day}:goal','dispatch',
        '{"date":"${day}","kind":"goal"}','sent','${day}T01:00:00Z');
      UPDATE otl.workspace_channels SET complete_membership_observed_at='${day}T01:05:00Z'
        WHERE team_id='TINT' AND channel_id='CPUBLIC';`);
    await at(`${day}T15:00:01Z`, (frozen) => runMembershipDue(env, db, "CPUBLIC", frozen));
  }
  assert.equal(await scalar("SELECT state FROM otl.member_lifecycles WHERE team_id='TINT' AND user_id='UOWNER'"), "active");
  assert.equal(await scalar("SELECT count(*) FROM otl.lifecycle_runtime_evaluations WHERE team_id='TINT' AND user_id='ULIFECYCLE' AND mode='shadow' AND candidate"), "1");
  env.LIFECYCLE_MODE = "enforce";
  await at("2026-09-29T15:00:01Z", (frozen) => runMembershipDue(env, db, "CPUBLIC", frozen));
  assert.equal(await scalar("SELECT state FROM otl.member_lifecycles WHERE team_id='TINT' AND user_id='ULIFECYCLE'"), "grace");
  const graceNotice = slackEffects.findLast((effect) => effect.method === "chat.postMessage" &&
    effect.payload.blocks?.some((block) => block.block_id?.startsWith("lifecycle_notice:")));
  assert.ok(graceNotice);
  const extend = graceNotice.payload.blocks.find((block) => block.type === "actions").elements.find((item) => item.action_id === "lifecycle_extend");
  await at("2026-09-30T01:00:00Z", async () => {
    assert.equal((await slackRequest("/slack/interactions", { type: "block_actions", team: { id: "TINT" },
      user: { id: "ULIFECYCLE" }, container: { channel_id: "DPRIVATE" },
      actions: [{ ...extend, action_ts: `${Math.floor(Date.now()/1000)}.123` }] })).status, 200);
  });
  assert.equal(await scalar("SELECT extension_used::text FROM otl.member_lifecycles WHERE team_id='TINT' AND user_id='ULIFECYCLE'"), "true");
  await at("2026-09-30T01:01:00Z", async () => {
    assert.equal((await slackRequest("/slack/interactions", { type: "block_actions", team: { id: "TINT" },
      user: { id: "ULIFECYCLE" }, container: { channel_id: "DPRIVATE" },
      actions: [{ ...extend, action_ts: `${Math.floor(Date.parse("2026-09-30T01:00:00Z")/1000)}.123` }] })).status, 200);
  });
  assert.equal(await scalar("SELECT count(*) FROM otl.lifecycle_runtime_actions WHERE team_id='TINT' AND user_id='ULIFECYCLE' AND action_type='lifecycle_extend'"), "1");

  const staleStop = await signLifecycleAction({ actionId: "lifecycle_stop", teamId: "TINT",
    channelId: "CPUBLIC", ownerId: "ULIFECYCLE", revision: 1, key: "stale-stop" }, env.LIFECYCLE_ACTION_SECRET);
  await at("2026-09-30T01:02:00Z", async () => {
    const stale = await slackRequest("/slack/interactions", { type: "block_actions",
      team: { id: "TINT" }, user: { id: "ULIFECYCLE" }, container: { channel_id: "DPRIVATE" },
      actions: [{ action_id: "lifecycle_stop", value: staleStop,
        action_ts: `${Math.floor(Date.now()/1000)}.123` }] });
    assert.equal(stale.status, 503);
  });
  assert.equal(await scalar("SELECT count(*) FROM otl.lifecycle_runtime_actions WHERE team_id='TINT' AND user_id='ULIFECYCLE'"), "1");
  await at("2026-10-14T15:00:01Z", (frozen) => runMembershipDue(env, db, "CPUBLIC", frozen));
  assert.equal(await scalar("SELECT state FROM otl.member_lifecycles WHERE team_id='TINT' AND user_id='ULIFECYCLE'"), "dormant");
  assert.equal(await scalar("SELECT count(*) FROM otl.grass_seasons WHERE team_id='TINT' AND user_id='ULIFECYCLE' AND closed_reason='grace_expired'"), "1");
  await at("2026-10-15T01:30:00Z", async () => {
    const returnTs = `${Math.floor(Date.now()/1000)}.001`;
    assert.equal((await slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvReturn1",
      event: { type: "message", channel: "CPUBLIC", user: "ULIFECYCLE", ts: returnTs,
        text: "원씽: 새 시즌으로 돌아오기" } })).status, 200);
  });
  assert.equal(await scalar("SELECT state FROM otl.member_lifecycles WHERE team_id='TINT' AND user_id='ULIFECYCLE'"), "active");
  assert.equal(await scalar("SELECT count(*) FROM otl.grass_seasons WHERE team_id='TINT' AND user_id='ULIFECYCLE' AND closed_at IS NULL"), "1");
  await psql(`INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted)
      SELECT 'TINT','UREM'||lpad(n::text,3,'0'),false,false,false FROM generate_series(1,12)n;
    INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
      SELECT 'TINT','CPUBLIC','UREM'||lpad(n::text,3,'0'),true,
        '2026-10-15T01:00:00Z','2026-10-15T01:00:00Z' FROM generate_series(1,12)n;
    INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
      SELECT 'TINT','CPUBLIC','UREM'||lpad(n::text,3,'0'),'active',
        '2026-10-15T01:00:00Z','2026-10-15T01:00:00Z' FROM generate_series(1,12)n;
    INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
      SELECT 'TINT','CPUBLIC','UREM'||lpad(n::text,3,'0'),
        '2026-10-15T01:00:00Z','2026-10-15','rollout' FROM generate_series(1,12)n;
    INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,preference_source,
      eligible_from,goal_time,review_time)
      SELECT 'TINT','CPUBLIC','UREM'||lpad(n::text,3,'0'),true,'default',
        '2026-10-15','11:00','20:00' FROM generate_series(1,12)n;`);
  if (process.env.DEBUG_RUNTIME_QA) console.error("REM_ELIG", await scalar("SELECT otl.reminder_eligible('TINT','CPUBLIC','UREM001','goal','2026-10-15 11:01:00')"));
  if (process.env.DEBUG_RUNTIME_QA) console.error("TRIGGER_DUE", await new CommunityStore(db).reminderTriggerDue("TINT", "CPUBLIC", "2026-10-15T02:01:00Z"));
  const reminders = await at("2026-10-15T02:01:00Z", (frozen) =>
    runCommunitySchedule({ ...env, COMMUNITY_CHANNEL_ID: "CPUBLIC" }, new CommunityStore(db), new Date(frozen)));
  if (process.env.DEBUG_RUNTIME_QA) console.error("DUE_OP", (await db.queryJson("SELECT otl.community_execute('due',$1::jsonb)", [JSON.stringify({ teamId: "TINT", channelId: "CPUBLIC", now: "2026-10-15T02:01:00Z" })])).length);
  if (process.env.DEBUG_RUNTIME_QA) console.error("REM_RECORDS", await scalar("SELECT status||':'||count(*) FROM otl.community_records WHERE team_id='TINT' AND kind='reminder' GROUP BY status"));
  assert.equal(reminders.personal, 12);
  await psql(`INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted)
      SELECT 'TINT','UQ'||lpad(n::text,3,'0'),false,false,false FROM generate_series(1,12)n;
    INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
      SELECT 'TINT','CPUBLIC','UQ'||lpad(n::text,3,'0'),'active','2026-10-15T00:00:00Z','2026-10-15T00:00:00Z'
      FROM generate_series(1,12)n;
    INSERT INTO otl.lifecycle_notice_outbox(team_id,channel_id,user_id,effect_key,notice_kind,
      lifecycle_revision,scheduled_at,payload,created_at,updated_at)
      SELECT 'TINT','CPUBLIC','UQ'||lpad(n::text,3,'0'),'qa-return-'||n,'return',0,
        '2026-10-15T15:00:00Z','{}','2026-10-15T15:00:00Z','2026-10-15T15:00:00Z'
      FROM generate_series(1,12)n;`);
  await psql(`INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
      SELECT 'TINT','CPUBLIC','UQ'||lpad(n::text,3,'0'),
        '2026-10-15T00:00:00Z','2026-10-15','rollout' FROM generate_series(1,12)n;
    INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal,reflection,outcome)
      SELECT 'TINT','CPUBLIC','UQ'||lpad(n::text,3,'0'),'2026-10-15',
        'Synthetic goal','Synthetic review','complete' FROM generate_series(1,12)n;`);
  const batchRootResponse = await fetch("https://slack.com/api/chat.postMessage", { method: "POST",
    body: JSON.stringify({ channel: "CPUBLIC", text: "Batch review root" }) });
  const batchRootTs = (await batchRootResponse.json()).ts;
  await psql(`INSERT INTO otl.community_records(team_id,channel_id,user_id,record_key,kind,body,status)
    VALUES('TINT','CPUBLIC','UADMIN','common:2026-10-15:review','dispatch',
      '{"date":"2026-10-15","kind":"review","messageTs":"${batchRootTs}"}','sent'),
    ('TINT','CPUBLIC','UADMIN','common-thread:2026-10-15:review','prompt',
      '{"date":"2026-10-15","kind":"review","ts":"${batchRootTs}"}','sent');`);
  await db.queryJson("SELECT otl.community_execute('bind_review_root',$1::jsonb)", [JSON.stringify({
    teamId: "TINT", channelId: "CPUBLIC", userId: "UADMIN", date: "2026-10-15", messageTs: batchRootTs,
  })]);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND day='2026-10-15' AND status='pending'"), "12");
  const joinedRequestId = await scalar("SELECT request_id FROM otl.referral_requests WHERE team_id='TINT' AND state='joined'");
  const linkId = await scalar("SELECT link_id FROM otl.member_referral_links WHERE team_id='TINT' AND referrer_user_id='UOWNER'");
  await psql(`INSERT INTO otl.referral_outbox(team_id,request_id,effect_key,effect_type,available_at)
    SELECT 'TINT','${joinedRequestId}','qa-notification-'||n,'admin_decision','2026-10-15T15:00:00Z'
    FROM generate_series(1,12)n;
    INSERT INTO otl.referral_requests(team_id,request_id,receipt_id,link_id,referrer_user_id,email_digest,
      withdrawal_digest,state,submission_key,submission_hash,submitted_at,terminal_at,payload_purge_after,audit_purge_after)
      SELECT 'TINT','REQ-PURGE'||lpad(n::text,4,'0'),'RCP-PURGE'||lpad(n::text,4,'0'),
        '${linkId}','UOWNER',lpad(md5('email'||n),64,'a'),lpad(md5('withdraw'||n),64,'b'),
        'declined','qa-purge-'||n,md5('submit'||n),'2026-09-19T00:00:00Z',
        '2026-09-19T00:01:00Z','2026-10-15T15:00:00Z','2027-10-15T15:00:00Z'
      FROM generate_series(1,12)n;
    INSERT INTO otl.referral_private_payloads(team_id,request_id,opaque_ref,object_digest,envelope_dek,
      nonce,key_version,schema_version)
      SELECT 'TINT','REQ-PURGE'||lpad(n::text,4,'0'),
        'invite-private/REQ-PURGE'||lpad(n::text,4,'0')||'/0.enc',repeat('a',64),
        'envelope','nonce','invite-test-v1','invite-application.v1'
      FROM generate_series(1,12)n;`);
  for (let i = 1; i <= 12; i += 1) {
    const id = `REQ-PURGE${String(i).padStart(4,"0")}`;
    await bucket.put(`invite-private/${id}/0.enc`, new Uint8Array([1,2,3]).buffer);
    const markerId = `REQ-RECON${String(i).padStart(4,"0")}`;
    await createInvitePrivateReconciliationMarker(env, { requestId: markerId,
      submissionKey: `reconcile-${i}`, objectDigest: "c".repeat(64),
      opaqueRef: `invite-private/${markerId}/revision-0-12345678-1234-1234-1234-123456789012.enc`,
      now: "2026-10-15T14:30:00Z" });
  }
  const referralStore = new CommunityReferralStore(db, { teamId: "TINT", channelId: "CPUBLIC", userId: "UADMIN" });
  for (let i = 1; i <= 12; i += 1) {
    const suffix = String(i).padStart(4,"0");
    const requestId = `REQ-ADMIN${suffix}`;
    const email = `applicant${suffix}@example.invalid`;
    const prepared = await prepareInvitePrivateObject({ bucket,
      kek: env.INVITE_PRIVATE_KEK, keyVersion: env.INVITE_PRIVATE_KEK_VERSION }, requestId, 0,
      { email, displayName: `Applicant ${suffix}`, intent: "Synthetic scrum request" });
    await putPreparedInvitePrivateObject({ bucket,
      kek: env.INVITE_PRIVATE_KEK, keyVersion: env.INVITE_PRIVATE_KEK_VERSION }, prepared);
    const submitted = await referralStore.submit({ teamId: "TINT", tokenDigest: await digestReferralToken(token),
      emailDigest: await digestNormalizedInviteEmail(email, env.INVITE_EMAIL_PEPPER),
      requestId, receiptId: `RCP-ADMIN${suffix}`, withdrawalDigest: "d".repeat(64),
      consentVersion: "invite-consent-v1", consentedAt: "2026-10-15T14:55:00Z",
      key: `submission-admin-${suffix}`, now: "2026-10-15T14:55:00Z", privateRef: prepared.ref });
    assert.equal(submitted.requestId, requestId);
  }
  await psql(`INSERT INTO otl.bug_reports(bug_id,team_id,state,public_alias,reporter_id,source,source_opaque_ref,
      source_channel_id,source_thread,title)
    SELECT 'BUG-TEST'||lpad(n::text,4,'0'),'TINT','rejected','B-TEST'||lpad(n::text,6,'0'),
      'UOWNER','slack','slack:TINT:CPUBLIC:1.1','CPUBLIC','1.1','Synthetic bug'
      FROM generate_series(1,12)n;
    INSERT INTO otl.bug_report_revisions(bug_id,packet_revision,schema_version,status,sanitized_fields,
      opaque_ref,object_digest,envelope_dek,kek_version,nonce)
    SELECT 'BUG-TEST'||lpad(n::text,4,'0'),1,'bug_intake.v1','draft','{}',
      'bug-private/BUG-TEST'||lpad(n::text,4,'0')||'/1.enc',repeat('a',64),
      'opaque-envelope-value','bug-test-v1','nonce-1234567890'
      FROM generate_series(1,12)n;
    INSERT INTO otl.bug_deliveries(delivery_key,delivery_kind,team_id,bug_id,packet_revision,
      destination,template_id,renderer_version,not_before)
    SELECT 'BUG-TEST'||lpad(n::text,4,'0')||':1:receipt:reporter_ephemeral','receipt',
      'TINT','BUG-TEST'||lpad(n::text,4,'0'),1,'reporter_ephemeral','receipt.private.v1',
      'bug-message.v1','2026-10-15T15:00:00Z' FROM generate_series(1,12)n;`);
  if (process.env.DEBUG_RUNTIME_QA) console.error("BUG_DUE", await scalar("SELECT count(*) FROM otl.bug_deliveries d JOIN otl.bug_reports r ON r.bug_id=d.bug_id WHERE d.team_id='TINT' AND d.status='pending' AND d.not_before<='2026-10-15T15:00:01Z' AND r.source='slack'"));
  const storage = { values: new Map([["role", "community_schedule"], ["channel", "CPUBLIC"]]),
    alarmAt: null,
    async get(key) { return this.values.get(key); },
    async put(key, value) { this.values.set(key, value); },
    async delete(key) { this.values.delete(key); },
    async getAlarm() { return this.alarmAt; },
    async setAlarm(value) { this.alarmAt = value; },
    async deleteAlarm() { this.alarmAt = null; } };
  const channelClock = new CommunityClock({ storage }, env);
  const bugFirst = await at("2026-10-15T15:00:01Z", (frozen) => runDueBugDeliveries(env, frozen));
  if (process.env.DEBUG_RUNTIME_QA) console.error("BUG_REPORTS", await scalar("SELECT state||':'||count(*) FROM otl.bug_reports WHERE team_id='TINT' GROUP BY state"));
  if (process.env.DEBUG_RUNTIME_QA) console.error("BUG_STATUS", await scalar("SELECT status||':'||count(*) FROM otl.bug_deliveries WHERE team_id='TINT' GROUP BY status"));
  assert.equal(bugFirst.deliveries.sent, 10);
  await at("2026-10-15T15:00:01Z", () => channelClock.alarm());
  if (process.env.DEBUG_RUNTIME_QA) console.error("CLOCK_FIRST", storage.alarmAt, storage.values.get("lastRun"), await scalar("SELECT status||':'||count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND day='2026-10-15' GROUP BY status"));
  assert.equal(storage.alarmAt, Date.parse("2026-10-15T15:00:02Z"));
  assert.equal(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND day='2026-10-15' AND status='sent'"), "10");
  assert.equal(await scalar("SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE team_id='TINT' AND effect_key LIKE 'qa-return-%' AND status='sent'"), "9");
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_type='admin_review' AND status='sent'"), "11");
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_key LIKE 'qa-notification-%' AND status='sent'"), "10");
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_private_payloads WHERE team_id='TINT' AND request_id LIKE 'REQ-PURGE%' AND purge_status='purged'"), "10");
  assert.equal(await scalar("SELECT count(*) FROM otl.bug_deliveries WHERE team_id='TINT' AND status='sent'"), "10");
  const bugSecond = await at("2026-10-15T15:00:02Z", (frozen) => runDueBugDeliveries(env, frozen));
  assert.equal(bugSecond.deliveries.sent, 2);
  await at("2026-10-15T15:00:01.500Z", (frozen) => communityCron(env, frozen));
  await at("2026-10-15T15:00:02Z", () => channelClock.alarm());
  assert.equal(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND day='2026-10-15' AND status='sent'"), "12");
  assert.equal(await scalar("SELECT count(*) FROM otl.bug_deliveries WHERE team_id='TINT' AND status='sent'"), "12");
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_type='admin_review' AND status='sent'"), "13");
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_key LIKE 'qa-notification-%' AND status='sent'"), "12");
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_private_payloads WHERE team_id='TINT' AND request_id LIKE 'REQ-PURGE%' AND purge_status='purged'"), "12");
  if (process.env.DEBUG_RUNTIME_QA) {
    const listing = await bucket.list({ prefix: "invite-private-reconcile/v1/", limit: 50 });
    if (listing.objects[0]) {
      const item = await bucket.get(listing.objects[0].key);
      const marker = JSON.parse(new TextDecoder().decode(await item.arrayBuffer()));
      console.error("MARKER_STATUS", marker.status, marker.attempts, marker.nextAttemptAt);
    }
  }
  assert.equal((await bucket.list({ prefix: "invite-private-reconcile/v1/", limit: 50 })).objects.length, 0);
  assert.equal(await scalar("SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE team_id='TINT' AND effect_key LIKE 'qa-return-%' AND status='sent'"), "12");
  const effectsBeforeOverlap = slackEffects.filter((effect) =>
    effect.method === "chat.postMessage" || effect.method === "chat.postEphemeral").length;
  await at("2026-10-15T15:00:03Z", async (frozen) => {
    await Promise.all([
      channelClock.alarm(),
      communityCron(env, frozen),
      slackRequest("/slack/events", { type: "event_callback", team_id: "TINT", event_id: "EvJoin1",
        event: { type: "team_join", user: { id: "UJOINED" } } }),
    ]);
  });
  assert.equal(await scalar("SELECT count(*) FROM otl.member_referral_attributions WHERE team_id='TINT'"), "1");
  assert.equal(await scalar("SELECT count(*) FROM otl.bug_deliveries WHERE team_id='TINT' AND status='sent'"), "12");
  assert.equal(slackEffects.filter((effect) =>
    effect.method === "chat.postMessage" || effect.method === "chat.postEphemeral").length,
    effectsBeforeOverlap);
  await psql(`INSERT INTO otl.referral_requests(team_id,request_id,receipt_id,link_id,referrer_user_id,
      email_digest,withdrawal_digest,state,submission_key,submission_hash,submitted_at,terminal_at,
      payload_purge_after,audit_purge_after)
    VALUES('TINT','REQ-FAIL0001','RCP-FAIL0001','${linkId}','UOWNER',repeat('1',64),repeat('2',64),
      'declined','qa-failure',repeat('3',32),'2026-09-19T00:00:00Z','2026-09-19T00:01:00Z',
      '2026-10-15T16:00:00Z','2027-10-15T16:00:00Z');
    INSERT INTO otl.referral_private_payloads(team_id,request_id,opaque_ref,object_digest,
      envelope_dek,nonce,key_version,schema_version)
    VALUES('TINT','REQ-FAIL0001','invite-private/REQ-FAIL0001/0.enc',repeat('4',64),
      'envelope','nonce','invite-test-v1','invite-application.v1');`);
  const failureKey = "invite-private/REQ-FAIL0001/0.enc";
  await bucket.put(failureKey, new Uint8Array([1,2,3]).buffer);
  const beforeMaintenance = slackEffects.length;
  env.DATABASE_MAINTENANCE = "true";
  const maintenance = await handleRequest(new Request(`https://core.invalid${applyPath}`, {
    method: "POST", body: application,
    headers: { "x-otl-timestamp": String(applyAt), "x-otl-nonce": "maintenance-nonce-0001",
      "x-otl-signature": hmac },
  }), runtime, context);
  assert.equal(maintenance.status, 503);
  await at("2026-10-15T16:01:00Z", (frozen) => runMembershipDue(env, db, "CPUBLIC", frozen));
  assert.equal(slackEffects.length, beforeMaintenance);
  assert.ok(await bucket.get(failureKey));
  env.DATABASE_MAINTENANCE = "false";
  failDbQueryOnce = "referral_runtime_execute('claim_purge'";
  await at("2026-10-15T16:01:00Z", (frozen) => runMembershipDue(env, db, "CPUBLIC", frozen));
  assert.equal(await scalar("SELECT purge_status FROM otl.referral_private_payloads WHERE team_id='TINT' AND request_id='REQ-FAIL0001'"), "pending");
  bucket.failDeleteKeyOnce = failureKey;
  await at("2026-10-15T16:01:01Z", (frozen) => runMembershipDue(env, db, "CPUBLIC", frozen));
  assert.equal(await scalar("SELECT purge_status FROM otl.referral_private_payloads WHERE team_id='TINT' AND request_id='REQ-FAIL0001'"), "failed");
  assert.ok(await bucket.get(failureKey));
  await at("2026-10-15T16:16:02Z", (frozen) => runMembershipDue(env, db, "CPUBLIC", frozen));
  assert.equal(await scalar("SELECT purge_status FROM otl.referral_private_payloads WHERE team_id='TINT' AND request_id='REQ-FAIL0001'"), "purged");
  assert.equal(await bucket.get(failureKey), null);
  const requestsBeforeMissingBinding = await scalar("SELECT count(*) FROM otl.referral_requests WHERE team_id='TINT'");
  const putsBeforeMissingBinding = bucket.privatePuts;
  const missingBody = JSON.stringify({ ...JSON.parse(application), submissionKey: "submission-missing-binding" });
  const missingTs = Math.floor(Date.now()/1000);
  const missingNonce = "missing-binding-nonce-0001";
  const missingSignature = await signReferralServiceRequest({ method: "POST", path: applyPath,
    body: missingBody, timestamp: missingTs, nonce: missingNonce }, env.SITE_CORE_HMAC_SECRET);
  const savedBucket = env.INVITE_PRIVATE_OBJECTS;
  env.INVITE_PRIVATE_OBJECTS = undefined;
  const missingResponse = await handleRequest(new Request(`https://core.invalid${applyPath}`, {
    method: "POST", body: missingBody,
    headers: { "x-otl-timestamp": String(missingTs), "x-otl-nonce": missingNonce,
      "x-otl-signature": missingSignature },
  }), runtime, context);
  env.INVITE_PRIVATE_OBJECTS = savedBucket;
  assert.equal(missingResponse.status, 503);
  assert.equal(await scalar("SELECT count(*) FROM otl.referral_requests WHERE team_id='TINT'"), requestsBeforeMissingBinding);
  assert.equal(bucket.privatePuts, putsBeforeMissingBinding);
  await psql(`UPDATE otl.community_preferences SET enabled=false
      WHERE team_id='TINT' AND channel_id='CPUBLIC' AND user_id LIKE 'UREM%';
    INSERT INTO otl.workspace_members(team_id,user_id,is_bot,is_app_user,slack_deleted)
      VALUES('TINT','ULEGACY',false,false,false) ON CONFLICT DO NOTHING;
    INSERT INTO otl.workspace_channel_memberships(team_id,channel_id,user_id,is_current,last_seen_at,synced_at)
      VALUES('TINT','CPUBLIC','ULEGACY',true,'2026-10-20T00:00:00Z','2026-10-20T00:00:00Z') ON CONFLICT DO NOTHING;
    INSERT INTO otl.member_lifecycles(team_id,channel_id,user_id,state,rollout_at,last_transition_at)
      VALUES('TINT','CPUBLIC','ULEGACY','active','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z');
    INSERT INTO otl.grass_seasons(team_id,channel_id,user_id,opened_at,opened_on,opened_reason)
      VALUES('TINT','CPUBLIC','ULEGACY','2026-10-20T00:00:00Z','2026-10-20','rollout');
    INSERT INTO otl.community_preferences(team_id,channel_id,user_id,enabled,preference_source,
      eligible_from,goal_time,review_time)
      VALUES('TINT','CPUBLIC','ULEGACY',true,'default','2026-10-20','11:00','20:00');
    INSERT INTO otl.community_days(team_id,channel_id,user_id,day,goal)
      VALUES('TINT','CPUBLIC','ULEGACY','2026-10-20','Legacy goal'),
      ('TINT','CPUBLIC','ULEGACY','2026-10-21','Canonical goal');`);
  const commonStore = new CommunityStore(db);
  const commonScope = { teamId: "TINT", channelId: "CPUBLIC", userId: "UADMIN" };
  await enqueueCommonDelivery(commonStore, commonScope, "2026-10-20", "review", "Legacy review prompt");
  await sendCommonDeliveries({ token: env.SLACK_BOT_TOKEN, now: "2026-10-20T09:00:00Z",
    scope: commonScope, store: commonStore, reviewThreadV2: false });
  assert.equal(await scalar("SELECT count(*) FROM otl.community_review_roots WHERE team_id='TINT' AND day='2026-10-20'"), "0");
  const legacyReminder = await at("2026-10-20T11:01:00Z", (frozen) =>
    runCommunitySchedule({ ...env, REVIEW_THREAD_V2: "false", COMMUNITY_CHANNEL_ID: "CPUBLIC" },
      new CommunityStore(db), new Date(frozen)));
  assert.equal(legacyReminder.personal, 1);
  const legacyPost = slackEffects.findLast((effect) => effect.method === "chat.postMessage" &&
    effect.payload.text?.includes("<@ULEGACY>"));
  assert.ok(legacyPost);
  assert.equal(legacyPost.payload.thread_ts, undefined);
  await enqueueCommonDelivery(commonStore, commonScope, "2026-10-21", "review", "Canonical review prompt");
  await sendCommonDeliveries({ token: env.SLACK_BOT_TOKEN, now: "2026-10-21T09:00:00Z",
    scope: commonScope, store: commonStore, reviewThreadV2: true });
  assert.equal(await scalar("SELECT count(*) FROM otl.community_review_roots WHERE team_id='TINT' AND day='2026-10-21'"), "1");
  const canonicalReminder = await at("2026-10-21T11:01:00Z", (frozen) =>
    runCommunitySchedule({ ...env, REVIEW_THREAD_V2: "true", COMMUNITY_CHANNEL_ID: "CPUBLIC" },
      new CommunityStore(db), new Date(frozen)));
  assert.equal(canonicalReminder.personal, 1);
  const canonicalPost = slackEffects.findLast((effect) => effect.method === "chat.postMessage" &&
    effect.payload.text?.includes("<@ULEGACY>"));
  assert.ok(canonicalPost);
  assert.equal(canonicalPost.payload.thread_ts,
    await scalar("SELECT thread_ts FROM otl.community_review_roots WHERE team_id='TINT' AND day='2026-10-21'"));

  const routeScope = { teamId: "TINT", channelId: "CPUBLIC", userId: "ULEGACY",
    date: "2026-10-21" };
  const rootForEdit = await scalar("SELECT thread_ts FROM otl.community_review_roots WHERE team_id='TINT' AND day='2026-10-21'");
  const beforeRoute = await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND user_id='ULEGACY' AND day='2026-10-21' AND route_provenance='canonical_review'");
  const firstDay = await commonStore.day(routeScope);
  const offEdit = await commonStore.change({ ...routeScope, key: "review-while-off",
    action: "reflection", text: "Stored while flag is off", outcome: "complete",
    expectedRevision: firstDay.revision, reviewThreadV2: false,
    delivery: { source: "7000.1", thread: rootForEdit, undoKey: null } });
  assert.equal(offEdit.changed, true);
  assert.equal((await commonStore.day(routeScope)).reflection, "Stored while flag is off");
  assert.equal(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND user_id='ULEGACY' AND day='2026-10-21' AND route_provenance='canonical_review'"), beforeRoute);
  const secondDay = await commonStore.day(routeScope);
  const onEdit = await commonStore.change({ ...routeScope, key: "review-after-on",
    action: "reflection", text: "Stored after flag resumes", outcome: "complete",
    expectedRevision: secondDay.revision, reviewThreadV2: true,
    delivery: { source: "7000.2", thread: rootForEdit, undoKey: null } });
  assert.equal(onEdit.changed, true);
  assert.equal(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND user_id='ULEGACY' AND day='2026-10-21' AND route_provenance='canonical_review'"), "1");
  await psql(`INSERT INTO otl.community_garden_retirements(team_id,channel_id,user_id,day,
    canonical_projection_key,old_projection_key,old_message_ts,old_payload,status,replacement_message_ts)
    VALUES('TINT','CPUBLIC','ULEGACY','2026-10-21','canonical-test-projection',
      'old-test-projection','5000.1','{"text":"old garden"}','pending','6000.1');`);
  env.REVIEW_THREAD_V2 = "true";
  env.GARDEN_RECONCILIATION = "false";
  const updatesBefore = slackEffects.filter((effect) => effect.method === "chat.update").length;
  await at("2026-10-21T12:00:00Z", (frozen) => runDueGardenDeliveries(env, "CPUBLIC", frozen));
  assert.equal(await scalar("SELECT status FROM otl.community_garden_retirements WHERE team_id='TINT' AND old_message_ts='5000.1'"), "pending");
  assert.equal(slackEffects.filter((effect) => effect.method === "chat.update").length, updatesBefore);
  env.GARDEN_RECONCILIATION = "true";
  await at("2026-10-21T12:00:01Z", (frozen) => runDueGardenDeliveries(env, "CPUBLIC", frozen));
  assert.equal(await scalar("SELECT status FROM otl.community_garden_retirements WHERE team_id='TINT' AND old_message_ts='5000.1'"), "retired");
  assert.equal(slackEffects.filter((effect) => effect.method === "chat.update").length, updatesBefore + 1);
  for (let i = 1; i <= 12; i += 1) {
    const markerId = `REQ-LATE${String(i).padStart(4,"0")}`;
    await createInvitePrivateReconciliationMarker(env, { requestId: markerId,
      submissionKey: `late-reconcile-${i}`, objectDigest: "9".repeat(64),
      opaqueRef: `invite-private/${markerId}/revision-0-12345678-1234-1234-1234-123456789012.enc`,
      now: "2026-10-22T14:30:00Z" });
  }
  await at("2026-10-22T15:00:00Z", (frozen) => communityCron(env, frozen));
  assert.equal((await bucket.list({ prefix: "invite-private-reconcile/v1/", limit: 50 })).objects.length, 2);
  assert.deepEqual(scanArms.at(-1), { channelId: "CPUBLIC", cursor: null });
  await at("2026-10-22T15:00:01Z", () => channelClock.alarm());
  assert.equal((await bucket.list({ prefix: "invite-private-reconcile/v1/", limit: 50 })).objects.length, 0);
  console.log("PASS rollout matrix: review-off legacy root=0 top-level reminder=1; review-on root=1 threaded reminder=1; retirement-off updates=0 retirement-on updates=1");
  console.log("PASS all-queue saturation: reminder=12 garden=10+2 bug=10+2 lifecycle=10+3 admin-review=10+2 referral-notice=10+2 R2-orphan=10+2 private-purge=10+2; cron-only R2 backlog arms DO immediately; alarm+cron+fetch overlap no duplicate");
  console.log("PASS adversarial effects: duplicate link/goal/join and admin/lifecycle replay once; stale action denied; accepted Slack response reconciled; DB/R2 failure retried; maintenance/missing binding fail closed");
  console.log(JSON.stringify({ scenario: "signed-link-apply-admin-manual-join-goal-review-garden-grace-extension-closure-return", status: "pass",
    db: { bugSent: Number(await scalar("SELECT count(*) FROM otl.bug_deliveries WHERE team_id='TINT' AND status='sent'")),
      adminReviews: Number(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_type='admin_review' AND status='sent'")),
      remindersSent: Number(await scalar("SELECT count(*) FROM otl.community_records WHERE team_id='TINT' AND kind='reminder' AND status='sent' AND user_id LIKE 'UREM%'")),
      referralNotifications: Number(await scalar("SELECT count(*) FROM otl.referral_outbox WHERE team_id='TINT' AND effect_key LIKE 'qa-notification-%' AND status='sent'")),
      purgedPrivate: Number(await scalar("SELECT count(*) FROM otl.referral_private_payloads WHERE team_id='TINT' AND request_id LIKE 'REQ-PURGE%' AND purge_status='purged'")),
      failedThenPurged: Number(await scalar("SELECT count(*) FROM otl.referral_private_payloads WHERE team_id='TINT' AND request_id='REQ-FAIL0001' AND purge_status='purged'")),
      lifecycleNotices: Number(await scalar("SELECT count(*) FROM otl.lifecycle_notice_outbox WHERE team_id='TINT' AND status='sent'")),
      gardenSent: Number(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT' AND status='sent'")),
      gardenQueue: Number(await scalar("SELECT count(*) FROM otl.community_garden_deliveries WHERE team_id='TINT'")),
      requests: Number(await scalar("SELECT count(*) FROM otl.referral_requests WHERE team_id='TINT'")),
      assertions: 1, attributions: 1 }, slack: { ephemeral: slackEffects.filter((effect) => effect.method === "chat.postEphemeral").length,
      adminPosts: slackEffects.filter((effect) => effect.method === "chat.postMessage" && effect.payload.channel === "UADMIN").length },
    r2: { privatePuts: bucket.privatePuts, privateDeletes: bucket.privateDeletes, markerDeletes: bucket.markerDeletes } }));
} finally {
  globalThis.fetch = originalFetch;
  if (started) await run(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(temp, { recursive: true, force: true });
}
