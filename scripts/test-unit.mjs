import { execFileSync } from 'node:child_process';

// Explicit allowlist excludes scripts that load live credentials or require a disposable PostgreSQL migration.
const suites = [
  'community-admin-access', 'community-clock', 'community-emoji', 'community-followup',
  'community-questions', 'private-controls', 'garden-publication', 'slash-retirement',
  'reminder-enrollment', 'weekend-hidden', 'community-edit-language', 'natural-edits',
  'current-garden', 'reflection-header', 'reflection-routing', 'slack-message-edit',
  'community-guide', 'townhall-milestones', 'brand-copy', 'community-language-check',
  'community-language-variety', 'community-target-date', 'community-target-date-routing', 'community-record-decision', 'community-social', 'community-townhall',
  'community-welcome', 'community-introduction', 'community-introduction-channel',
  'migration-maintenance', 'weekends', 'community-bugs', 'community-bug-dialogue',
  'community-bug-due-store',
  'community-bug-backlog',
];
for (const suite of suites) execFileSync('bun', [`qa/${suite}.mjs`], { stdio: 'inherit' });
console.log(`Passed ${suites.length} isolated synthetic suites.`);
