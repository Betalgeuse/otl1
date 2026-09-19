import { BUG_CLOCK_CAPABILITIES } from "./community-bug-clock-client";
import { communityCron } from "./community-cron";
import type { Context, Env, Runtime } from "./index";
import { NeonStore } from "./store";

type RequestHandler = (request: Request, runtime: Runtime, context: Context) => Promise<Response>;

export function createWorkerHandler(handler: RequestHandler): ExportedHandler<CloudflareBindings> {
  return {
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      await communityCron(env, controller.scheduledTime);
    },
    async fetch(request: Request, env: Env, context: Context): Promise<Response> {
      const configured = [
        env.SLACK_TEAM_ID,
        env.SLACK_SIGNING_SECRET,
        env.SLACK_BOT_TOKEN,
        env.DATABASE_URL,
        env.BOARD_SIGNING_SECRET,
        env.PUBLIC_BASE_URL,
      ].every(Boolean);
      if (new URL(request.url).pathname === "/health") {
        return Response.json({ status: "ok", configured, capabilities: BUG_CLOCK_CAPABILITIES });
      }
      if (!configured) return new Response("Setup required", { status: 503 });
      try {
        return await handler(
          request,
          {
            env,
            store: new NeonStore(env.DATABASE_URL),
          },
          context,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "configuration.failed",
            errorType: error instanceof Error ? error.name : "Unknown",
          }),
        );
        return new Response("Setup required", { status: 503 });
      }
    },
  };
}
