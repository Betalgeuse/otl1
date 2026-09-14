import { execFileSync } from 'node:child_process';
for (const step of ['lint', 'typecheck', 'test:unit', 'build']) {
  console.log(`Checking ${step}`);
  execFileSync('bun', ['run', step], { stdio: 'inherit' });
}
