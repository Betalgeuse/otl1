# 운영 가이드

회원의 입력 방법은 [사용 가이드](USER_GUIDE.md), 정책을 바꾸는 판단 기준은 [제품 원칙](PRODUCT_PRINCIPLES.md)을 따릅니다.

## 채널 역할

| 채널 | 역할 |
| --- | --- |
| daily-scrum | ONE THING과 후기의 공개 기록 |
| townhall | 환영, 첫 등록·첫 완료·첫 후기의 봇 축하, 관리자가 게시한 업데이트 |
| welcome-start-here | 신규 회원 멘션과 최신 안내글 전문 |
| all-self-introduction | 신규 회원 멘션, 180자 자기소개·선택적 LinkedIn·기타 공개 정보 게시와 수정, 비공개 전체 보기, 운영자 미작성자 안내 |
| feedback | 회원 버그 제보와 봇의 한 번에 하나씩 묻는 확인 질문. 일반 대화에는 반응하지 않음 |
| 비공개 admin | 관리자 조회·설정·게시 미리보기 및 QA |
| shareinfo·Chapter | 정보와 관심사별 대화. 봇의 자동 사람 연결은 아직 계획 |
| 기존 Silo 채널 | 자동 배정·경쟁 없이 보관 상태. 실제 폐쇄는 별도 운영 결정 |

## 안내와 재촉

모든 시각은 한국 시간입니다.

| 안내 | 평일 | 주말 |
| --- | --- | --- |
| 공통 목표 | 10시, 현재 daily-scrum 사람 회원을 한 글에서 멘션 | 오전 한 번, 멘션 없음 |
| 공통 후기 | 18시, 현재 daily-scrum 사람 회원을 한 글에서 멘션 | 보내지 않음 |
| 개인 목표 미등록 | 기본 11시, 종류별 하루 한 번 | 보내지 않음 |
| 개인 후기 미제출 | 기본 20시, 종류별 하루 한 번 | 보내지 않음 |

개인 목표·후기 안내는 같은 수집 시각의 대상자를 채널당 한 메시지의 두 구역으로 묶습니다. 탈퇴·채널 이탈·삭제·봇 계정은 완전한 Slack 회원 스냅샷에서 제외하며, 저장된 과거 설정만으로 멘션하지 않습니다. 개인 안내는 신규 설정의 기본값이 켜짐입니다. 본인이 시각을 변경하거나 끌 수 있고, 재입장이나 기본값 변경으로 다시 켜지지 않습니다. 신규 설정은 다음 날부터 대상이 되며 주말을 건너뜁니다. 오후 후기 안내는 목표가 있는 회원만 대상으로 합니다. 완료 표시와 후기 제출은 별개입니다.

휴식·해당 행동 완료·중지 시 관련 개인 안내를 멈춥니다. 22시~08시에는 발송하지 않습니다. 이전 날짜 안내는 잔디 조회 시 제공하며, 미참여 주말을 밀린 기록으로 재촉하지 않습니다. 특정 날짜의 수동 재촉은 정기 규칙과 별개인 명시적 운영 조치로 기록합니다.

게시 성공은 기기 푸시 수신과 다릅니다. 알림 장애는 **예약 → 발송 이력 → 실제 Slack 게시 → 사용자 알림 설정** 순서로 확인합니다. 회원 목록의 일부 페이지나 프로필 수집에 실패하면 해당 실행에서는 누구도 멘션하지 않고 기존 회원 상태도 비활성화하지 않습니다. 데이터가 없거나 수집에 실패했다고 회원을 미참여로 단정하지 않습니다.

## 환영과 첫 기록 축하

- townhall 입장 환영에는 회원 멘션과 `@channel`을 포함합니다. 같은 회원의 중복 입장 이벤트는 재발송하지 않습니다.
- 첫 등록·첫 완료·첫 후기는 별개로 기록하고, 봇이 townhall의 새 최상위 글로 직접 축하합니다. 회원 간 샤라웃과 구분합니다.
- 원래 변경을 되돌리면 연결된 축하도 정정합니다. 새 ‘첫 기록’ 권한을 반복해서 발급하지 않습니다.
- welcome 채널에 입장하면 해당 회원을 태그한 새 글로 안내 전문을 전달합니다. townhall 입장 순서와 무관하게 동작합니다.

