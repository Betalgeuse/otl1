# 환영 안내 DB 권한 운영

환영 안내는 일반 `DATABASE_URL`을 사용하지 않는다. migration 028은 비로그인 권한 묶음인
`otl_guide_runtime`과 `otl_guide_admin`을 만들고, 모든 가이드 함수의 `PUBLIC` 실행 권한을
회수한다.

- Worker의 `GUIDE_DATABASE_URL` 로그인은 `otl_guide_runtime`만 상속한다. 발행된 최신 안내
  조회, 신규 가입 전달 claim, 해당 전달 finish만 실행할 수 있다.
- 발행 CLI의 `GUIDE_ADMIN_DATABASE_URL` 로그인은 `otl_guide_admin`만 상속한다. 검증된 안내
  발행과 명시적인 대상 복구만 실행할 수 있다.
- 두 로그인 모두 테이블을 직접 읽거나 수정할 수 없다. 관리자 로그인은 일반 커뮤니티
  데이터 함수도 실행할 수 없다.
- DB 소유자 연결은 migration과 이 부트스트랩에만 사용한다. Worker나 발행 CLI에 넣지 않는다.

`scripts/bootstrap-guide-db-roles.mjs`는 두 로그인 비밀번호를 실행할 때마다 프로세스 안에서
무작위로 생성하고 DB에 갱신한다. 연결 문자열은 stdout, stderr, 명령 인자에 출력하지 않고
각 비밀 저장소 명령의 stdin으로만 전달한다. 다음 환경 변수가 필요하다.

```text
DATABASE_URL=<DB owner connection; environment only>
SLACK_TEAM_ID=<workspace ID>
COMMUNITY_WELCOME_CHANNEL_ID=<welcome channel ID>
COMMUNITY_ADMIN_ID=<verified publisher ID>
GUIDE_RUNTIME_SECRET_SINK=<stdin을 받는 실행 파일>
GUIDE_RUNTIME_SECRET_SINK_ARGS=<JSON string array>
GUIDE_ADMIN_SECRET_SINK=<stdin을 받는 실행 파일>
GUIDE_ADMIN_SECRET_SINK_ARGS=<JSON string array>
```

런타임 sink는 `wrangler secret put GUIDE_DATABASE_URL`처럼 Worker 비밀을 설정한다. 관리자
sink는 로컬 비밀 관리자에 저장해야 하며 Worker에는 `GUIDE_ADMIN_DATABASE_URL`을 설정하지
않는다. 저장 명령은 stdin을 받아야 하고 자체적으로 값을 로그에 남기지 않아야 한다.

migration 039부터 안내 원문은 `src/community-guide-release.ts`의 검토된 버전별 본문·이미지 순서로 관리한다. 사람의 Slack 글·편집 시각을 발행 입력으로 쓰지 않는다. 버전을 올리고 코드를 검토한 뒤 발행 CLI의 dry-run을 확인하고 명시적인 `--apply`로 DB에 고정한다. CLI는 등록된 관리자 ID와 본문 버전·채널 알림 정책을 확인하며, DB도 repo origin·등록된 발행자·서로 다른 두 이미지와 canonical SHA-256을 검증한다. 과거 Slack 원문 출처와 전달 이력은 그대로 보존한다.

Slack의 `users:read.email` 범위는 현재 초대 수신자와 Slack 계정 이메일을 결합하는
`personEmail` 경로가 실제로 사용하므로 유지한다. 해당 초대 경로가 제거될 때 manifest와
회귀 테스트에서 함께 제거한다.

레포 원문만 편집하는 것만으로는 현재 안내가 바뀌지 않는다. 관리자 자격증명으로 명시적
발행을 마치고 `latest` readback에서 새 `published` 버전을 확인해야 이후 가입 전달이 바뀐다.
2026-09-18 v0.0.55 지정 회원 대상 복구는 Slack Web에서 OT1L 봇 작성자·본문·이미지 순서를
확인했다. 배포 뒤 자연스러운 신규 회원 입장 이벤트부터 최종 게시까지는 아직 관찰하지 않았다.
