import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const SHA256 = /^[a-f0-9]{64}$/;
const BASE_SHA = /^[a-f0-9]{40,64}$/;
const ISO_KST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]09:00)$/;
const PACKET_KEYS = ['confirmation', 'evidenceDigest', 'fields', 'packetDigest', 'revision', 'schemaVersion', 'source', 'status', 'bugId'];
const FIELD_KEYS = ['actual', 'expected', 'steps', 'location', 'occurredAt', 'frequency', 'impact'];

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, expected) => isObject(value)
  && Object.keys(value).length === expected.length
  && expected.every((key) => Object.hasOwn(value, key));
const requireString = (value, name, max = 10000) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new ContractError('INVALID_PACKET', `${name} must be a non-empty string`);
  return value;
};

export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

export const packetDigest = (packet) => {
  const digestBoundPacket = structuredClone(packet);
  delete digestBoundPacket.packetDigest;
  return hash(canonicalJson(digestBoundPacket));
};

export async function readRegularUtf8(path, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ContractError('UNSAFE_PATH', `${label} must be a regular file`);
    if (stat.size > 1024 * 1024) throw new ContractError('INPUT_TOO_LARGE', `${label} exceeds 1 MiB`);
    return await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (error?.code === 'ELOOP') throw new ContractError('UNSAFE_PATH', `${label} must not be a symlink`);
    throw new ContractError('READ_FAILED', `cannot read ${label}`);
  } finally {
    await handle?.close();
  }
}

export async function readTrustedSchema(path, id) {
  let schema;
  try {
    schema = JSON.parse(await readRegularUtf8(path, 'schema'));
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('INVALID_SCHEMA', 'schema is not valid JSON');
  }
  if (!isObject(schema) || schema.$id !== id) throw new ContractError('INVALID_SCHEMA', 'schema id does not match the trusted contract');
  return schema;
}

export function parseConfirmedPacket(raw) {
  let packet;
  try {
    packet = JSON.parse(raw);
  } catch {
    throw new ContractError('INVALID_PACKET', 'packet is not valid JSON');
  }
  if (!hasExactKeys(packet, PACKET_KEYS)) throw new ContractError('INVALID_PACKET', 'packet has missing or unexpected fields');
  if (packet.schemaVersion !== 'bug_packet.v1') throw new ContractError('INVALID_VERSION', 'packet schemaVersion must be bug_packet.v1');
  if (packet.status !== 'confirmed') throw new ContractError('UNCONFIRMED_PACKET', 'packet status must be confirmed');
  if (!/^BUG-[A-Z0-9]{8,32}$/.test(requireString(packet.bugId, 'bugId', 36))) throw new ContractError('INVALID_PACKET', 'bugId must match BUG-[A-Z0-9]{8,32}');
  if (!Number.isInteger(packet.revision) || packet.revision < 1) throw new ContractError('INVALID_PACKET', 'revision must be a positive integer');
  if (!hasExactKeys(packet.fields, FIELD_KEYS)) throw new ContractError('INVALID_PACKET', 'fields has missing or unexpected fields');
  requireString(packet.fields.actual, 'fields.actual');
  requireString(packet.fields.expected, 'fields.expected');
  requireString(packet.fields.location, 'fields.location', 1000);
  if (!ISO_KST.test(requireString(packet.fields.occurredAt, 'fields.occurredAt', 64)) || Number.isNaN(Date.parse(packet.fields.occurredAt))) throw new ContractError('INVALID_PACKET', 'fields.occurredAt must be KST ISO-8601');
  if (!Array.isArray(packet.fields.steps) || packet.fields.steps.length < 2 || packet.fields.steps.length > 50) throw new ContractError('INVALID_PACKET', 'fields.steps must contain at least two steps');
  packet.fields.steps.forEach((step, index) => requireString(step, `fields.steps[${index}]`, 2000));
  if (!['always', 'sometimes', 'once'].includes(packet.fields.frequency)) throw new ContractError('INVALID_PACKET', 'fields.frequency is invalid');
  if (!['inconvenience', 'blocked', 'wrong_data', 'security_privacy'].includes(packet.fields.impact)) throw new ContractError('INVALID_PACKET', 'fields.impact is invalid');
  if (!hasExactKeys(packet.confirmation, ['reporterConfirmed', 'confirmedAt']) || packet.confirmation.reporterConfirmed !== true) throw new ContractError('UNCONFIRMED_PACKET', 'reporter confirmation is required');
  if (!ISO_KST.test(requireString(packet.confirmation.confirmedAt, 'confirmation.confirmedAt', 64)) || Number.isNaN(Date.parse(packet.confirmation.confirmedAt))) throw new ContractError('INVALID_PACKET', 'confirmation.confirmedAt must be KST ISO-8601');
  if (!hasExactKeys(packet.source, ['kind', 'opaqueRef'])) throw new ContractError('INVALID_PACKET', 'source has missing or unexpected fields');
  requireString(packet.source.kind, 'source.kind', 100);
  requireString(packet.source.opaqueRef, 'source.opaqueRef', 500);
  if (!SHA256.test(packet.evidenceDigest)) throw new ContractError('INVALID_DIGEST', 'evidenceDigest must be a lowercase SHA-256 digest');
  if (!SHA256.test(packet.packetDigest) || packet.packetDigest !== packetDigest(packet)) throw new ContractError('INVALID_DIGEST', 'packetDigest does not bind this packet');
  return packet;
}

export const isBaseSha = (value) => typeof value === 'string' && BASE_SHA.test(value);
export const sha256 = hash;
