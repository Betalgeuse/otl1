import type { Json } from "./input";
import { object, slackResponseUrl } from "./input";

export class SlackError extends Error {
  override readonly name = "SlackError";
}

export async function reply(url: string, message: Json): Promise<void> {
  const response = await fetch(slackResponseUrl(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(6000),
    redirect: "manual",
  });
  if (!response.ok) throw new SlackError(`Slack response HTTP ${response.status}`);
}

export async function openView(token: string, payload: Json): Promise<void> {
  const response = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
    redirect: "manual",
  });
  if (!response.ok) throw new SlackError(`Slack view HTTP ${response.status}`);
  const data = object(await response.json());
  if (data.ok !== true) throw new SlackError("Slack view rejected");
}
