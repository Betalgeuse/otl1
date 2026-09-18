# Community checks

Run from the repository root with Bun and PostgreSQL 17 installed. No npm dependencies are required.

Storage/scheduler checks use a disposable local database, not Neon. Defaults are Unix socket `/tmp/otl-community-pg`, port `55439`, database `postgres`. Override only with `COMMUNITY_PG_SOCKET` / `COMMUNITY_PG_PORT` pointing at another disposable test database.

On macOS/Homebrew, initialize once if the data folder does not already exist:

```sh
mkdir -p /tmp/otl-community-pg
/opt/homebrew/opt/postgresql@17/bin/initdb -D /tmp/otl-community-pg/data -A trust
```

Start and apply schema, then run the checks:

```sh
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/otl-community-pg/data -o '-k /tmp/otl-community-pg -p 55439' -l /tmp/otl-community-pg/server.log start
psql -h /tmp/otl-community-pg -p 55439 -d postgres -v ON_ERROR_STOP=1 -f migrations/001_initial.sql -f migrations/005_community.sql
bun qa/community-storage.mjs
bun qa/community-scheduler.mjs
bun qa/community-social.mjs
bun qa/community-language-check.mjs
bun qa/community-language-variety.mjs
bun qa/community-clock.mjs
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/otl-community-pg/data stop
```

Tests use unique synthetic scopes. The actual Durable Object alarm and Slack user interaction evidence is documented in `docs/RELEASE_V001_V019.md`; unit checks do not substitute for it.

Live QA against the already-existing Worker requires explicit scenario authorization, an exact clean SHA and a receipt-bound pre-release QA deployment. It grants no Git push, merge, release, provider, or canonical deployment authority. A noncanonical rollout can prove only the named live scenario; canonical release still requires private `ops/main` and verified ruleset readback.

`community-live-*`, `community-review-fixture.mjs`, and `community-backfill.mjs` access real services using local credentials. They are deliberately not part of the automatic checks. The fixture script changes only the fixed private QA channel and requires guarded restoration. The backfill script changes public historical storage; do not run it as an ordinary test. Never point local database checks at the production database.

## Normalized schema (v0.0.30)

`006_normalized_foundation.sql` and `007_normalized_legacy.sql` MUST be applied together with `psql --single-transaction -v ON_ERROR_STOP=1`. Do not blindly run002–004, which enforce a different invitation/admission policy. Existing workspace primary public channels must be explicitly mapped in006; no inference from QA data is allowed.

`node qa/normalization-rehearsal.mjs` recreates **only the disposable local `otl_normalization` DB** from `.omx/qa/normalization/pre-migration-backup.json`. This requires an authorized local backup. It tests atomic abort for a blank canonical/legacy conflict and refuses duplicate migration. It never connects to Neon.

After rehearsal:

```sh
COMMUNITY_PG_DATABASE=otl_normalization bun qa/community-storage.mjs
COMMUNITY_PG_DATABASE=otl_normalization bun qa/community-scheduler.mjs
node qa/normalized-legacy.mjs
psql -h /tmp/otl-community-pg -p 55439 -d otl_normalization -v ON_ERROR_STOP=1 -f qa/normalization-invariants.sql
bun qa/migration-maintenance.mjs
```

Operational migration and recovery requirements are in `docs/DATABASE_NORMALIZATION.md`. The production migration runner requires maintenance503 and an explicit `--apply`; never invoke it as a normal test.

## 버그 제보 만료와 작업 권한

`bun qa/community-bug-expiry-job-guard.mjs`는 폐기 가능한 PostgreSQL에 기반 migration 001·005–007과 버그 migration 014–020을 의존 순서대로 적용합니다. 정확한 24시간 경계, 질문 다섯 번 제한, `FOR UPDATE SKIP LOCKED` 경쟁, 상태·이벤트·Slack outbox의 단일 트랜잭션, 재실행 중복 억제, 제보자 확인 전 job 0건을 확인합니다. migration 020의 private reconciliation도 reporter가 잠근 행을 건너뛴 뒤 잠금 해제 후 정확히 한 번 복구하고, 관계형 canary 제거·delivery 2건·event 1건·job 0건을 검증합니다. Neon이나 Slack에는 연결하지 않습니다.

## 버그 제보 DB 무결성과 팀 격리

`bun qa/community-bug-storage.mjs`는 migration 014–022를 순서대로 적용한 폐기 가능한 PostgreSQL에서 `bug-db-integrity-contract.sql`, `bug-team-scope-contract.sql`, `bug-private-atomic-contract.sql`을 실행합니다. packet·evidence digest 결합, job lease 소유권, obsolete delivery 취소, 팀별 만료·delivery claim 격리, 비공개 상태·관계형 원문 제거·receipt·관리자 handoff의 원자 커밋과 기존 중간 상태의 한 번뿐인 reconciliation과 신규 설치에서 021 backfill 0건을 확인합니다. `bun qa/community-bug-private-backfill.mjs`는 017 상태에 남은 private 관계형 canary fixture를 018–021로 올려 opaque lineage·event 보존, canary 제거, outbox 고유성, 재실행 0건을 확인합니다.

