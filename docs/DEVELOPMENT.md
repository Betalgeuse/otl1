# 개발 가이드

## 시작과 검증

Bun과 Node.js 24를 사용합니다. 개발 도구 버전은 `package.json`과 `bun.lock`이 기준입니다.

```sh
bun install --frozen-lockfile
bun run check
```

`check`는 lint → TypeScript → 29개 합성 회귀 → Wrangler dry-run 순서로 실행하며 실패 시 중단합니다. 실제 배포·운영 DB·Slack 발송은 호출하지 않습니다. 테스트 목록은 `scripts/test-unit.mjs` 한 곳에서 관리하며 각 검사는 새 Bun 프로세스에서 실행합니다.

## 설정과 배포

1. `.dev.vars.example`을 `.dev.vars`로 복사하고 로컬 값을 채웁니다. 완성된 파일은 Git에 넣지 않습니다.
2. `wrangler.jsonc`에 본인 계정의 Worker·관리자·공개 채널·townhall·welcome·자기소개 채널을 지정합니다. 관리자 채널은 비공개로 유지합니다.
3. `COMMUNITY_GUIDE_SOURCE_TS`에는 지정 관리자가 welcome 채널에 작성한 원본 안내글의 timestamp를 넣습니다.
4. 서명 키, 봇 토큰, DB URL, 보드 서명 키를 Wrangler secret으로 등록합니다. 값은 명령문·문서·공개 이력에 남기지 않습니다.
5. 앱 manifest를 생성해 Slack에 적용하고 필요한 채널에 봇을 연결합니다. 슬래시 `/one`은 사용하지 않습니다.

```sh
node scripts/slack-manifest.mjs https://YOUR-WORKER.workers.dev
bunx --no-install wrangler types worker-configuration.d.ts --env-interface CloudflareBindings
bun run check
bun run deploy
```

입장 이벤트 구독과 가이드 원본 권한을 실제 Slack 앱에서 확인합니다. 설정 파일 존재나 빌드 성공만으로 설치가 완료됐다고 하지 않습니다.

## DB 설치와 이관

신규 설치는 **공개 저장소의 빈 DB용 migration**을 사용합니다. 운영 저장소의 비공개 이관 파일에는 당시 원본 대조와 운영 매핑이 포함될 수 있으므로 다른 커뮤니티에 그대로 적용하지 않습니다.

```sh
psql -X -v ON_ERROR_STOP=1 -f migrations/001_initial.sql -f migrations/005_community.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/006_normalized_foundation.sql -f migrations/007_normalized_legacy.sql
psql -X -v ON_ERROR_STOP=1 -f migrations/008_default_reminders.sql
psql -X -v ON_ERROR_STOP=1 -f migrations/009_welcome_guides.sql -f migrations/010_first_registration.sql
psql -X -v ON_ERROR_STOP=1 -f migrations/011_member_introductions.sql -f migrations/012_introduction_public_details.sql
```

006·007은 반드시 한 트랜잭션으로 적용합니다. 별도 초대 정책인002~004를 일괄 실행하지 않습니다. 워크스페이스의 `primary_goal_channel_id`는 실제 공개 목표 채널로 명시적으로 연결하며 QA 채널을 추측해 넣지 않습니다.

기존 DB는 **백업 → 별도 복원 → 원본 충돌 대조 → 쓰기 정리 → 이관 → 전후 비교 → 실제 사용자 확인** 순서로 다룹니다. 알 수 없는 충돌을 덮어쓰거나 검사를 제거하지 않습니다. 복구는 이관 뒤 생긴 새 기록도 보존해야 합니다. 옛 rollback 파일이 현재 모든 후속 migration에 맞는다고 가정하지 않습니다.

## 검사 구분

| 범위 | 실행과 주의점 |
| --- | --- |
| 합성 회귀 | `bun run test:unit`. 공개 코드의 기본 검증 |
| PostgreSQL | 폐기 가능한 로컬 DB에 설치 후 `community-storage`, `community-scheduler`, `normalized-legacy`, `default-reminders` 및 SQL 검사 실행 |
| 실제 서비스 | 명시한 채널·회원·날짜만 검증. 전후 기록, 실제 게시, 실패 범위를 별도 보존 |

DB 검사의 `COMMUNITY_PG_SOCKET`, `COMMUNITY_PG_PORT`, `COMMUNITY_PG_DATABASE`를 확인합니다. 기본값이 검사마다 다를 수 있으므로 DB 이름을 명시합니다. `*-live*`, backfill, fixture 복원, migration 스크립트를 일반 테스트에 섞지 않습니다.

## Git과 공개 코드

코드·직접 관련 테스트·명세를 함께 커밋하고 첫 줄에는 변경 목적을 씁니다. 필요한 `Constraint`, `Rejected`, `Tested`, `Not-tested` trailer로 결정과 검증 한계를 남깁니다. 제품 버전과 migration 번호는 별개입니다.

운영 이력이 있는 로컬 저장소는 공개 원격에 `--all`이나 `--mirror`로 push하지 않습니다. 공개 설정 예시·합성 테스트만 별도 작업본에 반영하고 staged 정보 검사와 `check`를 거쳐 push합니다. API 키·회원 원문·덤프·`.omx` 영수증은 제외합니다.

`export-public.mjs`가 있는 운영 저장소에서는 공개용 스냅샷을 생성할 수 있습니다. 기존 공개 Git 이력이 있는 경로를 덮어쓰지 않도록 보호되어 있습니다. 공개용 문서 원본은 이 문서 묶음이며, 내보내기 스크립트에 별도 사용법을 복제하지 않습니다.

데이터 모델은 [시스템 구조](ARCHITECTURE.md), 서비스 사용법은 [사용 가이드](USER_GUIDE.md)를 따릅니다.
