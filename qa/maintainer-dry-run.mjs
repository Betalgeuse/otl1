import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readTrustedSchema } from '../automation/maintainer/contract.mjs';

const repo = resolve(new URL('..', import.meta.url).pathname);
const runner = join(repo, 'scripts', 'maintainer-dry-run.mjs');
const controlledRoot = join(tmpdir(), 'otl1-maintainer-dry-run');
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digestPacket = (packet) => {
  const withoutDigest = structuredClone(packet);
  delete withoutDigest.packetDigest;
  return createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex');
};

const runRoot = await mkdtemp(join(tmpdir(), 'otl1-maintainer-red-'));
const packet = {
  schemaVersion: 'bug_packet.v1',
  bugId: 'BUG-QATEST001',
  status: 'confirmed',
  revision: 1,
  fields: {
    actual: '저장 버튼을 눌러도 기록이 남지 않습니다.',
    expected: '저장 뒤 오늘 기록이 다시 보입니다.',
    steps: ['오늘 기록 화면을 엽니다.', '저장 버튼을 누릅니다.'],
    location: '오늘 기록 화면',
    occurredAt: '2026-09-16T10:00:00+09:00',
    frequency: 'always',
    impact: 'blocked',
  },
  confirmation: { reporterConfirmed: true, confirmedAt: '2026-09-16T10:02:00+09:00' },
  source: { kind: 'qa_fixture', opaqueRef: 'qa:red' },
  evidenceDigest: 'a'.repeat(64),
};
packet.packetDigest = digestPacket(packet);
const input = join(runRoot, 'confirmed.json');
const outputName = `qa-${Date.now()}-${process.pid}`;
const output = join(controlledRoot, outputName);
await writeFile(input, JSON.stringify(packet));
const invoke = (packetPath, directory, extra = []) => spawnSync(process.execPath, [runner, '--input', packetPath, '--output', directory, ...extra], { encoding: 'utf8' });
const writePacket = async (name, change = (value) => value) => {
  const candidate = change(structuredClone(packet));
  candidate.packetDigest = digestPacket(candidate);
  const path = join(runRoot, `${name}.json`);
  await writeFile(path, JSON.stringify(candidate));
  return path;
};
const gitStatus = () => spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).stdout;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const waitFor = async (check) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await delay(25);
  }
  throw Error('timed out waiting for runner state');
};

