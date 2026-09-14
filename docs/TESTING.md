# 검증 실행

```sh
bun install --frozen-lockfile
bun run check
```

`check`는 lint, TypeScript, `test:unit`, Wrangler dry-run 순서로 실행하며 실패 시 중단한다. 실제 배포는 하지 않는다.

`test:unit`은 `scripts/test-unit.mjs`에 명시한 26개 스크립트를 각각 새 Bun 프로세스에서 실행한다. 모듈 mock과 임시 전역 변경이 다음 검사에 섞이지 않는다. 실패/부정 테스트가 일부 경고 로그를 출력하는 것은 정상이며 종료 코드로 통과 여부를 확인한다.

## 데이터베이스 검사

별도로 설치한 폐기 가능한 로컬 PostgreSQL에서 실행한다. DB 이름·소켓·포트를 테스트 스크립트에 맞게 지정한다. 운영 연결 문자열을 테스트용으로 사용하지 않는다.

- `community-storage.mjs`: 날짜별 저장·상태·후기·되돌리기·멱등성
- `community-scheduler.mjs`: 공통/개인 일정과 발송 조건
- `normalized-legacy.mjs`: 구형 저장 API와 단일 원본의 일치
- `default-reminders.mjs`: 기본 알림·중지·조용한 시간·가입일
- `edit-storage.sql`, `first-registration.sql`: 필드 보존과 최초 등록 판정

## 실제 서비스 검사

`*-live*`, `community-backfill.mjs`, `community-review-fixture.mjs`, `migrate-*`와 복구 스크립트는 일반 회귀에 포함하지 않는다. 명시된 대상·백업·권한을 확인한 뒤 별도로 실행한다. 실제 사용자 입력과 외부 게시 성공은 mock 통과로 대신하지 않는다.

API 키, DB 덤프, 실제 회원 원문, 운영 영수증은 Git에서 제외한다. 공개 문서에는 재현 가능한 합성 예제와 검증 범위를 남긴다.
