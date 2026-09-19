import type {
  LifecycleActionBinding,
  LifecycleActionId,
} from "./community-lifecycle-runtime-types";
import { InputError, object, string } from "./input";
import { sign, verify } from "./signing";

function actionId(value: unknown): LifecycleActionId {
  switch (value) {
    case "lifecycle_extend":
    case "lifecycle_review":
    case "lifecycle_stop":
    case "lifecycle_restore_error":
      return value;
    default:
      throw new InputError("지원하지 않는 생애주기 동작입니다.");
  }
}

export async function signLifecycleAction(
  binding: LifecycleActionBinding,
  secret: string,
): Promise<string> {
  const data = btoa(JSON.stringify(binding));
  return `${data}.${await sign(data, secret)}`;
}

export async function parseLifecycleAction(
  value: string,
  actorId: string,
  adminId: string | undefined,
  secret: string,
): Promise<LifecycleActionBinding> {
  const [data, signature, extra] = value.split(".");
  if (!data || !signature || extra || !(await verify(data, signature, secret)))
    throw new InputError("만료되었거나 잘못된 동작입니다.");
  let parsed: Record<string, unknown>;
  try {
    parsed = object(JSON.parse(atob(data)));
  } catch (error) {
    if (error instanceof Error) throw new InputError("만료되었거나 잘못된 동작입니다.");
    throw error;
  }
  const revision = parsed.revision;
  if (!Number.isSafeInteger(revision) || typeof revision !== "number" || revision < 0)
    throw new InputError("생애주기 버전을 확인할 수 없습니다.");
  const result = {
    actionId: actionId(parsed.actionId),
    teamId: string(parsed.teamId),
    channelId: string(parsed.channelId),
    ownerId: string(parsed.ownerId),
    revision,
    key: string(parsed.key),
  };
  if (result.ownerId !== actorId && result.actionId !== "lifecycle_restore_error")
    throw new InputError("본인의 생애주기만 변경할 수 있습니다.");
  if (result.actionId === "lifecycle_restore_error" && actorId !== adminId)
    throw new InputError("관리자만 복구할 수 있습니다.");
  return result;
}
