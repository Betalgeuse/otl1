const base = process.argv[2];
if (!base) {
  console.error("Usage: node scripts/slack-manifest.mjs https://your-worker.workers.dev");
  process.exit(1);
}
const url = new URL(base);
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
  console.error("Use an HTTPS origin without a path or credentials.");
  process.exit(1);
}
console.log(JSON.stringify({
  display_information: { name: "ONE THING 잔디", description: "오늘의 한 문장으로 채우는 나의 잔디", background_color: "#216E39" },
  features: {
    bot_user: { display_name: "ONE THING 잔디", always_online: false },
  },
  oauth_config: { scopes: { bot: ["users:read", "users:read.email", "app_mentions:read", "channels:history", "channels:read", "groups:history", "chat:write", "chat:write.public", "im:write", "reactions:write", "emoji:read"] } },
  settings: { event_subscriptions: { request_url: `${url.origin}/slack/events`, bot_events: ["app_mention", "message.channels", "message.groups", "member_joined_channel", "team_join"] }, interactivity: { is_enabled: true, request_url: `${url.origin}/slack/interactions` }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
}, null, 2));
