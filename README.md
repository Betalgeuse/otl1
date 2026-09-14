# ONE THING 커뮤니티 봇

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

```sh
bun qa/community-admin-access.mjs
bun qa/community-clock.mjs
bun qa/community-language-check.mjs
bun qa/community-social.mjs
bun qa/community-townhall.mjs
bun qa/community-followup.mjs
```

DB 테스트는 [설치 문서](docs/DATABASE_SETUP.md)의 폐기 가능한 로컬 DB에서만 실행하세요. 공개본은 실제 회원 기록, 운영 증거, 비공개 Slack 링크와 이전 비공개 Git 이력을 포함하지 않는 새 스냅샷입니다. 테스트 통과가 배포 환경의 실제 메시지 전달을 보장하지는 않습니다.

한글 표현 참고 자료의 라이선스는 docs/vendor/im-not-ai/LICENSE에 있습니다.

환영·첫 등록/완료/후기의 townhall 게시와 최신 안내글 전달은 [운영 명세](docs/TOWNHALL_ONBOARDING.md)를 따릅니다. 가이드 원본 채널과 관리자 메시지 timestamp를 설정하세요.
