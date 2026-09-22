const PUBLIC_VARS = Object.freeze({
  COMMUNITY_WELCOME_CHANNEL_ID: "C_REPLACE_WELCOME",
  COMMUNITY_GUIDE_FILE_IDS: "FREPLACELOGO,FREPLACEDAILY",
  COMMUNITY_GUIDE_CHAPTER_CHANNEL_IDS: "C_REPLACE_DEVELOPERS,C_REPLACE_ENGLISH,C_REPLACE_INVESTMENT",
  COMMUNITY_INTRO_CHANNEL_ID: "C_REPLACE_INTRO",
  DATABASE_MAINTENANCE: "false",
  DAILY_SCRUM_CHANNEL_ID: "C_REPLACE_DAILY",
  LLM_PILOT_CHANNEL_ID: "C_REPLACE_ADMIN",
  LLM_PILOT_USER_ID: "U_REPLACE_ADMIN",
  COMMUNITY_ENABLED: "true",
  COMMUNITY_CHANNEL_ID: "C_REPLACE_ADMIN",
  COMMUNITY_ADMIN_ID: "U_REPLACE_ADMIN",
  COMMUNITY_BOT_USER_ID: "U_REPLACE_BOT",
  COMMUNITY_RELEASE_CHANNEL_ID: "C_REPLACE_TOWNHALL",
  COMMUNITY_FEEDBACK_CHANNEL_ID: "C_REPLACE_FEEDBACK",
  COMMUNITY_PUBLIC_CHANNEL_ID: "C_REPLACE_DAILY",
  LIFECYCLE_MODE: "disabled",
  REVIEW_THREAD_V2: "true",
  GARDEN_RECONCILIATION: "false",
  REFERRALS_ENABLED: "true",
  PUBLIC_APPLICATIONS_ENABLED: "false",
  PUBLIC_INTEREST_ENABLED: "false",
  PUBLIC_APPLICATION_ORIGIN: "https://your-site.workers.dev",
});

const PUBLIC_R2_BUCKETS = Object.freeze([
  { binding: "BUG_PRIVATE_OBJECTS", bucket_name: "replace-with-private-bucket" },
  { binding: "INVITE_PRIVATE_OBJECTS", bucket_name: "replace-with-invite-private-bucket" },
]);

export function sanitizeWranglerConfig(source) {
  const config = structuredClone(source);
  delete config.account_id;
  config.name = "onething-community";
  config.vars = { ...PUBLIC_VARS };
  config.r2_buckets = structuredClone(PUBLIC_R2_BUCKETS);
  return config;
}

export function sanitizeSiteWranglerConfig(source) {
  const config = structuredClone(source);
  delete config.account_id;
  config.name = "onething-site";
  config.services = [{ binding: "CORE", service: "replace-with-core-worker" }];
  config.vars = {
    TURNSTILE_SITE_KEY: "replace-with-turnstile-site-key",
    PUBLIC_INTEREST_ENABLED: "false",
  };
  config.ratelimits = [
    { name: "RATE_LIMITER", namespace_id: "1001", simple: { limit: 20, period: 60 } },
  ];
  return config;
}

export function sanitizeSiteQaCoreConfig(source) {
  const config = structuredClone(source);
  config.name = "onething-core-fixture";
  return config;
}

export function assertSanitizedCoreConfig(config) {
  if (config.account_id || config.name !== "onething-community")
    throw Error("Public core config contains private identity.");
  if (JSON.stringify(config.vars) !== JSON.stringify(PUBLIC_VARS))
    throw Error("Public core config must use canonical placeholders.");
  if (JSON.stringify(config.r2_buckets) !== JSON.stringify(PUBLIC_R2_BUCKETS))
    throw Error("Public core config must use private-bucket placeholders.");
}

export function sanitizePackageMetadata(source) {
  const packageMetadata = structuredClone(source);
  packageMetadata.devDependencies = {
    "@biomejs/biome": "2.5.6",
    typescript: "7.1.0-dev.20260809.1",
    wrangler: "4.62.0",
    zod: "4.4.3",
  };
  packageMetadata.scripts.typecheck = "tsc --noEmit";
  return packageMetadata;
}

export function assertPublicGuideReleaseSource(source) {
  if (/\b[CF][A-Z0-9]{10,}\b/.test(source) || /https?:\/\/[^\s<>]+\.slack\.com\/archives\//i.test(source))
    throw Error("Public welcome guide source contains a live Slack identifier or workspace URL.");
}
