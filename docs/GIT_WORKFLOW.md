# Git 작업 원칙

2026-09-11부터 현재 서비스 상태를 Git으로 기록한다. 첫 커밋은 이미 동작하는 서비스와 v0.0.30 정규화의 기준점이며 이전 변경을 가짜 과거 커밋으로 재구성하지 않는다.

- 기능 하나의 코드·명세·마이그레이션·직접 관련 테스트를 함께 커밋한다. 버전 목록에는 배포 여부와 검증 근거를 구분한다.
- 기능별 브랜치에서 작업하고 로컬 검사 및 해당 사용자 경로를 검증한 뒤 커밋한다.
- 커밋 첫 줄에는 변경 목적을 쓴다. Constraint, Rejected, Confidence, Scope-risk, Tested, Not-tested 등 Git trailer로 결정과 검증 한계를 기록한다.
- `.dev.vars`, `.env`, API 키, DB 접속 문자열, DB 덤프, `.omx` 실행 기록, 실제 회원 원문이 담긴 QA 결과는 추적하지 않는다. 공유 가능한 합성 테스트만 소스 fixture로 둔다.
- 운영 DB의 applied migration은 수정해 재사용하지 않고 다음 번호의 migration을 추가한다. schema migration 번호와 제품 버전은 서로 다른 식별자다.
- 커밋 전에 staged diff와 secret 검사를 확인한다. Git 커밋은 배포나 DB 이관의 성공을 대신하지 않는다.
- 원격 저장소와 push는 별도 설정한다. 현재 작업은 로컬 Git 기록이다.

운영 전 상태와 이관 근거는 [DATABASE_NORMALIZATION.md](DATABASE_NORMALIZATION.md)에 기록했다.

## 공개 저장소 게시

운영 기록이 포함된 기존 로컬 이력은 공개로 push하지 않는다. `node scripts/export-public.mjs`로 코드·합성 테스트·설정 예시·공개 설치 명세만 `/tmp/otl1-public`에 생성한다. 공개본은 별도 Git 첫 커밋으로 게시하며 원본 회원 자료와 운영 식별자를 포함하지 않는다. 공개용006은 기존 운영 예외를 담지 않는 신규 설치용 변형이다. 공개 DB에도 충돌 확인을 생략하지 않는다.

게시 전 공개 트리와 이력을 검사하고 frozen-lock 설치·lint·typecheck·build·신규 DB 설치 테스트를 통과해야 한다. 운영 브랜치의 `--all`, `--mirror`, 전체 태그 push는 사용하지 않는다. 공개 저장소의 devDependencies는 기존 필수 개발 도구 버전을 고정해 새 환경에서도 재현할 수 있게 한다.
