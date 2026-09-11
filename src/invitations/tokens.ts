import { InputError } from "../input";
import { sign } from "../signing";

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new InputError("초대할 사람의 이메일을 입력해 주세요.");
  }
  return email;
}

export async function emailHash(email: string, secret: string): Promise<string> {
  return sign(`invitation-email:${normalizeEmail(email)}`, secret);
}

export async function tokenHash(token: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new InputError("초대 코드를 다시 확인해 주세요.");
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function makeInvitation(
  identity: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly email: string;
    readonly month: string;
  },
  secret: string,
): Promise<{ readonly emailHash: string; readonly token: string; readonly tokenHash: string }> {
  const recipientHash = await emailHash(identity.email, secret);
  const token = await sign(
    JSON.stringify([
      "invitation-code",
      identity.workspaceId,
      identity.userId,
      identity.month,
      recipientHash,
    ]),
    secret,
  );
  return { emailHash: recipientHash, token, tokenHash: await tokenHash(token) };
}
