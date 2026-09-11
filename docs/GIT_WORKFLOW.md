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
