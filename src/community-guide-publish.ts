import { canonicalGuideContent, parseGuideFileIds } from "./community-guide-content";
import type { CommunityEnv } from "./community-runtime";
import { CommunitySlackError } from "./community-social";
import { InputError, object, string } from "./input";
import { NeonStore } from "./store";

const GUIDE_VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const SLACK_TS = /^[0-9]+\.[0-9]+$/;

export type WelcomeGuideAdminEnv = Pick<
  CommunityEnv,
  | "SLACK_TEAM_ID"
  | "SLACK_BOT_TOKEN"
  | "COMMUNITY_WELCOME_CHANNEL_ID"
  | "COMMUNITY_ADMIN_ID"
  | "COMMUNITY_GUIDE_SOURCE_TS"
  | "COMMUNITY_GUIDE_SOURCE_EDITED_TS"
  | "COMMUNITY_GUIDE_FILE_IDS"
  | "COMMUNITY_GUIDE_VERSION"
  | "COMMUNITY_GUIDE_CONTENT_HASH"
> & {
  readonly GUIDE_ADMIN_DATABASE_URL: string;
};

export type WelcomeGuideRelease = {
  readonly version: string;
  readonly hash: string;
  readonly body: string;
  readonly orderedFileIds: readonly [string, string];
  readonly authorId: string;
  readonly sourceTs: string;
  readonly editedTs: string;
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

function requiredReleaseConfig(env: WelcomeGuideAdminEnv) {
  const version = env.COMMUNITY_GUIDE_VERSION;
  const channelId = env.COMMUNITY_WELCOME_CHANNEL_ID;
  const authorId = env.COMMUNITY_ADMIN_ID;
  const sourceTs = env.COMMUNITY_GUIDE_SOURCE_TS;
  const editedTs = env.COMMUNITY_GUIDE_SOURCE_EDITED_TS;
  const expectedHash = env.COMMUNITY_GUIDE_CONTENT_HASH;
  if (!version || !GUIDE_VERSION.test(version))
    throw new InputError("환영 안내 버전을 확인해 주세요.");
  if (!channelId || !authorId || !sourceTs || !editedTs || !expectedHash)
    throw new InputError("환영 안내글 설정이 필요합니다.");
  if (!SLACK_TS.test(sourceTs) || !SLACK_TS.test(editedTs))
    throw new InputError("환영 안내 원본 시각을 확인해 주세요.");
  if (!CONTENT_HASH.test(expectedHash))
    throw new InputError("환영 안내 해시 설정을 확인해 주세요.");
  return {
    version,
    channelId,
    authorId,
    sourceTs,
    editedTs,
    expectedHash,
    orderedFileIds: parseGuideFileIds(env.COMMUNITY_GUIDE_FILE_IDS),
  };
}

async function readSlackSource(env: WelcomeGuideAdminEnv, channelId: string, sourceTs: string) {
  const url = new URL("https://slack.com/api/conversations.history");
  for (const [key, value] of Object.entries({
    channel: channelId,
    oldest: sourceTs,
    latest: sourceTs,
    inclusive: "true",
    limit: "1",
  }))
    url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(6000),
    redirect: "manual",
  });
  const result = object(await response.json());
  if (!response.ok || result.ok !== true) throw new CommunitySlackError("guide_source_unavailable");
  return object(Array.isArray(result.messages) ? result.messages[0] : undefined);
}

export async function inspectWelcomeGuideSource(
  env: WelcomeGuideAdminEnv,
): Promise<WelcomeGuideRelease> {
  const config = requiredReleaseConfig(env);
  const source = await readSlackSource(env, config.channelId, config.sourceTs);
  if (
    source.ts !== config.sourceTs ||
    source.user !== config.authorId ||
    source.subtype ||
    source.bot_id
  )
    throw new InputError("관리자가 작성한 원본 안내글을 확인할 수 없습니다.");
  const sourceEdit = source.edited ? string(object(source.edited).ts) : "";
  if (sourceEdit !== config.editedTs)
    throw new InputError("환영 안내 원본 편집 시각이 설정과 다릅니다.");
  const body = string(source.text);
  const retiredTerm = ["si", "lo"].join("");
  if (
    !body.trim() ||
    body.length > 38_000 ||
    !body.includes(config.version) ||
    body.toLowerCase().includes(retiredTerm) ||
    (body.match(/<!channel>/g)?.length ?? 0) !== 1 ||
    /<!(?:here|everyone)>/.test(body)
  )
    throw new InputError("안내글 본문과 채널 알림 정책을 확인해 주세요.");
  if (!Array.isArray(source.files))
    throw new InputError("원본 안내글 첨부 이미지를 확인해 주세요.");
  const sourceFileIds = source.files.map((file) => string(object(file).id));
  if (
    sourceFileIds.length !== 2 ||
    sourceFileIds[0] !== config.orderedFileIds[0] ||
    sourceFileIds[1] !== config.orderedFileIds[1]
  )
    throw new InputError("원본 안내글 첨부 이미지와 순서를 확인해 주세요.");
  const canonical = await canonicalGuideContent(body, config.orderedFileIds);
  if (canonical.hash !== config.expectedHash)
    throw new InputError("환영 안내 원본 해시가 설정과 다릅니다.");
  return {
    version: config.version,
    ...canonical,
    authorId: config.authorId,
    sourceTs: config.sourceTs,
    editedTs: config.editedTs,
  };
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