관리자는 설정에 지정된 **원본 Slack 안내글**을 편집합니다. 다음 신규 회원부터 수정된 본문을 읽고, 이전 전달본은 DB 버전으로 보존합니다. 현재는 별도 초안·발행 모달이 없습니다. 원본의 정책을 봇이 요약하거나 임의로 바꾸지 않으며, 복사본의 전체 알림 토큰은 일반 텍스트로 처리합니다.

봇의 장식·응원 이모지는 실제 워크스페이스 커스텀 목록에서 무작위로 고르며 한 번의 반응 안에서는 중복을 피합니다. 실제 사용한 리액션을 기록해 되돌리기를 맞추고, 회원 원문의 이모지는 치환하지 않습니다. 목록 조회가 불가능하면 기존 기본 표현으로 대체합니다.

## 관리자 작업

지정된 관리자 계정이 비공개 admin 채널에서 실행합니다.

| 입력 | 결과 |
| --- | --- |
| `회원 현황` | daily-scrum의 당일 목표·상태·후기·휴식 조회 |
| `업데이트 관리` | 버전 선택 → 대상·내용 미리보기 → 명시적 게시 |
| `피드백 보기` | 게시된 업데이트 스레드에 연결된 의견 조회 |
| `공통 안내 설정` | 현재 관리 채널 설정, 공개 채널 적용, 관리자 전용 `데일리스크럼 수집 테스트` 버튼 |

문서나 로드맵 수정만으로 업데이트를 게시하지 않습니다. 개인 완료·색상·알림 조작은 당사자에게만 보이며, 서버에서도 소유자를 검사합니다. 관리자라는 이유로 공개 채널에서 관리 정보를 출력하지 않습니다.

`데일리스크럼 수집 테스트`는 비공개 관리 채널에서 관리자에게만 보입니다. 저장된 공개 채널 공통 안내 시각을 그대로 사용해 목표·후기 수집 경로를 각각 한 번 실행하며 설정을 바꾸지 않습니다. 결과는 대상 인원과 생성된 일괄 메시지 수만 관리자에게 비공개로 보여줍니다. 버튼은 발급 당일의 원래 관리 메시지와 소유자에 묶이며 같은 요청을 다시 눌러도 공개 수집 메시지를 반복하지 않습니다.


## 잔디 게시 복구

Migration 024는 날짜 변경과 잔디 게시 요청을 한 트랜잭션에 기록하고, Migration 025는 이를 회원·날짜·스레드별 projection route로 한정합니다. `community_garden_deliveries`에서 `pending`·`claimed`·`failed` 행을 확인하며, 시도는 세 번을 넘지 않습니다. `failed` 행의 `retry_after`, `error_code`, `attempts`로 다음 재시도를 판단합니다. Slack 게시가 수락됐지만 DB 완료 응답을 잃은 경우에는 같은 스레드의 안정적인 block marker를 대조하고 기존 메시지를 영수증으로 채택합니다. 새 delivery가 `sent`가 되기 전에는 이전 잔디 이미지를 제거하지 않습니다.


과거 누락 route는 먼저 dry run으로 확인합니다. 결과에는 원문이나 회원 ID 대신 route 수, fallback 수, 미복원 일수, profile 시작일 보정 수와 plan digest만 나옵니다.

```bash
npm run reconcile:garden -- --team T_REPLACE --channel C_REPLACE --through 2026-09-18 --from 2026-09-08 --limit 100 --dry-run
npm run reconcile:garden -- --team T_REPLACE --channel C_REPLACE --through 2026-09-18 --from 2026-09-08 --limit 100 --apply garden-reconcile-20260918
```

실행은 `otl.community_execute('reconcile_garden_projections', ...)`만 호출합니다. 같은 reconciliation key 재실행은 route와 delivery를 추가하지 않습니다. 빈 revision 0 행은 제외하고, 실제 목표·후기·상태가 있는 revision 0 baseline만 projection 대상으로 허용합니다.

## 버그 제보 v0.0.54 구현 기준

비정규 pre-release QA 배포 계보는 exact source, maintenance로 보호한 migration, Worker 활성화와 설정 보존을 영수증으로 남겼고, exact SHA `4f05ae75f93ad5f7bca6ebfcb7c3613fbe8dae20`에서 Chrome Slack Web 시나리오까지 통과했습니다. 다만 private `ops/main`·ruleset readback·canonical provenance와 정식 release authority가 없으므로 정식 배포나 출시로 취급하지 않습니다. 이것이 v0.0.54가 pre-release로 남는 유일한 이유이며 현재 운영 출시 기준은 v0.0.53입니다.

