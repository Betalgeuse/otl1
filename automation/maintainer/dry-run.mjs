import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError, isBaseSha, parseConfirmedPacket, readRegularUtf8, readTrustedSchema, sha256 } from './contract.mjs';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const schemaDirectory = resolve(moduleDirectory, '..', 'schemas');
const outputRoot = resolve(tmpdir(), 'otl1-maintainer-dry-run');

export class CancellationError extends Error {
  constructor() {
    super('dry-run cancelled');
    this.code = 'CANCELLED';
  }
}

const fail = (code, message) => { throw new ContractError(code, message); };
const assertNotCancelled = (signal) => { if (signal?.aborted) throw new CancellationError(); };
const inside = (child, parent) => child.startsWith(`${parent}/`);

async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail('UNSAFE_PATH', 'temporary directory must be private and owned by this user');
  return path;
}

async function ensureOutputRoot() {
  const parent = resolve(tmpdir());
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('UNSAFE_PATH', 'system temporary directory is unsafe');
  try {
    await privateDirectory(outputRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await privateDirectory(outputRoot, true);
    await chmod(outputRoot, 0o700);
  }
  return outputRoot;
}

async function createOutputDirectory(requested) {
  const root = await ensureOutputRoot();
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!inside(candidate, root) || dirname(candidate) !== root || basename(candidate) === '') fail('UNSAFE_PATH', `output must be a new direct child of ${root}`);
  try {
    await lstat(candidate);
    fail('UNSAFE_PATH', 'output path already exists or is unsafe');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await privateDirectory(candidate, true);
  return candidate;
}

async function writeNew(path, content) {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle?.close();
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  } catch {
    fail('GIT_FAILED', 'unable to inspect the current Git repository');
  }
}

function currentBase(expectedBaseSha) {
  const repository = git(['rev-parse', '--show-toplevel']);
  const sha = git(['rev-parse', 'HEAD']);
  if (!isBaseSha(sha)) fail('GIT_FAILED', 'Git returned an invalid base SHA');
  if (expectedBaseSha !== undefined && (!isBaseSha(expectedBaseSha) || expectedBaseSha !== sha)) fail('STALE_BASE_SHA', 'requested base SHA is stale');
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  return { repository, sha, dirty: status.length > 0, statusDigest: sha256(status) };
}

function promptFor(packet, base) {
  return [
    '# OTL1 maintainer handoff',
    '',
    'Prepare a reproduce-only plan. Do not edit, commit, send messages, access credentials, use network tools, or invoke a provider until a separate authorized executor accepts this handoff.',
    '',
    `Bug ID: ${packet.bugId}`,
    `Packet digest: ${packet.packetDigest}`,
    `Base SHA: ${base.sha}`,
    '',
    '## Confirmed observation',
    packet.fields.actual,
    '',
    '## Expected behavior',
    packet.fields.expected,
    '',
    '## Reproduction steps',
    ...packet.fields.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `Location: ${packet.fields.location}`,
    `Occurred at: ${packet.fields.occurredAt}`,
    `Frequency: ${packet.fields.frequency}`,
    `Impact: ${packet.fields.impact}`,
  ].join('\n');
}

async function acquireLease(packetDigest) {
  const root = await ensureOutputRoot();
  const locks = join(root, 'locks');
  try {
    await privateDirectory(locks);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await privateDirectory(locks, true);
  }
  const path = join(locks, `${packetDigest}.lock`);
  const lease = { id: randomUUID(), packetDigest, acquiredAt: new Date().toISOString() };
  try {
    await writeNew(path, JSON.stringify(lease));
  } catch (error) {
    if (error?.code === 'EEXIST') fail('LEASE_HELD', 'packet already has a local lease');
    throw error;
  }
  return { ...lease, path };
}

async function holdFor(milliseconds, signal) {
  if (milliseconds === 0) return;
  await new Promise((resolveHold, rejectHold) => {
    const timer = setTimeout(resolveHold, milliseconds);
    const cancel = () => { clearTimeout(timer); rejectHold(new CancellationError()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function runDryRun({ input, output, expectedBaseSha, holdMilliseconds = 0, signal } = {}) {
  if (typeof input !== 'string' || typeof output !== 'string') fail('USAGE', '--input and --output are required');
  if (!Number.isInteger(holdMilliseconds) || holdMilliseconds < 0 || holdMilliseconds > 30000) fail('USAGE', '--hold-ms must be an integer from 0 to 30000');
  assertNotCancelled(signal);
  await readTrustedSchema(join(schemaDirectory, 'bug-packet.v1.json'), 'https://otl1.local/schemas/bug-packet.v1.json');
  await readTrustedSchema(join(schemaDirectory, 'maintainer-handoff.v1.json'), 'https://otl1.local/schemas/maintainer-handoff.v1.json');
  const packet = parseConfirmedPacket(await readRegularUtf8(input, 'input packet'));
  const base = currentBase(expectedBaseSha);
  const lease = await acquireLease(packet.packetDigest);
  let outputDirectory;
  let complete = false;
  try {
    assertNotCancelled(signal);
    outputDirectory = await createOutputDirectory(output);
    await holdFor(holdMilliseconds, signal);
    assertNotCancelled(signal);
    const prompt = promptFor(packet, base);
    const promptPath = join(outputDirectory, 'prompt.md');
    await writeNew(promptPath, prompt);
    const handoff = {
      schemaVersion: 'maintainer_handoff.v1', dryRun: true, mutations: [],
      packet: { schemaVersion: packet.schemaVersion, bugId: packet.bugId, revision: packet.revision, packetDigest: packet.packetDigest, evidenceDigest: packet.evidenceDigest },
      base: { sha: base.sha, dirty: base.dirty, statusDigest: base.statusDigest },
      execution: { mode: 'reproduce_plan_only', worktree: 'simulation', providers: ['codex_cloud_github', 'genquant_codex_switch', 'slack_codex_app'] },
      prompt: { path: 'prompt.md', digest: sha256(prompt), format: 'text/markdown' },
    };
    await writeNew(join(outputDirectory, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`);
    const receipt = {
      schemaVersion: 'maintainer_dry_run_receipt.v1', dryRun: true, mutations: [],
      packet: handoff.packet, base: handoff.base,
      lease: { id: lease.id, state: 'released' },
      worktree: { mode: 'simulation', created: false, reason: 'credential-free dry-run never invokes git worktree' },
      promptPath: 'prompt.md', handoffPath: 'handoff.json',
    };
    await writeNew(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    complete = true;
    return { outputDirectory, receipt, handoff };
  } finally {
    await rm(lease.path, { force: true });
    if (!complete && outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  }
}
