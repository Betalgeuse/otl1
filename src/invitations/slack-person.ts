import { InputError, object, string } from "../input";
import { SlackError } from "../slack-api";
import { normalizeEmail } from "./tokens";

export async function personEmail(
  identity: { readonly workspaceId: string; readonly userId: string },
  botToken: string,
): Promise<string> {
  const url = new URL("https://slack.com/api/users.info");
  url.searchParams.set("user", identity.userId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(5000),
    redirect: "manual",
  });
  if (!response.ok) throw new SlackError(`Slack user HTTP ${response.status}`);
  const payload = object(await response.json());
  if (payload.ok !== true) {
    if (payload.error === "missing_scope")
      throw new InputError(
        "운영자가 users:read와 users:read.email 권한을 추가하고 앱을 재설치해야 합니다.",
      );
    throw new SlackError("Slack user verification failed");
  }
  const user = object(payload.user);
  if (
    user.id !== identity.userId ||
    user.team_id !== identity.workspaceId ||
    user.is_bot !== false ||
    user.deleted !== false ||
    user.is_app_user === true ||
    user.is_stranger === true
  ) {
    throw new InputError("이 워크스페이스의 활성 사용자만 참여할 수 있습니다.");
  }
  const email = object(user.profile).email;
  if (typeof email !== "string" || !email)
    throw new InputError("Slack 계정 이메일을 확인할 수 없습니다. 운영자에게 문의해 주세요.");
  return normalizeEmail(string(email));
}
