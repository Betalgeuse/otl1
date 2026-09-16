# 개발 가이드

## 시작과 검증

Bun과 Node.js 24를 사용합니다. 개발 도구 버전은 `package.json`과 `bun.lock`이 기준입니다.

```sh
bun install --frozen-lockfile
bun run check
```

`check`는 lint → TypeScript → 33개 합성 회귀 → Wrangler dry-run 순서로 실행하며 실패 시 중단합니다. 실제 배포·운영 DB·Slack 발송은 호출하지 않습니다. 테스트 목록은 `scripts/test-unit.mjs` 한 곳에서 관리하며 각 검사는 새 Bun 프로세스에서 실행합니다.

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
```

입장 이벤트 구독과 가이드 원본 권한을 실제 Slack 앱에서 확인합니다. 설정 파일 존재나 빌드 성공만으로 설치가 완료됐다고 하지 않습니다. 위 준비 명령은 배포 권한을 부여하지 않습니다.

### 배포 권한 구분

정식 출시·canonical 배포는 private `ops/main`의 merge queue 결과만 사용합니다. 비공개 운영 저장소의 canonical preflight가 현재 full SHA, 정확한 remote, clean `main`, ruleset API readback과 GenQuant 영수증을 모두 확인해야 하며, 실패한 checkout에서 정식 배포·release·public mirror 게시를 진행하지 않습니다.

이미 존재하는 Worker에서 최종 Slack 동작을 확인해야 할 때는 명시적으로 승인된 **pre-release QA 배포**만 예외로 허용합니다. 승인된 시나리오, clean full SHA, 이전·새 Worker version, migration 목록, maintenance 차단과 해제, read-only health·binding·Cron 보존, 별도 clock readiness 근거, rollback 대상과 정리 범위를 한 영수증에 묶습니다. `/health`는 liveness와 정적 capability만 증명하며 clock readiness는 식별자를 제거한 Durable Object inspect/admin·배포 영수증 또는 서명된 activity로 증명합니다. 이 예외는 승인된 기존 Worker version upload·deploy 범위만 허용하며 Git push, merge, release 게시, public mirror 게시, provider 실행 또는 canonical 판정을 허용하지 않습니다. migration은 forward-only이므로 코드 rollback도 적용된 schema와 호환돼야 합니다.

exact SHA `4f05ae75f93ad5f7bca6ebfcb7c3613fbe8dae20`은 이 예외에서 Chrome Slack Web QA를 통과했습니다. 현재 checker는 계속 `canonical: false`이고 private `ops/main` release authority가 없으므로, v0.0.54는 그 이유 하나로 pre-release입니다.

## DB 설치와 이관

신규 설치는 **공개 저장소의 빈 DB용 migration**을 사용합니다. 운영 저장소의 비공개 이관 파일에는 당시 원본 대조와 운영 매핑이 포함될 수 있으므로 다른 커뮤니티에 그대로 적용하지 않습니다.

```sh
psql -X -v ON_ERROR_STOP=1 -f migrations/001_initial.sql -f migrations/005_community.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/006_normalized_foundation.sql -f migrations/007_normalized_legacy.sql
psql -X -v ON_ERROR_STOP=1 -f migrations/008_default_reminders.sql
psql -X -v ON_ERROR_STOP=1 -f migrations/009_welcome_guides.sql -f migrations/010_first_registration.sql
psql -X -v ON_ERROR_STOP=1 -f migrations/011_member_introductions.sql -f migrations/012_introduction_public_details.sql -f migrations/013_multiline_introductions.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/014_bug_ledger.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/015_bug_deliveries.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/016_bug_delivery_scheduler.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/017_bug_expiry_job_guard.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/018_bug_integrity.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/019_bug_team_scope.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/020_bug_private_atomic.sql
psql -X --single-transaction -v ON_ERROR_STOP=1 -f migrations/021_bug_private_backfill.sql
```

번호 순서는 001부터 021까지 유지합니다. 이 설치 프로필은 초대 정책을 쓰지 않으므로 002~004를 건너뛰며, 006·007은 반드시 한 트랜잭션으로 적용합니다. 014 ledger → 015 delivery → 016 retry scheduler → 017 원자적 24시간 만료·job guard → 018 packet·lease·비공개 경계 무결성 → 019 팀별 만료·delivery claim 격리 → 020 비공개 전환·outbox 원자 커밋과 기존 행 reconciliation → 021 기존 private 행의 1회 scrub·outbox 보정 순서를 바꾸지 않습니다. 특히 016을 적용하기 전에는 delivery retry를 활성화하지 않습니다. 워크스페이스의 `primary_goal_channel_id`는 실제 공개 목표 채널로 명시적으로 연결하며 QA 채널을 추측해 넣지 않습니다.

기존 DB는 **백업 → 별도 복원 → 원본 충돌 대조 → 쓰기 정리 → 이관 → 전후 비교 → 실제 사용자 확인** 순서로 다룹니다. 알 수 없는 충돌을 덮어쓰거나 검사를 제거하지 않습니다. 복구는 이관 뒤 생긴 새 기록도 보존해야 합니다. 옛 rollback 파일이 현재 모든 후속 migration에 맞는다고 가정하지 않습니다.

## 검사 구분

| 범위 | 실행과 주의점 |
| --- | --- |
| 합성 회귀 | `bun run test:unit`. 공개 코드의 기본 검증 |
| PostgreSQL | 폐기 가능한 로컬 DB에 설치 후 `community-storage`, `community-scheduler`, `normalized-legacy`, `default-reminders`, `community-bug-storage`, `community-bug-delivery`, `community-bug-expiry-job-guard`, `bug-db-integrity-contract.sql`, `bug-team-scope-contract.sql`, `bug-private-atomic-contract.sql`, `community-bug-private-backfill` 검사 실행 |
| 실제 서비스 | 명시한 채널·회원·날짜만 검증. 전후 기록, 실제 게시, 실패 범위를 별도 보존 |

DB 검사의 `COMMUNITY_PG_SOCKET`, `COMMUNITY_PG_PORT`, `COMMUNITY_PG_DATABASE`를 확인합니다. 기본값이 검사마다 다를 수 있으므로 DB 이름을 명시합니다. `*-live*`, backfill, fixture 복원, migration 스크립트를 일반 테스트에 섞지 않습니다.

## 버그 제보 기반 검증과 후속 연결

`community-bugs`, `community-bug-dialogue`, `community-bug-due-store`, `community-bug-backlog`, `community-clock`은 합성 회귀 allowlist에 포함됩니다. mock Slack delivery의 failed → retry → sent, 응답이 사라진 DB 커밋 복구, 전역 시계의 정확한 due·activity 예약, 단계별 10건 배치의 5분 후속 실행, 빈 상태 한 시간 안전 검사와 일반 채널 스케줄 격리를 검증합니다. `qa/community-bug-storage.mjs`는 새 폐기 가능한 PostgreSQL 인스턴스에 migration 014–021을 적용하고 DB 무결성·팀 격리·비공개 원자 커밋·신규 설치 무변경 backfill을 확인합니다. `qa/community-bug-private-backfill.mjs`는 017 상태의 오염 fixture를 만든 뒤 018–021 upgrade가 opaque lineage와 event를 보존하면서 관계형 canary를 제거하고 outbox를 한 번만 보정하는지 검증합니다. `qa/community-bug-delivery.mjs`와 `qa/community-bug-expiry-job-guard.mjs`는 각각 delivery와 원자적 만료·job guard 경계를 확인합니다. 이 PostgreSQL 검사들은 일반 `check`에 넣지 않습니다. `qa/maintainer-dry-run.mjs`는 Git 작업본과 임시 디렉터리가 필요하며, 확정된 fixture로 provider-neutral 무변경 handoff만 검사합니다.

```sh
bun qa/community-bug-storage.mjs
bun qa/community-bug-delivery.mjs
bun qa/community-bug-expiry-job-guard.mjs
bun qa/community-bug-private-backfill.mjs
bun qa/community-bug-slack-validator.mjs
bun qa/maintainer-dry-run.mjs
node scripts/maintainer-dry-run.mjs --input qa/fixtures/bug-packets/confirmed-valid.v1.json --output "local-proof-$(uuidgen)"
```

`community-bug-slack-validator`는 인증 없이 Slack의 side-effect-free `blocks.validate`만 호출하는 명시적 네트워크 계약 검사입니다. 일반 단위 테스트 allowlist에는 넣지 않으며, 네트워크 장애를 제품 회귀로 오판하지 않습니다.

마지막 명령은 도구가 소유한 비공개 임시 경로의 새 직접 자식만 받아 `bug_packet.v1`의 digest, base SHA, dirty 상태를 영수증으로 남깁니다. `codex_cloud_github`, `genquant_codex_switch`, `slack_codex_app`은 handoff의 허용 제공자 이름일 뿐 호출 대상이 아닙니다. GitHub Actions workflow는 만들지 않습니다. 향후 검사는 격리된 GenQuant 서비스에서 수행하고 GitHub Check Run으로 게시해야 하며, 그 연결은 이 구현의 검증 범위 밖입니다.

## Git과 공개 코드

코드·직접 관련 테스트·명세를 함께 커밋하고 첫 줄에는 변경 목적을 씁니다. 필요한 `Constraint`, `Rejected`, `Tested`, `Not-tested` trailer로 결정과 검증 한계를 남깁니다. 제품 버전과 migration 번호는 별개입니다.

운영 이력이 있는 로컬 저장소는 공개 원격에 `--all`이나 `--mirror`로 push하지 않습니다. 공개 설정 예시·합성 테스트만 별도 작업본에 반영하고 staged 정보 검사와 `check`를 거쳐 push합니다. API 키·회원 원문·덤프·`.omx` 영수증은 제외합니다.

`export-public.mjs`가 있는 운영 저장소에서는 공개용 스냅샷을 생성할 수 있습니다. 기존 공개 Git 이력이 있는 경로를 덮어쓰지 않도록 보호되어 있습니다. migration 014–021, 버그 ledger·delivery·만료·무결성 QA fixture와 계약 SQL, 전역 시계 코드와 `automation/`의 공개 스키마·dry-run runner를 포함하지만 운영 식별자, 실제 제보 원문, `.omx`, credential은 포함하지 않습니다. 공개용 문서 원본은 이 문서 묶음이며, 내보내기 스크립트에 별도 사용법을 복제하지 않습니다.

```sh
node scripts/export-public.mjs /tmp/otl1-public-review
cd /tmp/otl1-public-review && bun run check
```

버그 질문 Block Kit을 Slack 계약과 직접 대조할 때는 `bun qa/community-bug-slack-validator.mjs`를 별도로 실행합니다. 이 검사는 인증·게시 없이 `blocks.validate`만 호출하며 외부 네트워크 검사이므로 일반 `check`에는 포함하지 않습니다.

스냅샷은 Git 이력이 없는 경로이므로 Git 작업본이 필요한 maintainer dry-run QA는 `check` allowlist에서 제외합니다. 공개 clone에서 그 QA를 실행할 때는 별도 Git 작업본을 만들고 임시 출력 경로를 사용합니다.

데이터 모델은 [시스템 구조](ARCHITECTURE.md), 서비스 사용법은 [사용 가이드](USER_GUIDE.md)를 따릅니다.
