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

`bun qa/community-bug-expiry-job-guard.mjs`는 폐기 가능한 PostgreSQL에 migration 001·005–007·014–019를 의존 순서대로 적용합니다. 정확한 24시간 경계, 질문 다섯 번 제한, `FOR UPDATE SKIP LOCKED` 경쟁, 상태·이벤트·Slack outbox의 단일 트랜잭션, 재실행 중복 억제, 제보자 확인 전 job 0건을 확인합니다. Neon이나 Slack에는 연결하지 않습니다.

## 버그 제보 DB 무결성과 팀 격리

`bun qa/community-bug-storage.mjs`는 migration 014–020을 순서대로 적용한 폐기 가능한 PostgreSQL에서 `bug-db-integrity-contract.sql`, `bug-team-scope-contract.sql`, `bug-private-atomic-contract.sql`을 실행합니다. packet·evidence digest 결합, job lease 소유권, obsolete delivery 취소, 팀별 만료·delivery claim 격리, 비공개 상태·관계형 원문 제거·receipt·관리자 handoff의 원자 커밋과 기존 중간 상태의 한 번뿐인 reconciliation을 확인합니다.