출시 뒤 feedback 채널의 `버그제보`, `버그 제보`, `버그제보: ...`, `버그 제보: ...`, `버그: ...`, `문제: ...`, `오류: ...` 입력은 제보자 소유 초안을 시작합니다. `COMMUNITY_CHANNEL_ID`로 설정한 비공개 관리·시험 채널에서는 멘션 없이도 `댓글이 안 보여요`, `등록했는데 아무것도 안 떠요`, `봇이 작동하지 않아요`처럼 명시적인 제품·동작 대상과 실패 증상이 함께 있는 자연어를 접수합니다. 접두어 없는 문장에 완료·부분 완료·미완료·휴식·후기·회고·목표 선택·기록 수정 문법이 하나라도 있으면 버그보다 ONE THING 흐름을 우선합니다. 혼합 문장을 버그로 명시할 때는 `버그:`·`문제:`·`오류:`를 사용합니다. 구두점뿐인 입력, 짧은 `안 돼요`, 일반 질문과 감정 표현도 접수하지 않습니다. 공개·업데이트 채널에서는 새 자연어 판정을 끄고 기존 명시 형식만 허용합니다.

이벤트 수신 직후 만드는 `community_records`의 incoming body에는 버그 원문을 넣지 않습니다. 고정된 `bug_intake` 표식, SHA-256 digest, 날짜·스레드·편집 시각만 저장하고, 정확한 제보 문장은 AES-GCM 비공개 객체에 먼저 보관합니다. 소유자 범위 read API가 반환하는 wrapped key와 revision metadata로만 다음 역질문을 이어갑니다.

누락되거나 모순된 내용은 한 번에 하나씩만 묻고, 관찰하지 않은 내용은 추가하지 않습니다. 24시간 안에 다섯 질문을 넘기거나 시간이 지나면 확정하지 않고 비공개 운영자 인계 대상으로 전환합니다.

제보자는 초안을 확인해 `맞아요`를 눌러야 합니다. 이 확인 전에는 관리자나 자동화가 확정 패킷을 만들 수 없습니다. 보안·개인정보 징후는 공개 답글을 계속 받지 않고 `private_incident`로 분리합니다. 새 초안·답변의 비공개 전환, 관계형 원문 제거, receipt·관리자 handoff 생성은 한 DB 트랜잭션으로 커밋하며 기존 중간 상태는 팀 범위 reconciliation이 한 번만 보정합니다. 운영자는 실제 식별자, 원문, 비밀, 첨부물 또는 private object 경로를 공개 채널·공개 export·Check Run 본문에 넣지 않습니다.

정규화 ledger와 `bug_jobs` outbox는 후속 재현·수정·검토·배포 작업을 기록할 수 있지만, 현재는 제공자 실행을 승인하지 않습니다. 별도의 delivery outbox는 질문·요약·접수 영수증·비공개 관리자 인계를 Slack 효과보다 먼저 기록합니다. lease를 가진 worker만 발송을 마칠 수 있고, 실패는 오류와 다음 시각을 남겨 재시도하며 세 번째 실패는 retry 없이 dead-letter `failed`로 보관합니다. 공개 채널에는 비공개 인계 원문·객체 경로를 쓰지 않습니다.

`reporter_thread`와 `admin_channel`처럼 다시 읽을 수 있는 영구 메시지는 Slack이 수락한 뒤 응답이나 DB 완료 기록을 잃어도 제한된 history에서 동일 payload를 대조해 중복 게시를 막습니다. `reporter_ephemeral`은 Slack history로 다시 읽을 수 없으므로 **at-least-once**입니다. Slack 수락 뒤 응답 또는 DB finish를 잃으면 비공개 receipt가 재시도 때 중복될 수 있습니다. 이 제한은 당사자에게만 보이는 receipt를 누락시키지 않기 위한 명시적으로 수용한 tradeoff이며, exactly-once로 표현하지 않습니다.

