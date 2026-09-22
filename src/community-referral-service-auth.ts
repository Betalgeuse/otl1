import type { ReferralRuntimeStore } from "./community-referral-types";
import { sign, verify } from "./signing";

const AUTH_WINDOW_SECONDS = 300;

type SignedInput = {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: number;
  readonly nonce: string;
};

type AuthenticationInput = {
  readonly request: Request;
  readonly body: string;
  readonly secret: string | undefined;
  readonly store: Pick<ReferralRuntimeStore, "claimServiceNonce">;
  readonly persistNonce: boolean;
};

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function canonical(input: SignedInput): Promise<string> {
  return [
    input.method.toUpperCase(),
    input.path,
    await sha256Hex(input.body),
    String(input.timestamp),
    input.nonce,
  ].join("\n");
}

export async function signReferralServiceRequest(
  input: SignedInput,
  secret: string,
): Promise<string> {
  return sign(await canonical(input), secret);
}

export async function authenticateReferralServiceRequest(
  input: AuthenticationInput,
): Promise<boolean> {
  const timestampValue = input.request.headers.get("x-otl-timestamp") ?? "";
  const nonce = input.request.headers.get("x-otl-nonce") ?? "";
  const signature = input.request.headers.get("x-otl-signature") ?? "";
  const timestamp = Number(timestampValue);
  if (
    !input.secret ||
    !/^\d{10}$/.test(timestampValue) ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature) ||
    Math.abs(Date.now() / 1000 - timestamp) > AUTH_WINDOW_SECONDS
  )
    return false;
  const signed = {
    method: input.request.method,
    path: new URL(input.request.url).pathname,
    body: input.body,
    timestamp,
    nonce,
  };
  if (!(await verify(await canonical(signed), signature, input.secret))) return false;
  if (!input.persistNonce) return true;
  const nonceDigest = await sha256Hex(`${timestampValue}:${nonce}`);
  return input.store.claimServiceNonce(
    nonceDigest,
    new Date((timestamp + AUTH_WINDOW_SECONDS) * 1000).toISOString(),
  );
}
