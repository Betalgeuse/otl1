import { InputError } from "../input";
import { normalizeEmail } from "./tokens";

export type InvitationOperation = {
  readonly kind: "invitation";
  readonly action: "status" | "issue" | "redeem" | "check";
  readonly identity: { readonly teamId: string; readonly userId: string };
  readonly responseUrl: string;
  readonly argument: string;
};

export function invitationCommand(
  text: string,
  context: { readonly identity: InvitationOperation["identity"]; readonly responseUrl: string },
): InvitationOperation | null {
  const [verb, ...parts] = text.split(/\s+/);
  if (!["초대", "가입", "초대확인"].includes(verb ?? "")) return null;
  if (parts.length > 1) throw new InputError("이메일 또는 초대 코드를 하나만 입력해 주세요.");
  const argument = parts[0] ?? "";
  if (verb === "초대" && !argument)
    return { ...context, kind: "invitation", action: "status", argument };
  if (verb === "가입") {
    if (!/^[0-9a-f]{64}$/.test(argument))
      throw new InputError("/one 가입 뒤에 받은 초대 코드를 입력해 주세요.");
    return { ...context, kind: "invitation", action: "redeem", argument };
  }
  return {
    ...context,
    kind: "invitation",
    action: verb === "초대" ? "issue" : "check",
    argument: normalizeEmail(argument),
  };
}
