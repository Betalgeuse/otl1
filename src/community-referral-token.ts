import { inviteEmailSchema } from "./community-referral-types";

export class ReferralTokenError extends Error {
  readonly code: "invalid_email" | "invalid_secret" | "invalid_token";

  constructor(code: ReferralTokenError["code"]) {
    super(`referral token ${code}`);
    this.name = "ReferralTokenError";
    this.code = code;
  }
}

export type IssuedReferralToken = {
  readonly token: string;
  readonly digest: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeSecret(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bytes = Uint8Array.from(atob(normalized + padding), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength !== 32) throw new ReferralTokenError("invalid_secret");
    const result = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(result).set(bytes);
    return result;
  } catch (error) {
    if (error instanceof ReferralTokenError) throw error;
    if (error instanceof Error) throw new ReferralTokenError("invalid_secret");
    throw error;
  }
}

export async function digestReferralToken(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new ReferralTokenError("invalid_token");
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export async function issueReferralToken(): Promise<IssuedReferralToken> {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  return { token, digest: await digestReferralToken(token) };
}

export async function digestNormalizedInviteEmail(email: unknown, pepper: string): Promise<string> {
  const parsed = inviteEmailSchema.safeParse(email);
  if (!parsed.success) throw new ReferralTokenError("invalid_email");
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSecret(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parsed.data)));
}
