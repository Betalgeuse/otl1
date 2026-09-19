export { CommunityClock } from "./community-clock";

import { readBoardLink } from "./board-link";
import { armBugDeliveryClock, BUG_CLOCK_CAPABILITIES } from "./community-bug-clock-client";
import { armCommunityClock } from "./community-clock-client";
import { handleCommunityEvent } from "./community-events";
import { communityInteraction } from "./community-interactions";
import { handleInterestIntakeRequest } from "./community-interest-intake";
import { CommunityInterestStore } from "./community-interest-store";
import { handleReferralIntakeRequest } from "./community-referral-intake";
import { CommunityReferralStore } from "./community-referral-store";
import type { CommunityEnv } from "./community-runtime";
import { confirmMention, eventPayload, handleMention, verificationResponse } from "./events";
import { BodySizeError, InputError, koreaDate, object, readBody } from "./input";
import { handleIntentPilot, type PilotEnv } from "./intent-pilot";
import { paletteModal } from "./palette-modal";
import { processRecord } from "./process";
import { renderBoard } from "./render/board";
import { command, interaction } from "./requests";
import { verifySlack } from "./signing";
import { openView, reply } from "./slack-api";
import { NeonStore, type Store } from "./store";
import { createWorkerHandler } from "./worker-entry";

export type Env = PilotEnv &
  CommunityEnv & {
    readonly SLACK_TEAM_ID: string;
    readonly SLACK_SIGNING_SECRET: string;
    readonly SLACK_BOT_TOKEN: string;
    readonly DATABASE_URL: string;
    readonly BOARD_SIGNING_SECRET: string;
    readonly PUBLIC_BASE_URL: string;
    readonly DAILY_SCRUM_CHANNEL_ID: string;
  };
export type Context = { waitUntil(promise: Promise<unknown>): void };
export type Runtime = {
  readonly env: Env;
  readonly store: Store;
};