버그 delivery는 팀마다 하나인 전역 `CommunityClock` 인스턴스가 활동과 정확한 재시도·24시간 만료 시각에 실행됩니다. private reconciliation, 만료, delivery claim 중 하나라도 한 번에 10건의 전체 batch를 채우면 `possiblyMore`로 기록하고 5분 뒤 다시 실행하며, 모든 단계가 batch보다 적어질 때까지 한 시간 idle 검사로 늦추지 않습니다. 활동·실패·미처리 backlog가 계속되는 상한 모양은 5분 간격, 하루 288번 alarm이고, 완전히 비면 한 시간 안전 검사만 남도록 설계했습니다. 이 수치는 호출 모양의 상한일 뿐 실제 Neon 사용량이나 무료 범위를 증명하지 않습니다. 운영 비용은 실제 alarm invocation과 DB query 지표로 따로 측정합니다. 각 실행은 다음 alarm을 먼저 저장한 뒤 만료와 전달 재시도만 제한된 배치로 처리합니다. `*/5` Cron은 사라진 alarm을 다시 거는 backup/nudge이며 delivery SQL을 실행하지 않습니다. 전역 Durable Object alarm이 주 실행 경로입니다. GitHub Actions는 사용하지 않습니다.

비공개 reconciliation, 24시간 만료, delivery claim 중 어느 단계든 한 번에 10건을 처리하면 남은 작업이 있을 수 있다고 보고 5분 안에 다시 실행합니다. 다음 실행에서 세 단계가 모두 10건 미만이어야 한 시간 안전 검사로 돌아갑니다.

일반 배포와 DB 유지보수에서는 `wrangler.jsonc`의 Cron 선언을 그대로 둡니다. `DATABASE_MAINTENANCE=true`이면 전역 시계는 alarm을 다시 걸고 DB·Slack 작업을 건너뜁니다. `/health`는 Worker liveness, 필수 설정 여부와 정적 capability만 반환하는 엄격한 read-only 경로입니다. Durable Object stub 조회, alarm 설정, DB·R2·Slack 호출을 하지 않으므로 clock readiness 근거로 사용하지 않습니다. 유지보수 해제와 배포 뒤 clock readiness는 식별자를 제거한 Durable Object inspect/admin 영수증, 배포 영수증의 alarm 상태 또는 서명 검증을 통과한 Slack activity가 alarm을 건 기록으로 확인합니다. 운영자 진단은 이 readiness 근거, `community.bug.clock.failed`·`community.cron` 로그, scheduled invocation, `bug_deliveries.attempts`와 상태 순서로 진행하며 회원 식별자나 본문을 로그에 복사하지 않습니다.

Cron 등록이 실제로 stale이라는 Cloudflare 설정·호출 증거가 있을 때만 복구 예외를 적용합니다. 정확히 한 개의 기존 schedule을 삭제하고 같은 표현식으로 한 개만 다시 만든 뒤, 마지막 변경부터 최소 15분을 기다립니다. 설정 readback만으로 복구 성공이라 하지 않으며 이후 실제 scheduled invocation과 그 invocation이 alarm을 재무장한 사실, due delivery의 `attempts` 또는 상태 진전을 함께 확인해야 합니다. 그 증거가 없으면 schedule을 반복해서 지우거나 만들지 않습니다.

Slack delivery 실패 로그의 `providerSubcode`는 `invalid_blocks`, `invalid_arguments`, `invalid_form_data`, `msg_too_long`, `http_429`, `provider_5xx`, `other` 중 하나만 남깁니다. 원문 응답, 메타데이터 메시지, 사용자 입력은 로그나 delivery ledger에 저장하지 않습니다.

`codex_cloud_github`, `genquant_codex_switch`, `slack_codex_app` 이름을 담은 dry-run도 무변경 계획 영수증만 만듭니다. GitHub Actions는 사용하지 않습니다. 실제 운영 체크는 격리된 GenQuant 서비스에서 실행하고 GitHub Check Run으로 게시하도록 별도 승인·연결·실제 검증을 거쳐야 합니다.

pre-release QA 배포는 기존 Worker의 승인된 검증 시나리오에만 쓰며 exact clean SHA와 rollback 대상을 기록합니다. Git push·merge·release·provider 권한은 포함하지 않습니다. 정식 배포는 private `ops/main`과 활성 ruleset readback이 준비된 뒤 별도 실행합니다.

## 장애와 알려진 경계

DB에 저장됐는지, Slack에 게시됐는지, 회원이 확인했는지를 따로 봅니다. 발송 실패나 응답이 불확실한 상태에서는 실제 채널과 발송 기록을 대조한 뒤 복구합니다. 무조건 다시 보내지 않습니다.

신규 입장·회원 정보는 Slack 이벤트와 확인된 디렉터리 값을 사용합니다. 지속적인 소속·퇴장 동기화, 모든 과거 카드의 자동 정리, 자동 백업 SLO, 관리자 재전송 UI는 아직 완성된 기능이 아닙니다. 다음 작업은 [로드맵](ROADMAP.md)에서 관리합니다.