`bun qa/community-bug-private-delivery.mjs`는 migration 001–021을 적용한 폐기 가능한 PostgreSQL과 Slack fake를 연결해 원자적으로 생성된 private draft·answer outbox를 TypeScript가 동일한 template/renderer 계약으로 즉시 claim·sent(attempt 1)하는지, 정확한 replay가 중복 게시하지 않는지 확인합니다.

`bun qa/community-bug-resume-pg.mjs`는 migration 001·005–007과 014–022를 적용한 폐기 가능한 PostgreSQL, 메모리 R2, Slack fake를 연결합니다. 질문 1–3의 답과 packet revision 4는 저장됐지만 다음 질문 전이가 유실된 상태에서 재개 로직이 필수 actor·evidence 계약으로 질문 4를 정확히 한 번 만들고 전송하는지, `버그 제보 계속`과 재실행이 중복 전송·R2 변경·job 생성을 일으키지 않는지 확인합니다.

`bun qa/community-guide-pg.mjs`는 migration 009의 기존 안내·전달 이력이 있는 upgrade DB와 migration 001–028 신규 DB를 따로 구성합니다. migration 026이 기존 행을 historical/legacy 감사 이력으로 보존하고, 버전·본문·순서 있는 파일 ID·원본 metadata가 정확히 같은 발행만 멱등 처리하는지 확인합니다. 같은 회원의 같은 hash 중복·동시 claim은 막고 새 hash 수정본은 한 번 허용하며, finish가 정확한 version/hash에만 적용되는지도 검증합니다. `bun qa/community-guide-security-pg.mjs`와 `bun qa/community-guide-db-routing.mjs`는 migration 028의 runtime/admin 역할, 직접 테이블 차단, 함수 allowlist와 두 연결 문자열의 분리를 확인합니다. `bun qa/community-guide-bootstrap.mjs`는 생성한 자격증명이 stdout·stderr·프로세스 인자에 노출되지 않고 지정 sink의 stdin으로만 전달되는지 확인합니다. `bun qa/community-guide-cli.mjs`는 인자 없는 게시 명령과 대상 회원 repair 명령이 모두 dry run이고 본문·토큰·DB 주소·회원 ID·Slack timestamp를 출력하지 않는지 확인합니다.

`bun qa/community-reminder-audit.mjs`, `bun qa/community-schedule-overlap.mjs`, `bun qa/community-common-delivery.mjs`는 migration 027과 대응하는 101/201명 결정적 chunk, 같은 시각의 공통·개인 공개 글 분리, 429 재시도, 여러 history 페이지의 정확한 본문 대조를 확인합니다. `bun qa/membership-reminder-audit-pg.mjs`는 오래된 스냅샷 무시, 재입장 시 기록·시각·opt-out 보존, 이탈 회원 제외와 due 재검사를 폐기 가능한 PostgreSQL에서 검증합니다.

합성·PostgreSQL 검사는 실제 예약 실행이나 Slack 수신을 증명하지 않습니다. 2026-09-18 지정 회원 welcome 수정본은 Slack Web에서 확인했지만 자연스러운 신규 입장 이벤트는 아직 관찰하지 않았습니다. 2026-09-19 토요일과 2026-09-21 월요일의 자연 예약 실행도 관찰 뒤 별도 운영 영수증이 필요합니다.

## Slack 수락 뒤 응답 유실

영구 thread와 admin delivery는 history reconciliation으로 동일 payload를 찾아 중복을 억제합니다. history에서 조회할 수 없는 `reporter_ephemeral` receipt는 at-least-once이며, Slack 수락 뒤 응답 또는 DB finish가 유실되면 재시도에서 같은 비공개 receipt가 중복될 수 있습니다. `qa/community-bugs.mjs`는 Slack이 ephemeral을 수락한 뒤 응답을 잃는 경우를 합성해 첫 delivery가 retryable `failed/1`로 남고, 다음 eligible retry가 같은 비공개 receipt를 한 번 더 보낼 수 있으며 `sent/2`로 끝나는 at-least-once 경계를 고정합니다. 연속 실패는 outbox 행을 늘리지 않고 세 번에서 멈춥니다.

## 버그 backlog 유지

`bun qa/community-bug-backlog.mjs`는 private reconciliation, 만료, delivery claim 각각이 10건 batch를 채우면 `possiblyMore=true`가 되고, 다음 실행에서 모두 batch 미만으로 내려간 뒤에만 false가 되는지 확인합니다. `community-clock.mjs`는 이 신호가 있는 동안 다음 alarm이 5분 이내이고 backlog가 비면 한 시간 안전 검사로 돌아가는지 검증합니다.