export async function handleRequest(
  request: Request,
  runtime: Runtime,
  ctx: Context,
): Promise<Response> {
  const url = new URL(request.url);
  const env = runtime.env;
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", capabilities: BUG_CLOCK_CAPABILITIES });
    }
    if (url.pathname.startsWith("/internal/interest/")) {
      if (env.DATABASE_MAINTENANCE === "true")
        return new Response("Maintenance", { status: 503, headers: { "Retry-After": "30" } });
      if (
        env.PUBLIC_INTEREST_ENABLED !== "true" ||
        !env.INTEREST_RUNTIME_DATABASE_URL ||
        !env.INTEREST_ADMIN_CHANNEL_ID ||
        env.INTEREST_ADMIN_CHANNEL_ID === env.COMMUNITY_PUBLIC_CHANNEL_ID
      )
        return new Response("Unavailable", { status: 503 });
      const interest = new CommunityInterestStore(new NeonStore(env.INTEREST_RUNTIME_DATABASE_URL));
      const response = await handleInterestIntakeRequest(request, env, {
        submit: (input) => interest.submit(input),
        withdraw: (input) => interest.withdraw(input),
        claimServiceNonce: (digest, expiresAt) =>
          interest.claimServiceNonce(digest, expiresAt, env.SLACK_TEAM_ID),
      });
      if (response.status === 202 && env.COMMUNITY_PUBLIC_CHANNEL_ID)
        ctx.waitUntil(armCommunityClock(env, env.COMMUNITY_PUBLIC_CHANNEL_ID));
      return response;
    }
    if (url.pathname.startsWith("/internal/referrals/")) {
      if (env.DATABASE_MAINTENANCE === "true")
        return new Response("Maintenance", { status: 503, headers: { "Retry-After": "30" } });
      if (
        env.REFERRALS_ENABLED !== "true" ||
        (url.pathname !== "/internal/referrals/withdraw" &&
          env.PUBLIC_APPLICATIONS_ENABLED !== "true")
      )
        return new Response("Unavailable", { status: 503 });
      const response = await handleReferralIntakeRequest(
        request,
        env,
        new CommunityReferralStore(new NeonStore(env.DATABASE_URL), {
          teamId: env.SLACK_TEAM_ID,
          channelId: env.COMMUNITY_PUBLIC_CHANNEL_ID ?? "",
          userId: env.COMMUNITY_ADMIN_ID ?? "",
        }),
      );
      if (response.status === 202 && env.COMMUNITY_PUBLIC_CHANNEL_ID)
        ctx.waitUntil(armCommunityClock(env, env.COMMUNITY_PUBLIC_CHANNEL_ID));
      return response;
    }
    if (env.DATABASE_MAINTENANCE === "true" && url.pathname.startsWith("/slack/"))
      return new Response("잠시 데이터 정리 중입니다. 곧 다시 시도해 주세요.", {
        status: 503,
        headers: { "Retry-After": "30" },
      });
    if (request.method === "GET" && url.pathname.startsWith("/board/")) {
      const board = await readBoardLink(url.pathname.slice(7), env.BOARD_SIGNING_SECRET);
      return new Response(Uint8Array.from(await renderBoard(board)), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/slack/events") {
      const body = await readBody(request);
      const timestamp = await verifySlack(request, body, env.SLACK_SIGNING_SECRET);
      if (timestamp === null) return new Response("Unauthorized", { status: 401 });
      ctx.waitUntil(
        armBugDeliveryClock(env, { reason: "activity", observedAt: timestamp * 1_000 }),
      );
      const data = env.COMMUNITY_ENABLED === "true" ? object(JSON.parse(body)) : eventPayload(body);
      const verification = verificationResponse(data);
      if (verification) return verification;
      ctx.waitUntil(
        (async () => {
          if (await handleCommunityEvent(data, env)) return;
          if (await handleIntentPilot(data, env, runtime.store)) return;
          await handleMention(data, env, { today: koreaDate(timestamp), timestamp });
        })(),
      );
      return new Response(null, { status: 200 });
    }
    if (
      request.method !== "POST" ||
      !["/slack/commands", "/slack/interactions"].includes(url.pathname)
    )
      return new Response("Not found", { status: 404 });
    if (Number(request.headers.get("content-length")) > 16384)
      return new Response("Request too large", { status: 413 });
    const body = await readBody(request);
    const timestamp = await verifySlack(request, body, env.SLACK_SIGNING_SECRET);
    if (timestamp === null) return new Response("Unauthorized", { status: 401 });
    if (url.pathname === "/slack/interactions")
      ctx.waitUntil(
        armBugDeliveryClock(env, { reason: "activity", observedAt: timestamp * 1_000 }),
      );
    if (url.pathname === "/slack/interactions") {
      const raw = new URLSearchParams(body).get("payload");
      if (raw) {
        const payload = object(JSON.parse(raw));
        const handled = await communityInteraction(payload, env, (p) => ctx.waitUntil(p));
        if (handled) return handled;
        const actions = Array.isArray(payload.actions) ? payload.actions : [];
        const first = actions[0];
        const action = first !== undefined ? object(first) : null;
        if (action?.action_id === "nl_confirm") {
          ctx.waitUntil(
            confirmMention(
              env.SLACK_BOT_TOKEN,
              payload,
              runtime.store,
              env.PUBLIC_BASE_URL,
              env.BOARD_SIGNING_SECRET,
              koreaDate(timestamp),
            ).catch(async (error: unknown) => {
              console.error(
                JSON.stringify({
                  event: "registration.failed",
                  errorType: error instanceof Error ? error.name : "Unknown",
                  errorMessage: error instanceof Error ? error.message : "Unknown",
                }),
              );
              const responseUrl = payload.response_url;
              if (typeof responseUrl === "string") {
                await reply(responseUrl, {
                  response_type: "ephemeral",
                  replace_original: false,
                  text: "등록 처리에 실패했습니다. 잠시 후 등록 버튼을 다시 눌러 주세요.",
                });
              }
            }),
          );
          return new Response(null, { status: 200 });
        }
      }
    }
    if (url.pathname === "/slack/commands")
      return Response.json({
        response_type: "ephemeral",
        text: "슬래시 명령은 종료했어요. 채널에 ONE THING을 자연어로 남기거나 ‘내 상태’라고 입력해 주세요.",
      });
    const today = koreaDate(timestamp);
    const operation =
      url.pathname === "/slack/commands"
        ? command(body, { today, timestamp })
        : interaction(body, { today, timestamp });
    if (
      operation.identity.teamId !== env.SLACK_TEAM_ID ||
      !/^[UW][A-Z0-9]+$/.test(operation.identity.userId)
    )
      return new Response("Forbidden", { status: 403 });
    switch (operation.kind) {
      case "errors":
        return Response.json({ response_action: "errors", errors: operation.errors });
      case "settings":
        await openView(env.SLACK_BOT_TOKEN, {
          trigger_id: operation.triggerId,
          view: paletteModal(operation.palette, {
            ownerId: operation.ownerId,
            responseUrl: operation.responseUrl,
            shared: operation.shared,
            date: operation.date,
          }),
        });
        return new Response(null, { status: 200 });
      case "record":
        ctx.waitUntil(
          processRecord(operation, {
            store: runtime.store,
            baseUrl: env.PUBLIC_BASE_URL,
            boardSecret: env.BOARD_SIGNING_SECRET,
            today,
          }),
        );
        return new Response(null, { status: 200 });
      case "denied":
        ctx.waitUntil(
          reply(operation.responseUrl, {
            response_type: "ephemeral",
            replace_original: false,
            text: operation.text,
          }).catch((error: unknown) => {
            console.error(
              JSON.stringify({
                event: "denial.feedback.failed",
                errorType: error instanceof Error ? error.name : "Unknown",
              }),
            );
          }),
        );
        return new Response(null, { status: 200 });
      default:
        return exhaustive(operation);
    }
  } catch (error) {
    if (error instanceof BodySizeError) return new Response("Request too large", { status: 413 });
    if (
      error instanceof InputError ||
      error instanceof SyntaxError ||
      error instanceof RangeError
    ) {
      if (url.pathname.startsWith("/board/")) return new Response("Invalid board", { status: 403 });
      return Response.json({
        response_type: "ephemeral",
        text: error instanceof InputError ? error.message : "요청을 확인해 주세요.",
      });
    }
    console.error(
      JSON.stringify({
        event: "request.failed",
        errorType: error instanceof Error ? error.name : "Unknown",
      }),
    );
    return new Response("Service unavailable", { status: 503 });
  }
}

function exhaustive(value: never): never {
  throw new InputError(`Unsupported operation: ${String(value)}`);
}

export default createWorkerHandler(handleRequest);
