const PUBLIC_VARS = Object.freeze({
  COMMUNITY_WELCOME_CHANNEL_ID: "C_REPLACE_WELCOME",
  COMMUNITY_INTRO_CHANNEL_ID: "C_REPLACE_INTRO",
  COMMUNITY_GUIDE_SOURCE_TS: "0.000001",
  COMMUNITY_GUIDE_SOURCE_EDITED_TS: "0.000002",
  COMMUNITY_GUIDE_FILE_IDS: "FREPLACELOGO,FREPLACEDAILY",
  COMMUNITY_GUIDE_VERSION: "v0.0.55",
  COMMUNITY_GUIDE_CONTENT_HASH: "0".repeat(64),
  DATABASE_MAINTENANCE: "false",
  INVITATIONS_ENABLED: "false",
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
});

export function sanitizeWranglerConfig(source) {
  const config = structuredClone(source);
  delete config.account_id;
  config.name = "onething-community";
  config.vars = { ...PUBLIC_VARS };
  config.r2_buckets = [
    { binding: "BUG_PRIVATE_OBJECTS", bucket_name: "replace-with-private-bucket" },
  ];
  return config;
}

export function sanitizePackageMetadata(source) {
  const packageMetadata = structuredClone(source);
  packageMetadata.devDependencies = {
    "@biomejs/biome": "2.5.6",
    typescript: "7.1.0-dev.20260809.1",
    wrangler: "4.62.0",
  };
  packageMetadata.scripts.typecheck = "tsc --noEmit";
  return packageMetadata;
}
