export function referralManifestRequirements(): {
  readonly botEvents: readonly ["team_join"];
  readonly botScopes: readonly ["users:read.email"];
} {
  return { botEvents: ["team_join"], botScopes: ["users:read.email"] };
}
