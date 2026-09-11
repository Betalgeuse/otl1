import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = '/tmp/otl1-public';
const marker = join(destination, '.public-export');
if (existsSync(join(destination, '.git'))) throw Error('Refusing to overwrite a Git repository; preserve it and remove the export directory explicitly first.');
if (existsSync(destination) && !existsSync(marker)) throw Error('Destination exists without exporter ownership marker.');
if (existsSync(marker)) rmSync(destination, { recursive: true });
mkdirSync(destination, { recursive: true });
writeFileSync(marker, 'Curated public source snapshot; no private Git history.\n');
const write = (path, text) => { mkdirSync(dirname(join(destination,path)), { recursive:true }); writeFileSync(join(destination,path),text); };
const copy = (path) => { mkdirSync(dirname(join(destination,path)), { recursive:true }); cpSync(join(root,path),join(destination,path),{recursive:true}); };
for (const path of ['src','.gitignore','.dev.vars.example','biome.json','tsconfig.json','package.json','docs/vendor/im-not-ai','migrations/001_initial.sql','migrations/005_community.sql','migrations/007_normalized_legacy.sql','migrations/008_default_reminders.sql','scripts/slack-manifest.mjs']) copy(path);
const checks = ['check-intent.mjs','community-admin-access.mjs','community-clock.mjs','community-emoji.mjs','community-followup.mjs','community-questions.mjs','private-controls.mjs','garden-publication.mjs','slash-retirement.mjs','default-reminders.mjs','reminder-enrollment.mjs','community-language-check.mjs','community-language-variety.mjs','community-scheduler.mjs','community-social.mjs','community-storage.mjs','community-townhall.mjs','community-welcome.mjs','migration-maintenance.mjs','normalized-legacy.mjs','llm-cases.json'];
for (const name of checks) copy(`qa/${name}`);
copy('docs/COMMUNITY_QUESTIONS.md');
write('docs/DEFAULT_REMINDERS.md',readFileSync(join(root,'docs/DEFAULT_REMINDERS.md'),'utf8').replace(/이번 적용 직후에는[\s\S]*?## 이관·검증/, '## 이관·검증'));
write('docs/GARDEN_CONTROLS.md',readFileSync(join(root,'docs/GARDEN_CONTROLS.md'),'utf8').split('## 18시 안내 점검')[0]);
for (const name of readdirSync(join(root,'qa')).filter(name=>/^(community-weekend[^/]*|weekends)\.mjs$/.test(name))) copy(`qa/${name}`);
write('.gitignore',readFileSync(join(root,'.gitignore'),'utf8')+'\n.public-export\n');
const config=JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));
delete config.account_id;
config.name='onething-community';
config.vars={DATABASE_MAINTENANCE:'false',INVITATIONS_ENABLED:'false',DAILY_SCRUM_CHANNEL_ID:'C_REPLACE_DAILY',LLM_PILOT_CHANNEL_ID:'C_REPLACE_ADMIN',LLM_PILOT_USER_ID:'U_REPLACE_ADMIN',COMMUNITY_ENABLED:'true',COMMUNITY_CHANNEL_ID:'C_REPLACE_ADMIN',COMMUNITY_ADMIN_ID:'U_REPLACE_ADMIN',COMMUNITY_BOT_USER_ID:'U_REPLACE_BOT',COMMUNITY_RELEASE_CHANNEL_ID:'C_REPLACE_TOWNHALL',COMMUNITY_PUBLIC_CHANNEL_ID:'C_REPLACE_DAILY'};
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
write('README.md',`# 원씽 커뮤니티 봇

하루의 최우선순위인 중요한 일 한 가지를 Slack에서 기록하고, 완료·부분 진행·후기·휴식을 함께 나누는 봇입니다. Cloudflare Workers, Durable Objects, Neon PostgreSQL을 사용합니다.

주말에는 참여가 선택입니다. 봇 멘션 없이 daily-scrum에 원씽을 적을 수 있습니다. 미참여를 실패나 밀린 과제로 처리하지 않습니다. [주말 운영 명세](docs/WEEKEND_PARTICIPATION.md)를 참고하세요.

## 개발과 배포

Bun, Node.js 24, PostgreSQL 17이 필요합니다. 먼저 bun install --frozen-lockfile을 실행하세요. Wrangler, TypeScript, Biome는 package.json과 bun.lock에 고정된 개발 도구입니다. 프로젝트에 런타임 npm 의존성은 없습니다.

1. Cloudflare와 Slack 앱을 준비합니다. wrangler.jsonc의 모든 REPLACE 값을 본인의 채널·사용자 ID로 교체합니다. 관리 채널은 비공개로 만들고 관리자 ID는 한 사람의 실제 Slack ID로 지정합니다.
2. .dev.vars.example을 .dev.vars로 복사하고 로컬에서 값을 입력합니다. Slack 서명 키, 봇 토큰, DB URL과 보드 서명 키는 Wrangler secret으로도 등록합니다. 키나 완성된 환경 파일을 Git에 넣지 마세요.
3. [DB 설치](docs/DATABASE_SETUP.md)에 따라 새 DB를 준비합니다. 기존 커뮤니티 데이터에 이 공개 설치 스크립트를 바로 실행하지 마세요.
4. node scripts/slack-manifest.mjs https://YOUR-WORKER.workers.dev 로 본인 앱의 manifest를 생성하고 Slack 앱에 적용합니다. 앱을 재설치하고 사용할 채널에 초대합니다.
5. wrangler types worker-configuration.d.ts --env-interface CloudflareBindings 로 설정에 맞는 타입을 생성합니다.
6. bun run lint, bun run typecheck, bun run build 를 실행한 뒤 wrangler deploy 로 배포합니다.

공통 일정은 관리자 채널에서 설정합니다. 스케줄은 Durable Object alarm으로 실행되며 주말 저녁 안내와 개인 재촉은 생략합니다. 외부 채널에 실제 발송하기 전에 본인 비공개 테스트 채널에서 확인하세요.

## 검증

네트워크 없는 기본 확인:

\`\`\`sh
bun qa/community-admin-access.mjs
bun qa/community-clock.mjs
bun qa/community-language-check.mjs
bun qa/community-social.mjs
bun qa/community-townhall.mjs
bun qa/community-followup.mjs
\`\`\`

DB 테스트는 [설치 문서](docs/DATABASE_SETUP.md)의 폐기 가능한 로컬 DB에서만 실행하세요. 공개본은 실제 회원 기록, 운영 증거, 비공개 Slack 링크와 이전 비공개 Git 이력을 포함하지 않는 새 스냅샷입니다. 테스트 통과가 배포 환경의 실제 메시지 전달을 보장하지는 않습니다.

한글 표현 참고 자료의 라이선스는 docs/vendor/im-not-ai/LICENSE에 있습니다.
`);
write('docs/WEEKEND_PARTICIPATION.md',`# 주말 선택 참여

한국 시간(Asia/Seoul)의 토요일과 일요일은 선택 참여일입니다.

- 오전 공통 안내를 개인·전체 멘션 없이 한 번 게시합니다.
- daily-scrum에서 멘션 없이 자연어로 목표를 등록할 수 있습니다. 멘션도 사용할 수 있습니다.
- 안내: “주말 원씽은 선택이에요!!! 오늘 함께하고 싶다면 가장 먼저 해보고 싶은 중요한 일 한 가지를 남겨주세요. 멘션 없이 적어도 돼요. 푹 쉬어도 좋아요!”
- 주말 저녁 공통 후기 안내와 개인 등록·후기 재촉은 보내지 않습니다.
- 기록한 목표의 완료, 부분 진행, 후기, 휴식은 평일과 같은 날짜별 원본에 저장합니다.
- 미참여 주말은 실패가 아니며 월요일에도 밀린 날짜로 재촉하지 않습니다. 잔디에서 선택 참여일임을 구분합니다.
- 과거 날짜에 답글을 남기면 원래 연결된 날짜만 변경합니다. 오늘 기록으로 섞지 않습니다.

날짜 판정은 실행 서버의 현지 요일이 아니라 해당 기록 날짜와 한국 시간을 기준으로 합니다. 자동 미완료 처리와 목표 완료만으로 후기까지 제출 처리하는 동작은 없습니다.
`);
write('docs/DATABASE_SETUP.md',`# PostgreSQL 설치 및 구조

## 신규 설치

빈 PostgreSQL 17 DB에서 아래 명령을 실행하세요. PGHOST, PGPORT, PGUSER, PGDATABASE와 인증은 로컬 환경에서 지정합니다. 명령문에 운영 비밀번호를 넣지 마세요.

\`\`\`sh
psql -X -v ON_ERROR_STOP=1 -f migrations/001_initial.sql -f migrations/005_community.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/006_normalized_foundation.sql -f migrations/007_normalized_legacy.sql
psql -X -v ON_ERROR_STOP=1 -f migrations/008_default_reminders.sql
\`\`\`

006과007은 반드시 한 트랜잭션에서 적용합니다.002–004의 별도 초대·가입 정책은 이 설치에 포함하지 않습니다. 공개006은 신규 설치용이며 특정 운영 회원이나 사전 승인된 예외를 포함하지 않습니다.

새 워크스페이스의 첫 공개 기록이 생성된 뒤, 레거시 /one 및 잔디 조회를 사용하려면 workspaces.primary_goal_channel_id를 명시적으로 설정해야 합니다. workspace_channels에 해당 채널이 존재하는지 확인하고 관리자가 지정한 공개 채널만 연결하세요. 비공개 테스트 채널로 추측해 연결하지 마세요.

기존 데이터 이관은 먼저 별도 백업과 복원 시험, 쓰기 중단, 명시적 워크스페이스/채널 매핑, 충돌 대조를 수행해야 합니다.006 내 매핑 위치에 본인 검토값을 작성하세요. 원본과 레거시 기록이 다르면 공개 이관은 중단됩니다. 실제 자료를 확인한 사람이 판단·근거·복구 방법을 비공개 문서로 승인한 뒤 재시도하세요. 충돌 검사를 제거해서 통과시키지 마세요.

## 관계

\`\`\`mermaid
erDiagram
  workspaces ||--o{ workspace_members : has
  workspaces ||--o{ workspace_channels : has
  workspace_members ||--o{ profiles : configures
  workspace_members ||--o{ community_days : records
  workspace_channels ||--o{ community_days : scopes
  community_days ||..o{ community_events : logical_history
  workspace_members ||--o{ community_preferences : configures
  workspace_channels ||--o{ channel_schedules : schedules
  workspace_members ||--o{ community_records : owns
  workspace_members ||--o{ community_milestones : achieves
\`\`\`

회원의 키는 (team_id,user_id), 채널은 (team_id,channel_id), 날짜별 기록은 (team_id,channel_id,user_id,day)입니다. community_days가 목표·후기의 원본이며 goals는 지정된 공개 채널을 읽는 호환 뷰입니다. 이벤트와 날짜의 연결은 논리 관계이며 ERD 점선은 DB 외래 키를 의미하지 않습니다. 과거 데이터는 otl_archive에 보존되며 공개 저장소에는 DB 내용이 없습니다.

## 로컬 테스트

운영 Neon을 사용하지 않는 폐기 가능한 로컬 PostgreSQL을 준비하고 위 신규 설치를 적용합니다. 저장소·스케줄 테스트는 COMMUNITY_PG_SOCKET, COMMUNITY_PG_PORT, COMMUNITY_PG_DATABASE로 해당 DB만 지정합니다.

\`\`\`sh
bun qa/community-storage.mjs
bun qa/community-scheduler.mjs
node qa/normalized-legacy.mjs
\`\`\`

기본 소켓 /tmp/otl-community-pg, 포트55439를 사용합니다. DB 이름은 테스트마다 다를 수 있으므로 COMMUNITY_PG_DATABASE를 명시하세요. 실제 운영 백업을 공개 테스트 fixture로 사용하지 마세요.
`);
write('.dev.vars',readFileSync(join(root,'.dev.vars.example'),'utf8'));
try { execFileSync(join(destination,'node_modules/.bin/wrangler'),['types','worker-configuration.d.ts','--env-interface','CloudflareBindings'],{cwd:destination,stdio:'pipe'}); } finally { rmSync(join(destination,'.dev.vars')); }
console.log('Public snapshot prepared at '+destination);
