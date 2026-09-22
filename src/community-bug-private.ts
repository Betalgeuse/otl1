import type { EncryptedObjectRef } from "./community-bug-types";
import type { CommunityContext } from "./community-runtime";
import { InputError } from "./input";

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function decodeKey(value: string): ArrayBuffer {
  let decoded: string;
  try {
    decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch (error) {
    if (error instanceof Error)
      throw new InputError("버그 비공개 저장소 암호화 설정이 올바르지 않아요.");
    throw error;
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length !== 32)
    throw new InputError("버그 비공개 저장소 암호화 설정이 올바르지 않아요.");
  const result = new ArrayBuffer(32);
  new Uint8Array(result).set(bytes);
  return result;
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bugPrivateAdditionalData(
  bugId: string,
  revision: number,
  schemaVersion: "bug_intake.v1" | "bug_packet.v1",
  kekVersion: string,
): ArrayBuffer {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ bugId, revision, schemaVersion, kekVersion }),
  );
  const result = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(result).set(encoded);
  return result;
}

export function randomBugIdentity(prefix: "BUG" | "B"): string {
  return `${prefix}-${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, prefix === "BUG" ? 20 : 16)
    .toUpperCase()}`;
}

export async function digestBugText(value: string): Promise<string> {
  return digest(new TextEncoder().encode(value).buffer);
}

export async function writeBugPrivateObject(
  context: CommunityContext,
  bugId: string,
  revision: number,
  raw: object,
  schemaVersion: "bug_intake.v1" | "bug_packet.v1" = "bug_intake.v1",
): Promise<EncryptedObjectRef> {
  const bucket = context.env.BUG_PRIVATE_OBJECTS;
  const keyVersion = context.env.BUG_PRIVATE_KEK_VERSION;
  const configuredKey = context.env.BUG_PRIVATE_KEK;
  if (!bucket || !keyVersion || !configuredKey)
    throw new InputError("버그 비공개 저장소가 준비되지 않아 접수하지 않았어요.");
  const kek = await crypto.subtle.importKey(
    "raw",
    decodeKey(configuredKey),
    { name: "AES-GCM" },
    false,
    ["wrapKey"],
  );
  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const envelopeNonce = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = bugPrivateAdditionalData(bugId, revision, schemaVersion, keyVersion);
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData },
    dek,
    new TextEncoder().encode(JSON.stringify(raw)),
  );
  const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, {
    name: "AES-GCM",
    iv: envelopeNonce,
    additionalData,
  });
  const opaqueRef = `bugs/${bugId}/revision-${revision}-${crypto.randomUUID()}.enc`;
  await bucket.put(opaqueRef, body);
  return {
    opaqueRef,
    objectDigest: await digest(body),
    envelopeDek: `${base64(envelopeNonce)}.${base64(new Uint8Array(wrapped))}`,
    kekVersion: keyVersion,
    nonce: base64(nonce),
  };
}

export async function readBugPrivateObject(
  context: CommunityContext,
  input: EncryptedObjectRef & {
    readonly bugId: string;
    readonly revision: number;
    readonly schemaVersion: "bug_intake.v1" | "bug_packet.v1";
  },
): Promise<unknown> {
  const bucket = context.env.BUG_PRIVATE_OBJECTS;
  const configuredKey = context.env.BUG_PRIVATE_KEK;
  if (!bucket?.get || !configuredKey) throw new InputError("버그 비공개 저장소를 읽을 수 없어요.");
  const stored = await bucket.get(input.opaqueRef);
  if (!stored) throw new InputError("버그 비공개 기록을 찾을 수 없어요.");
  const ciphertext = await stored.arrayBuffer();
  if ((await digest(ciphertext)) !== input.objectDigest)
    throw new InputError("버그 비공개 기록의 무결성을 확인할 수 없어요.");
  const kek = await crypto.subtle.importKey(
    "raw",
    decodeKey(configuredKey),
    { name: "AES-GCM" },
    false,
    ["unwrapKey"],
  );
  const [envelopeNonce, wrappedDek] = input.envelopeDek.split(".");
  if (!envelopeNonce || !wrappedDek) throw new InputError("버그 비공개 기록을 열 수 없어요.");
  const additionalData = bugPrivateAdditionalData(
    input.bugId,
    input.revision,
    input.schemaVersion,
    input.kekVersion,
  );
  const dek = await crypto.subtle.unwrapKey(
    "raw",
    decodeBase64(wrappedDek),
    kek,
    { name: "AES-GCM", iv: decodeBase64(envelopeNonce), additionalData },
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const cleartext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(input.nonce), additionalData },
    dek,
    ciphertext,
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(cleartext));
  return parsed;
}
