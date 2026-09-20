import { canonicalGuideContent, parseGuideFileIds } from "./community-guide-content";
import { WELCOME_GUIDE_RELEASE } from "./community-guide-release";
import type { CommunityEnv } from "./community-runtime";
import { InputError, string } from "./input";
import { NeonStore } from "./store";

export type WelcomeGuideAdminEnv = Pick<
  CommunityEnv,
  | "SLACK_TEAM_ID"
  | "COMMUNITY_WELCOME_CHANNEL_ID"
  | "COMMUNITY_ADMIN_ID"
  | "COMMUNITY_GUIDE_FILE_IDS"
> & { readonly GUIDE_ADMIN_DATABASE_URL: string };

export type WelcomeGuideRelease = {
  readonly version: string;
  readonly hash: string;
  readonly body: string;
  readonly orderedFileIds: readonly [string, string];
  readonly authorId: string;
  readonly origin: "repo";
};

export type WelcomeGuideCommand = {
  readonly kind: "publish";
  readonly apply: boolean;
};

export type WelcomeGuideCommandResult = {
  readonly applied: boolean;
  readonly version: string;
  readonly contentHash: string;
};

export async function inspectWelcomeGuideSource(
  env: WelcomeGuideAdminEnv,
): Promise<WelcomeGuideRelease> {
  const authorId = env.COMMUNITY_ADMIN_ID;
  if (!env.COMMUNITY_WELCOME_CHANNEL_ID || !authorId || !/^U[A-Z0-9]+$/.test(authorId))
    throw new InputError("환영 안내 채널과 발행 관리자를 확인해 주세요.");
  const { version, body } = WELCOME_GUIDE_RELEASE;
  const orderedFileIds = parseGuideFileIds(env.COMMUNITY_GUIDE_FILE_IDS);
  const retiredTerm = ["si", "lo"].join("");
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) ||
    !body.trim() ||
    body.length > 38_000 ||
    !body.includes(version) ||
    body.toLowerCase().includes(retiredTerm) ||
    (body.match(/@channel/g)?.length ?? 0) !== 1 ||
    /<!(?:channel|here|everyone)>/.test(body)
  )
    throw new InputError("안내글 본문과 채널 알림 정책을 확인해 주세요.");
  const canonical = await canonicalGuideContent(body, orderedFileIds);
  return { version, ...canonical, authorId, origin: "repo" };
}

async function storePublishedGuide(
  env: WelcomeGuideAdminEnv,
  guide: WelcomeGuideRelease,
): Promise<string> {
  const store = new NeonStore(env.GUIDE_ADMIN_DATABASE_URL);
  return string(
    await store.queryJson("SELECT otl.guide_admin_execute($1,$2::jsonb)", [
      "publish",
      JSON.stringify({
        teamId: env.SLACK_TEAM_ID,
        channelId: env.COMMUNITY_WELCOME_CHANNEL_ID,
        ...guide,
      }),
    ]),
  );
}

export async function publishWelcomeGuide(env: WelcomeGuideAdminEnv): Promise<string> {
  const guide = await inspectWelcomeGuideSource(env);
  return storePublishedGuide(env, guide);
}

export async function executeWelcomeGuideCommand(
  command: WelcomeGuideCommand,
  env: WelcomeGuideAdminEnv,
): Promise<WelcomeGuideCommandResult> {
  const guide = await inspectWelcomeGuideSource(env);
  if (command.apply) await storePublishedGuide(env, guide);
  return { applied: command.apply, version: guide.version, contentHash: guide.hash };
}
