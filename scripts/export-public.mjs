import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? '/tmp/otl1-public');
const marker = join(destination, '.public-export');
if (existsSync(join(destination, '.git'))) throw Error('Refusing to overwrite a Git repository; preserve it and remove the export directory explicitly first.');
if (existsSync(destination) && !existsSync(marker)) throw Error('Destination exists without exporter ownership marker.');
if (existsSync(marker)) rmSync(destination, { recursive: true });
mkdirSync(destination, { recursive: true });
writeFileSync(marker, 'Curated public source snapshot; no private Git history.\n');
const write = (path, text) => { mkdirSync(dirname(join(destination,path)), { recursive:true }); writeFileSync(join(destination,path),text); };
const copy = (path) => { mkdirSync(dirname(join(destination,path)), { recursive:true }); cpSync(join(root,path),join(destination,path),{recursive:true}); };
for (const path of ['src','.gitignore','.dev.vars.example','biome.json','tsconfig.json','package.json','docs/vendor/im-not-ai','automation','migrations/001_initial.sql','migrations/005_community.sql','migrations/007_normalized_legacy.sql','migrations/008_default_reminders.sql','migrations/009_welcome_guides.sql','migrations/010_first_registration.sql','migrations/011_member_introductions.sql','migrations/012_introduction_public_details.sql','migrations/013_multiline_introductions.sql','migrations/014_bug_ledger.sql','migrations/015_bug_deliveries.sql','migrations/016_bug_delivery_scheduler.sql','migrations/017_bug_expiry_job_guard.sql','migrations/018_bug_integrity.sql','migrations/019_bug_team_scope.sql','migrations/020_bug_private_atomic.sql','migrations/021_bug_private_backfill.sql','scripts/slack-manifest.mjs','scripts/test-unit.mjs','scripts/check.mjs','scripts/maintainer-dry-run.mjs']) copy(path);
const checks = ['check-intent.mjs','community-admin-access.mjs','community-clock.mjs','community-emoji.mjs','community-followup.mjs','community-questions.mjs','private-controls.mjs','garden-publication.mjs','slash-retirement.mjs','default-reminders.mjs','reminder-enrollment.mjs','weekend-hidden.mjs','community-edit-language.mjs','natural-edits.mjs','current-garden.mjs','reflection-header.mjs','reflection-routing.mjs','slack-message-edit.mjs','community-guide.mjs','townhall-milestones.mjs','brand-copy.mjs','first-registration.sql','edit-storage.sql','community-language-check.mjs','community-language-variety.mjs','community-record-decision.mjs','community-introduction.mjs','community-introduction-channel.mjs','community-scheduler.mjs','community-social.mjs','community-storage.mjs','community-townhall.mjs','community-welcome.mjs','migration-maintenance.mjs','normalized-legacy.mjs','llm-cases.json','community-bugs.mjs','community-bug-dialogue.mjs','community-bug-due-store.mjs','community-bug-backlog.mjs','community-bug-private-backfill.mjs','community-bug-private-delivery.mjs','community-bug-slack-validator.mjs','community-bug-storage.mjs','bug-storage-contract.sql','community-bug-delivery.mjs','bug-delivery-contract.sql','community-bug-expiry-job-guard.mjs','bug-expiry-job-guard-contract.sql','bug-db-integrity-contract.sql','bug-team-scope-contract.sql','bug-private-atomic-contract.sql','bug-private-backfill-contract.sql','bug-private-backfill-fixture.sql','bug-dialogue-cases.json','maintainer-dry-run.mjs','fixtures/bug-packets/confirmed-valid.v1.json'];
for (const name of checks) copy(`qa/${name}`);
const publicDocs = ['README.md','USER_GUIDE.md','OPERATIONS.md','ARCHITECTURE.md','DEVELOPMENT.md','PRODUCT_PRINCIPLES.md','ROADMAP.md','UPDATE_HISTORY.md'];
for (const name of publicDocs) copy('docs/'+name);
copy('README.md');
write('docs/archive/README.md','# 보관 문서\n\n과거 공개 문서는 Git 이력에서 확인할 수 있습니다. 현재 사용법은 [문서 안내](../README.md)를 따릅니다.\n');
write('docs/research/README.md','# 조사 자료\n\n공개 가능한 조사 자료를 별도로 관리합니다. 현재 결정은 [제품 원칙](../PRODUCT_PRINCIPLES.md), 앞으로의 계획은 [로드맵](../ROADMAP.md)을 따릅니다.\n');
let designJournal=readFileSync(join(root,'docs/research/DESIGN_JOURNAL.md'),'utf8');
for (const [link,label] of [
  ['COMMUNITY_BENCHMARK.md','커뮤니티 벤치마크'],
  ['../archive/PROACTIVE_SUPPORT_DESIGN.md','선제적 지원 조사'],
  ['TRUST_REWARDS_REVENUE.md','지인 신뢰와 수익 조사'],
]) designJournal=designJournal.replaceAll(`[${label}](${link})`,label);
write('docs/research/DESIGN_JOURNAL.md',designJournal);
for (const name of readdirSync(join(root,'qa')).filter(name=>/^(community-weekend[^/]*|weekends)\.mjs$/.test(name))) copy(`qa/${name}`);
write('.gitignore',readFileSync(join(root,'.gitignore'),'utf8')+'\n.public-export\n');
const config=JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));
delete config.account_id;
config.name='onething-community';
config.vars={COMMUNITY_WELCOME_CHANNEL_ID:'C_REPLACE_WELCOME',COMMUNITY_INTRO_CHANNEL_ID:'C_REPLACE_INTRO',COMMUNITY_GUIDE_SOURCE_TS:'0.000001',DATABASE_MAINTENANCE:'false',INVITATIONS_ENABLED:'false',DAILY_SCRUM_CHANNEL_ID:'C_REPLACE_DAILY',LLM_PILOT_CHANNEL_ID:'C_REPLACE_ADMIN',LLM_PILOT_USER_ID:'U_REPLACE_ADMIN',COMMUNITY_ENABLED:'true',COMMUNITY_CHANNEL_ID:'C_REPLACE_ADMIN',COMMUNITY_ADMIN_ID:'U_REPLACE_ADMIN',COMMUNITY_BOT_USER_ID:'U_REPLACE_BOT',COMMUNITY_RELEASE_CHANNEL_ID:'C_REPLACE_TOWNHALL',COMMUNITY_PUBLIC_CHANNEL_ID:'C_REPLACE_DAILY'};
config.r2_buckets=[{binding:'BUG_PRIVATE_OBJECTS',bucket_name:'replace-with-private-bucket'}];
write('wrangler.jsonc',JSON.stringify(config,null,2)+'\n');
const packageMetadata = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
packageMetadata.devDependencies = { '@biomejs/biome':'2.5.6', typescript:'7.1.0-dev.20260809.1', wrangler:'4.62.0' };
packageMetadata.scripts.typecheck = 'tsc --noEmit';
write('package.json',JSON.stringify(packageMetadata,null,2)+'\n');
execFileSync('bun',['install'],{cwd:destination,stdio:'pipe'});

