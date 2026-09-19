import {
  INVITE_PRIVATE_SCHEMA_VERSION,
  type InvitePrivateObjectRef,
  type InvitePrivatePayload,
  invitePrivatePayloadSchema,
} from "./community-referral-types";

type StoredInviteObject = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

export interface InvitePrivateBucket {
  put(key: string, value: ArrayBuffer): Promise<unknown>;
  get(key: string): Promise<StoredInviteObject | null>;
  delete(key: string): Promise<unknown>;
}

export type InvitePrivateConfig = {
  readonly bucket: InvitePrivateBucket | undefined;
  readonly kek: string | undefined;
  readonly keyVersion: string | undefined;
};

export class InvitePrivateError extends Error {
  readonly code: "configuration" | "integrity" | "missing" | "invalid_payload";

  constructor(code: InvitePrivateError["code"]) {
    super(`invite private ${code}`);
    this.name = "InvitePrivateError";
    this.code = code;
  }
}

function encodedBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new InvitePrivateError("integrity");
  try {
    return encodedBuffer(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
  } catch (error) {
    if (error instanceof Error) throw new InvitePrivateError("integrity");
    throw error;
  }
}

function decodeKey(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = decodeBase64(normalized + padding);
  if (bytes.byteLength !== 32) throw new InvitePrivateError("configuration");
  return bytes;
}

function assertIdentity(requestId: string, revision: number, keyVersion: string): void {
  if (!/^REQ-[A-Z0-9]{8,64}$/.test(requestId) || !Number.isSafeInteger(revision) || revision < 0)
    throw new InvitePrivateError("configuration");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyVersion))
    throw new InvitePrivateError("configuration");
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function invitePrivateAdditionalData(
  requestId: string,
  revision: number,
  keyVersion: string,
): ArrayBuffer {
  assertIdentity(requestId, revision, keyVersion);
  return encodedBuffer(
    new TextEncoder().encode(
      JSON.stringify({
        namespace: "otl.invite-private.v1",
        requestId,
        revision,
        schemaVersion: INVITE_PRIVATE_SCHEMA_VERSION,
        keyVersion,
      }),
    ),
  );
}

function configured(config: InvitePrivateConfig): {
  readonly bucket: InvitePrivateBucket;
  readonly key: ArrayBuffer;
  readonly keyVersion: string;
} {
  if (!config.bucket || !config.kek || !config.keyVersion)
    throw new InvitePrivateError("configuration");
  return { bucket: config.bucket, key: decodeKey(config.kek), keyVersion: config.keyVersion };
}

export async function writeInvitePrivateObject(
  config: InvitePrivateConfig,
  requestId: string,
  revision: number,
  raw: unknown,
): Promise<InvitePrivateObjectRef> {
  const parsed = invitePrivatePayloadSchema.safeParse(raw);
  if (!parsed.success) throw new InvitePrivateError("invalid_payload");
  const ready = configured(config);
  const additionalData = invitePrivateAdditionalData(requestId, revision, ready.keyVersion);
  const kek = await crypto.subtle.importKey("raw", ready.key, { name: "AES-GCM" }, false, [
    "wrapKey",
  ]);
  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const envelopeNonce = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData },
    dek,
    new TextEncoder().encode(JSON.stringify(parsed.data)),
  );
  const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, {
    name: "AES-GCM",
    iv: envelopeNonce,
    additionalData,
  });
  const opaqueRef = `invite-private/${requestId}/revision-${revision}-${crypto.randomUUID()}.enc`;
  await ready.bucket.put(opaqueRef, body);
  return {
    opaqueRef,
    objectDigest: await digest(body),
    envelopeDek: `${base64(envelopeNonce)}.${base64(new Uint8Array(wrapped))}`,
    keyVersion: ready.keyVersion,
    nonce: base64(nonce),
    schemaVersion: INVITE_PRIVATE_SCHEMA_VERSION,
  };
}

export async function readInvitePrivateObject(
  config: InvitePrivateConfig,
  input: InvitePrivateObjectRef & { readonly requestId: string; readonly revision: number },
): Promise<InvitePrivatePayload> {
  const ready = configured(config);
  const expectedPrefix = `invite-private/${input.requestId}/revision-${input.revision}-`;
  if (!input.opaqueRef.startsWith(expectedPrefix) || !input.opaqueRef.endsWith(".enc"))
    throw new InvitePrivateError("integrity");
  if (
    input.keyVersion !== ready.keyVersion ||
    input.schemaVersion !== INVITE_PRIVATE_SCHEMA_VERSION
  )
    throw new InvitePrivateError("integrity");
  const stored = await ready.bucket.get(input.opaqueRef);
  if (!stored) throw new InvitePrivateError("missing");
  const ciphertext = await stored.arrayBuffer();
  if ((await digest(ciphertext)) !== input.objectDigest) throw new InvitePrivateError("integrity");
  const envelopeParts = input.envelopeDek.split(".");
  if (envelopeParts.length !== 2 || !envelopeParts[0] || !envelopeParts[1])
    throw new InvitePrivateError("integrity");
  const additionalData = invitePrivateAdditionalData(
    input.requestId,
    input.revision,
    input.keyVersion,
  );
  try {
    const kek = await crypto.subtle.importKey("raw", ready.key, { name: "AES-GCM" }, false, [
      "unwrapKey",
    ]);
    const dek = await crypto.subtle.unwrapKey(
      "raw",
      decodeBase64(envelopeParts[1]),
      kek,
      { name: "AES-GCM", iv: decodeBase64(envelopeParts[0]), additionalData },
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const cleartext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(input.nonce), additionalData },
      dek,
      ciphertext,
    );
    const parsedJson: unknown = JSON.parse(new TextDecoder().decode(cleartext));
    const parsed = invitePrivatePayloadSchema.safeParse(parsedJson);
    if (!parsed.success) throw new InvitePrivateError("integrity");
    return parsed.data;
  } catch (error) {
    if (error instanceof InvitePrivateError) throw error;
    if (error instanceof DOMException || error instanceof SyntaxError)
      throw new InvitePrivateError("integrity");
    throw error;
  }
}

export async function deleteInvitePrivateObject(
  config: InvitePrivateConfig,
  opaqueRef: string,
): Promise<void> {
  if (!config.bucket) throw new InvitePrivateError("configuration");
  if (!/^invite-private\/REQ-[A-Z0-9]{8,64}\/revision-[0-9]+-[0-9a-f-]+\.enc$/.test(opaqueRef))
    throw new InvitePrivateError("integrity");
  await config.bucket.delete(opaqueRef);
}
