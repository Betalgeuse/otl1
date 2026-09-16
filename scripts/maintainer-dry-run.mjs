import { CancellationError, runDryRun } from '../automation/maintainer/dry-run.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 === args.length || args[index + 1].startsWith('--')) throw Error(`${name} requires a value`);
  return args[index + 1];
};
if (args.includes('--help')) {
  console.log('Usage: node scripts/maintainer-dry-run.mjs --input <confirmed-packet.json> --output <private-temp-child> [--base-sha <sha>]');
  process.exit(0);
}
const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  const result = await runDryRun({
    input: value('--input'), output: value('--output'), expectedBaseSha: args.includes('--base-sha') ? value('--base-sha') : undefined,
    holdMilliseconds: args.includes('--hold-ms') ? Number(value('--hold-ms')) : 0, signal: controller.signal,
  });
  console.log(JSON.stringify({ dryRun: true, receipt: `${result.outputDirectory}/receipt.json`, handoff: `${result.outputDirectory}/handoff.json` }));
} catch (error) {
  console.error(error.message);
  process.exitCode = error instanceof CancellationError ? 130 : 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