write('slack-manifest.json',execFileSync(process.execPath,[join(root,'scripts/slack-manifest.mjs'),'https://your-worker.workers.dev'],{encoding:'utf8'}));
let migration=readFileSync(join(root,'migrations/006_normalized_foundation.sql'),'utf8');
function replaceBetween(start,end,replacement) { const a=migration.indexOf(start),b=migration.indexOf(end,a);if(a<0||b<a)throw Error('Migration source changed; inspect export transformation.');migration=migration.slice(0,a)+replacement+migration.slice(b); }
replaceBetween('-- Explicit production mapping','DO $$ BEGIN\n IF EXISTS(SELECT 1 FROM otl.goals',`-- Fresh installs contain no goals. Existing installations must supply an explicitly\n-- reviewed workspace/channel mapping here before importing legacy goals.\n`);
replaceBetween(" CASE WHEN d.user_id=",' FROM otl.community_days d JOIN'," NULL::text\n");
replaceBetween('DO $$ BEGIN\n IF EXISTS(SELECT 1 FROM otl_archive.goal_reconciliation','ALTER TABLE otl.community_days ADD COLUMN',`DO $$ BEGIN\n IF EXISTS(SELECT 1 FROM otl_archive.goal_reconciliation WHERE legacy_before IS NOT NULL)\n THEN RAISE EXCEPTION 'Unreviewed source disagreement; reconcile explicitly before migration'; END IF;\nEND $$;\n\n`);
write('migrations/006_normalized_foundation.sql',migration);
write('.dev.vars',readFileSync(join(root,'.dev.vars.example'),'utf8'));
try { execFileSync(join(destination,'node_modules/.bin/wrangler'),['types','worker-configuration.d.ts','--env-interface','CloudflareBindings'],{cwd:destination,stdio:'pipe'}); } finally { rmSync(join(destination,'.dev.vars')); }
console.log('Public snapshot prepared at '+destination);
