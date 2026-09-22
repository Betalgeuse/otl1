import type { BugDeliveryErrorCode } from "./community-bug-delivery-store";
import { CommunitySlackError } from "./community-social";

export type BugDeliveryProviderSubcode =
  | "invalid_blocks"
  | "invalid_arguments"
  | "invalid_form_data"
  | "msg_too_long"
  | "http_429"
  | "provider_5xx"
  | "other";

export function classifyBugDeliveryError(error: unknown): BugDeliveryErrorCode {
  if (!(error instanceof CommunitySlackError)) return "provider_error";
  if (error.code === "rate_limited") return "rate_limited";
  if (["thread_not_found", "not_in_channel", "channel_not_found"].includes(error.code))
    return "invalid_destination";
  if (["invalid_auth", "not_authed", "token_revoked", "account_inactive"].includes(error.code))
    return "auth_error";
  if (["transport_error", "unknown_transport_error"].includes(error.code)) return "network_error";
  if (
    ["invalid_blocks", "invalid_arguments", "invalid_form_data", "msg_too_long"].includes(
      error.code,
    )
  )
    return "invalid_payload";
  if (/^http_5\d\d$/.test(error.code) || error.code === "invalid_response") return "provider_error";
  return "slack_api_error";
}

export function bugDeliveryProviderSubcode(error: unknown): BugDeliveryProviderSubcode {
  if (!(error instanceof CommunitySlackError)) return "other";
  switch (error.code) {
    case "invalid_blocks":
    case "invalid_arguments":
    case "invalid_form_data":
    case "msg_too_long":
      return error.code;
    case "rate_limited":
    case "http_429":
      return "http_429";
    default:
      return /^http_5\d\d$/.test(error.code) ? "provider_5xx" : "other";
  }
}

export function bugDeliveryRetryDelay(error: unknown): number {
  if (error instanceof CommunitySlackError && error.retryAfterSeconds !== null)
    return error.retryAfterSeconds * 1_000;
  return 60_000;
}
