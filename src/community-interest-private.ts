import {
  INTEREST_PRIVATE_SCHEMA_VERSION,
  type InterestPrivateObjectRef,
  type InterestPrivatePayload,
  interestPrivatePayloadSchema,
} from "./community-interest-types";

type StoredInterestObject = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

export interface InterestPrivateBucket {
  put(key: string, value: ArrayBuffer): Promise<unknown>;
  get(key: string): Promise<StoredInterestObject | null>;
  delete(key: string): Promise<unknown>;
}

export type InterestPrivateConfig = {
  readonly bucket: InterestPrivateBucket | undefined;
  readonly kek: string | undefined;
  readonly keyVersion: string | undefined;
};

export type PreparedInterestPrivateObject = {
  readonly ref: InterestPrivateObjectRef;
  readonly ciphertext: ArrayBuffer;
};

export class InterestPrivateError extends Error {
  readonly code: "configuration" | "integrity" | "missing" | "invalid_payload";

  constructor(code: InterestPrivateError["code"]) {
    super(`interest private ${code}`);
    this.name = "InterestPrivateError";
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
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new InterestPrivateError("integrity");
  try {
    return encodedBuffer(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
  } catch (error) {
    if (error instanceof Error) throw new InterestPrivateError("integrity");
    throw error;
  }
}

function decodeKey(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = decodeBase64(normalized + padding);
  if (bytes.byteLength !== 32) throw new InterestPrivateError("configuration");
  return bytes;
}

function assertIdentity(requestId: string, revision: number, keyVersion: string): void {
  if (!/^IREQ-[A-Z0-9-]{4,64}$/.test(requestId) || !Number.isSafeInteger(revision) || revision < 0)
    throw new InterestPrivateError("configuration");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyVersion))
    throw new InterestPrivateError("configuration");
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function interestPrivateAdditionalData(
  requestId: string,
  revision: number,
  keyVersion: string,
): ArrayBuffer {
  assertIdentity(requestId, revision, keyVersion);
  return encodedBuffer(
    new TextEncoder().encode(
      JSON.stringify({
        namespace: "otl.interest-private.v1",
        requestId,
        revision,
        schemaVersion: INTEREST_PRIVATE_SCHEMA_VERSION,
        keyVersion,
      }),
    ),
  );
}

function configured(config: InterestPrivateConfig): {
  readonly bucket: InterestPrivateBucket;
  readonly key: ArrayBuffer;
  readonly keyVersion: string;
} {
  if (!config.bucket || !config.kek || !config.keyVersion)
    throw new InterestPrivateError("configuration");
  return { bucket: config.bucket, key: decodeKey(config.kek), keyVersion: config.keyVersion };
}

export async function prepareInterestPrivateObject(
  config: InterestPrivateConfig,
  requestId: string,
  revision: number,
  raw: unknown,
): Promise<PreparedInterestPrivateObject> {
  const parsed = interestPrivatePayloadSchema.safeParse(raw);
  if (!parsed.success) throw new InterestPrivateError("invalid_payload");
  const ready = configured(config);
  const additionalData = interestPrivateAdditionalData(requestId, revision, ready.keyVersion);
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
  const opaqueRef = `interest-private/${requestId}/revision-${revision}-${crypto.randomUUID()}.enc`;
  return {
    ciphertext: body,
    ref: {
      opaqueRef,
      objectDigest: await digest(body),
      envelopeDek: `${base64(envelopeNonce)}.${base64(new Uint8Array(wrapped))}`,
      keyVersion: ready.keyVersion,
      nonce: base64(nonce),
      schemaVersion: INTEREST_PRIVATE_SCHEMA_VERSION,
    },
  };
}

export async function putPreparedInterestPrivateObject(
  config: InterestPrivateConfig,
  prepared: PreparedInterestPrivateObject,
): Promise<void> {
  if (!config.bucket) throw new InterestPrivateError("configuration");
  await config.bucket.put(prepared.ref.opaqueRef, prepared.ciphertext);
}

export async function writeInterestPrivateObject(
  config: InterestPrivateConfig,
  requestId: string,
  revision: number,
  raw: unknown,
): Promise<InterestPrivateObjectRef> {
  const prepared = await prepareInterestPrivateObject(config, requestId, revision, raw);
  await putPreparedInterestPrivateObject(config, prepared);
  return prepared.ref;
}

export async function readInterestPrivateObject(
  config: InterestPrivateConfig,
  input: InterestPrivateObjectRef & { readonly requestId: string; readonly revision: number },
): Promise<InterestPrivatePayload> {
  const ready = configured(config);
  const expectedPrefix = `interest-private/${input.requestId}/revision-${input.revision}-`;
  if (!input.opaqueRef.startsWith(expectedPrefix) || !input.opaqueRef.endsWith(".enc"))
    throw new InterestPrivateError("integrity");
  if (
    input.keyVersion !== ready.keyVersion ||
    input.schemaVersion !== INTEREST_PRIVATE_SCHEMA_VERSION
  )
    throw new InterestPrivateError("integrity");
  const stored = await ready.bucket.get(input.opaqueRef);
  if (!stored) throw new InterestPrivateError("missing");
  const ciphertext = await stored.arrayBuffer();
  if ((await digest(ciphertext)) !== input.objectDigest)
    throw new InterestPrivateError("integrity");
  const envelopeParts = input.envelopeDek.split(".");
  if (envelopeParts.length !== 2 || !envelopeParts[0] || !envelopeParts[1])
    throw new InterestPrivateError("integrity");
  const additionalData = interestPrivateAdditionalData(
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
    const parsed = interestPrivatePayloadSchema.safeParse(parsedJson);
    if (!parsed.success) throw new InterestPrivateError("integrity");
    return parsed.data;
  } catch (error) {
    if (error instanceof InterestPrivateError) throw error;
    if (error instanceof DOMException || error instanceof SyntaxError)
      throw new InterestPrivateError("integrity");
    throw error;
  }
}

export async function deleteInterestPrivateObject(
  config: InterestPrivateConfig,
  opaqueRef: string,
): Promise<void> {
  if (!config.bucket) throw new InterestPrivateError("configuration");
  if (!/^interest-private\/IREQ-[A-Z0-9-]{4,64}\/revision-[0-9]+-[0-9a-f-]+\.enc$/.test(opaqueRef))
    throw new InterestPrivateError("integrity");
  await config.bucket.delete(opaqueRef);
}