try {
  // Given: one confirmed, digest-bound packet. When: the public CLI is invoked.
  // Then: a provider-neutral, no-mutation receipt and prompt are observable.
  const beforeStatus = gitStatus();
  const result = invoke(input, output);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'));
  const handoff = JSON.parse(await readFile(join(output, 'handoff.json'), 'utf8'));
  assert.equal(receipt.dryRun, true);
  assert.deepEqual(receipt.mutations, []);
  assert.match(receipt.base.sha, /^[a-f0-9]{40,64}$/);
  assert.equal(receipt.base.dirty, beforeStatus.length > 0);
  assert.equal(receipt.worktree.mode, 'simulation');
  assert.equal(handoff.prompt.path, 'prompt.md');
  assert.deepEqual(handoff.execution.providers, ['codex_cloud_github', 'genquant_codex_switch', 'slack_codex_app']);
  assert.equal(gitStatus(), beforeStatus, 'dry run must not change Git status');

  // Given: invalid packets. When: the public CLI receives them. Then: each fails closed.
  const unconfirmed = await writePacket('unconfirmed', (value) => { value.status = 'triaged'; return value; });
  const wrongVersion = await writePacket('wrong-version', (value) => { value.schemaVersion = 'bug_packet.v0'; return value; });
  const tampered = structuredClone(packet);
  tampered.fields.actual = 'tampered after confirmation';
  const tamperedPath = join(runRoot, 'tampered.json');
  await writeFile(tamperedPath, JSON.stringify(tampered));
  const lowercaseId = await writePacket('lowercase-id', (value) => { value.bugId = 'bug-qatest001'; return value; });
  for (const [name, packetPath] of [['unconfirmed', unconfirmed], ['wrong-version', wrongVersion], ['tampered', tamperedPath], ['lowercase-id', lowercaseId]]) {
    const rejected = invoke(packetPath, join(controlledRoot, `${outputName}-${name}`));
    assert.notEqual(rejected.status, 0, `${name} packet unexpectedly succeeded`);
  }

  // Given: prompt-injection text. When: it reaches the runner. Then: it is only written as prompt data.
  const marker = join(runRoot, 'shell-interpolation-marker');
  const injected = await writePacket('injected', (value) => { value.fields.actual = `$(touch ${marker}) ; \`touch ${marker}\``; return value; });
  const injectionOutput = join(controlledRoot, `${outputName}-injection`);
  assert.equal(invoke(injected, injectionOutput).status, 0);
  assert.equal(existsSync(marker), false, 'untrusted packet text must not execute a shell command');

  // Given: stale base and an outside output path. When: the CLI is invoked. Then: both are rejected.
  assert.notEqual(invoke(input, join(controlledRoot, `${outputName}-stale`), ['--base-sha', '0'.repeat(40)]).status, 0);
  assert.notEqual(invoke(input, join(runRoot, 'outside-output')).status, 0);

  // Given: symlinked input, schema, and output. When: each is used. Then: trusted-path checks reject it.
  const inputLink = join(runRoot, 'input-link.json');
  await symlink(input, inputLink);
  assert.notEqual(invoke(inputLink, join(controlledRoot, `${outputName}-input-link`)).status, 0);
  const schemaLink = join(runRoot, 'schema-link.json');
  await symlink(join(repo, 'automation', 'schemas', 'bug-packet.v1.json'), schemaLink);
  await assert.rejects(() => readTrustedSchema(schemaLink, 'https://otl1.local/schemas/bug-packet.v1.json'), { code: 'UNSAFE_PATH' });
  await mkdir(controlledRoot, { recursive: true, mode: 0o700 });
  await chmod(controlledRoot, 0o700);
  const outputLink = join(controlledRoot, `${outputName}-output-link`);
  await symlink(runRoot, outputLink);
  assert.notEqual(invoke(input, outputLink).status, 0);
  await unlink(outputLink);

  // Given: a held lease. When: a second run starts. Then: it cannot claim the same packet.
  const locks = join(controlledRoot, 'locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  await chmod(locks, 0o700);
  const lockPath = join(locks, `${packet.packetDigest}.lock`);
  await writeFile(lockPath, '{}', { mode: 0o600 });
  assert.notEqual(invoke(input, join(controlledRoot, `${outputName}-leased`)).status, 0);
  await unlink(lockPath);

  // Given: a deliberately held dry run. When: SIGINT is delivered twice. Then: lock/output cleanup allows a resume.
  const cancelledOutput = join(controlledRoot, `${outputName}-cancelled`);
  const child = spawn(process.execPath, [runner, '--input', input, '--output', cancelledOutput, '--hold-ms', '30000'], { stdio: 'ignore' });
  await waitFor(() => existsSync(lockPath));
  child.kill('SIGINT');
  child.kill('SIGINT');
  const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
  assert.equal(exitCode, 130);
  assert.equal(existsSync(lockPath), false, 'cancelled lease must be released');
  await assert.rejects(() => lstat(cancelledOutput), { code: 'ENOENT' });
  assert.equal(invoke(input, join(controlledRoot, `${outputName}-resumed`)).status, 0, 'resume must not inherit an interrupted lease');

  console.log('PASS maintainer dry-run validates confirmed packets, preserves Git state, rejects unsafe inputs, and cleans interrupted leases');
} finally {
  await rm(runRoot, { recursive: true, force: true });
  await Promise.all([output, join(controlledRoot, `${outputName}-injection`), join(controlledRoot, `${outputName}-lowercase-id`), join(controlledRoot, `${outputName}-resumed`)].map((path) => rm(path, { recursive: true, force: true })));
}
