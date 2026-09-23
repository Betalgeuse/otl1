# 운영 가이드

운영 동작의 불변조건과 잔디·스레드 결과는 [실행 명세](SPEC.md)를 기준으로 합니다. 이 문서는 예약·복구·권한·배포 절차만 다룹니다.

회원의 입력 방법은 [사용 가이드](USER_GUIDE.md), 정책을 바꾸는 판단 기준은 [제품 원칙](PRODUCT_PRINCIPLES.md)을 따릅니다.

## 채널 역할

| 채널 | 역할 |
| --- | --- |
| daily-scrum | ONE THING과 후기의 공개 기록. 상단 북마크·핀과 봇 안내 버튼에서 사용설명서, 자기소개, 초대에 바로 접근 |
| townhall | 환영, 첫 등록·첫 완료·첫 후기의 봇 축하, 관리자가 게시한 업데이트 |
| welcome-start-here | 상단 Canvas 사용설명서, 핀으로 고정한 설명서 진입점, 신규 회원용 짧은 안내 |
| all-self-introduction | 신규 회원 멘션, 180자 자기소개·선택적 LinkedIn·기타 공개 정보 게시와 수정, 상단 Canvas 전체 보기, 운영자 미작성자 안내 |
| feedback | 회원 버그 제보와 봇의 한 번에 하나씩 묻는 확인 질문. 일반 대화에는 반응하지 않음 |
| 비공개 admin | 관리자 조회·설정·게시 미리보기 및 QA |
| shareinfo·Chapter | 정보와 관심사별 대화. 최상위 정보 글에는 봇 리액션·감사·한 줄 요약·생각거리를 자동 게시 |

## 안내와 재촉

모든 시각은 한국 시간입니다.

ONE THING의 날짜 경계는 오전 2시입니다. 00:00~01:59의 회원 입력과 버튼·모달 제출은 전날 서비스 날짜로 귀속하고, 02:00부터 새 날짜로 처리합니다. 정기 10시·18시 안내 시각은 그대로입니다.

| 안내 | 평일 | 선택 참여일 |
| --- | --- | --- |
| 공통 목표 | 10시, 실행 시점의 daily-scrum 사람 회원을 한 글에서 멘션 | 토·일요일과 대한민국 공휴일 10시에 선택 참여 글 한 번, 멘션 없음 |
| 공통 후기 | 18시, 실행 시점의 daily-scrum 사람 회원을 한 글에서 멘션 | 보내지 않음 |
| 개인 목표 미등록 | 기본 11시, 저장된 개인 시각이 되면 종류별 하루 한 번 | 보내지 않음 |
| 개인 후기 미제출 | 기본 20시, 저장된 개인 시각이 되면 종류별 하루 한 번 | 보내지 않음 |

여기서 **공통 안내**는 실행 시점의 현재 사람 회원 전체를 대상으로 하는 공개 채널 글입니다. **개인 안내**는 개인별 저장 시각·켜짐 여부·당일 기록에 따라 due인 회원만 고르지만, 전송 화면은 DM이 아니라 대상자들을 함께 멘션한 공개 채널 일괄 글입니다. 한 사람당 메시지를 따로 보내지 않습니다. 같은 수집 시각의 목표·후기 대상자는 채널당 한 메시지의 두 구역으로 묶고, 100명을 넘거나 Slack 본문 한도를 넘으면 결정적인 순서로 나눈 여러 일괄 글을 사용합니다.

평일 공통 10시·18시와 due 개인 안내를 처리하기 전에 `conversations.members` 전 페이지와 각 사람 프로필을 끝까지 읽은 완전한 스냅샷만 반영합니다. 더 늦게 관찰한 스냅샷보다 오래된 결과는 무시합니다. 재입장한 회원은 새 관찰 시각으로 현재 상태만 복구하며 기존 기록·개인 시각·명시적 수신 중지는 보존합니다. 탈퇴·채널 이탈·삭제·봇 계정은 제외하고, 저장된 과거 설정만으로 멘션하지 않습니다. 일부 페이지나 프로필 수집이 실패하면 이번 실행의 멘션과 회원 상태 변경을 모두 중단합니다.

개인 안내는 신규 설정의 기본값이 켜짐입니다. 본인이 시각을 변경하거나 끌 수 있고, 재입장이나 기본값 변경으로 다시 켜지지 않습니다. 신규 설정은 다음 날부터 대상이 되며 토·일요일과 대한민국 공휴일을 건너뜁니다. 오후 후기 안내는 목표가 있는 회원만 대상으로 합니다. 완료 표시와 후기 제출은 별개입니다. 발송 행은 lease로 claim하며 최대 세 번 시도합니다. 재시도 전에는 같은 채널에서 정확히 같은 본문을 찾아 이미 수락된 글이면 그 시각을 영수증으로 채택하고, 아직 due인 회원만 다시 남겨 전송합니다.

휴식·해당 행동 완료·중지 시 관련 개인 안내를 멈춥니다. 22시~08시에는 발송하지 않습니다. 이전 날짜 안내는 잔디 조회 시 제공하며, 미참여 주말·공휴일을 밀린 기록으로 재촉하지 않습니다. 목표를 남긴 선택 참여일만 잔디에 표시합니다. 특정 날짜의 수동 재촉은 정기 규칙과 별개인 명시적 운영 조치로 기록합니다.

이전 기록 안내는 최근 미정리 날짜를 최대 3개까지 날짜별 버튼으로 표시합니다. 버튼은 회원·날짜·revision에 묶이고, 모달 제출 직전에 현재 revision과 미정리 상태를 다시 확인합니다. 모달의 완료 상태와 후기 원문은 기존 `change` 저장·잔디 delivery 경로를 한 번 호출하며 별도 보정 테이블을 만들지 않습니다.

대한민국 공휴일은 한국천문연구원 월력요항과 시행 중인 「관공서의 공휴일에 관한 규정」을 기준으로 2026·2027 날짜를 `src/calendar.ts`에 고정합니다. 외부 달력 API 장애가 정기 운영을 바꾸지 않게 하기 위한 결정입니다. 운영자는 매년 12월 전에 다음 해 공식 월력요항과 수시 지정 공휴일을 대조해 목록과 `qa/weekends.mjs`를 함께 갱신합니다.

게시 성공은 기기 푸시 수신과 다릅니다. 알림 장애는 **예약 → 발송 이력 → 실제 Slack 게시 → 사용자 알림 설정** 순서로 확인합니다. 회원 목록의 일부 페이지나 프로필 수집에 실패하면 해당 실행에서는 누구도 멘션하지 않고 기존 회원 상태도 비활성화하지 않습니다. 데이터가 없거나 수집에 실패했다고 회원을 미참여로 단정하지 않습니다.

## 환영과 첫 기록 축하

- townhall 입장 환영에는 회원 멘션과 `@channel`을 포함합니다. 같은 회원의 중복 입장 이벤트는 재발송하지 않습니다.
- 첫 등록·첫 완료·첫 후기는 별개로 기록하고, 봇이 townhall의 새 최상위 글로 직접 축하합니다. 회원 간 샤라웃과 구분합니다.
- 원래 변경을 되돌리면 연결된 축하도 정정합니다. 새 ‘첫 기록’ 권한을 반복해서 발급하지 않습니다.
- welcome 채널에 입장하면 해당 회원을 태그한 짧은 글과 `사용설명서 보기` 버튼을 한 번 전달합니다. 안내 전문은 반복 게시하지 않습니다. 상단 Canvas가 설명서의 단일 읽기 화면이며 같은 진입 메시지를 핀으로 유지합니다. townhall 입장 순서와 무관하게 동작합니다.

관리자는 `src/community-guide-release.ts`에서 새 버전의 안내 본문을 검토합니다. `bun scripts/publish-welcome-guide.mjs` dry-run에서 버전과 canonical hash를 확인하고, migration 039 적용 뒤 별도 `GUIDE_ADMIN_DATABASE_URL` 자격증명으로 `--apply`를 실행합니다. DB는 등록된 관리자, repo 출처, 해시, 버전 증가와 동일 버전 불변성을 다시 확인합니다. 적용 시 같은 채널 Canvas 본문과 같은 핀 메시지를 갱신합니다. Canvas 안의 채널 표기는 메시지용 `<#ID>`가 아니라 Canvas 전용 `![](#ID)`로 변환해야 합니다. 신규 회원에게는 Canvas 링크와 친구 초대 버튼만 보내며 과거 발행 원문과 전달 DB 행은 지우지 않습니다.

현재 초대 문구는 `매일 제일 중요한 일 하나 정해서 같이 끝내는 모임이야. 같이 할래?`입니다. 신규 회원별 복사본에서는 `@channel`을 일반 텍스트로 바꿔 전체 알림을 다시 발생시키지 않습니다. Slack이 게시 요청을 수락했지만 응답을 잃은 경우 자동 재게시하지 않고 운영 대조 대상으로 남깁니다.

특정 회원에게 안내 링크를 다시 전달할 때는 `publish-welcome-guide.mjs --replace-user U...`로 먼저 dry run을 확인한 뒤 `--apply`를 붙입니다. 가입 안내와 수정본은 모두 `SLACK_BOT_TOKEN`으로 `chat.postMessage`를 호출하고, Slack 응답의 작성자가 설정된 OT1L 봇인지 확인한 뒤 그 메시지 시각을 저장합니다. 관리자나 회원 프로필로 대신 게시하지 않습니다. 스크립트는 기존 Slack 메시지를 자동 삭제하지 않으며, 이전 전달 행도 감사 이력으로 보존합니다.

## Share Info·Chapter 자동 반응과 복구

Slack Events API가 전달한 최상위 사람 메시지는 먼저 `share-info:<message_ts>` 영수증을 DB에 만들고 claim한 뒤 리액션, 감사 답글, Qwen 한 줄 요약과 생각거리를 같은 스레드에 게시합니다. Qwen이 실패하면 원문 기반 대체 문구로 끝까지 게시합니다. 같은 영수증은 중복 효과를 만들지 않습니다.

이벤트 누락에 대비해 Cron이 15분마다 최근 20분의 Share Info·Chapter 최상위 글을 다시 읽어 같은 처리기를 호출합니다. `conversations.history` 응답의 메시지에는 `channel`이 없으므로 재수집기가 현재 순회 중인 채널 ID를 이벤트에 명시적으로 붙인 뒤 처리해야 합니다. 합성 QA도 실제 Slack 응답처럼 메시지의 `channel` 필드를 생략합니다. 운영 확인 순서는 `community.share_info.reconcile`의 처리 수, `community_records`의 `share-info:<message_ts>` 상태, 원글 리액션, 감사 답글, 요약·생각거리 답글입니다.

2026-09-18 기준 v0.0.55 수정본의 **지정 회원 대상 복구**는 Slack Web에서 봇 작성자·본문·이미지 순서까지 확인했습니다. 배포 뒤 실제 신규 회원의 자연스러운 채널 입장 이벤트부터 최종 게시까지는 아직 관찰하지 않았으므로, 다음 입장에서 정확히 한 건의 봇 게시를 별도 확인해야 합니다.

봇의 장식·응원 이모지는 실제 워크스페이스 커스텀 목록에서 무작위로 고르며 한 번의 반응 안에서는 중복을 피합니다. 실제 사용한 리액션을 기록해 되돌리기를 맞추고, 회원 원문의 이모지는 치환하지 않습니다. 목록 조회가 불가능하면 기존 기본 표현으로 대체합니다.

자기소개 전체 목록은 `all-self-introduction`의 Canvas가 단일 읽기 화면입니다. 자기소개 등록·수정이 확정되면 현재 공개 introduction revision 전체로 Canvas를 교체합니다. `자기소개 모두 보기`를 누를 때도 같은 동기화를 먼저 실행하므로 일시적 갱신 실패를 다음 조회에서 복구합니다. daily-scrum 상단에는 사용설명서·자기소개 모음·홈페이지 북마크와 사용설명서·자기소개·밀린 후기 기록하기·친구 초대의 다섯 가지 핵심 동작을 담은 핀 메시지를 유지합니다.

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

비정규 pre-release QA 배포 계보는 exact source, maintenance로 보호한 migration, Worker 활성화와 설정 보존을 영수증으로 남겼고, exact SHA `4f05ae75f93ad5f7bca6ebfcb7c3613fbe8dae20`에서 Chrome Slack Web 시나리오까지 통과했습니다. 다만 private `ops/main`·ruleset readback·canonical provenance와 정식 release authority가 없으므로 정식 배포나 출시로 취급하지 않습니다. 이것이 v0.0.54 버그 제보 기반이 pre-release로 남는 이유이며, 운영 기능 기준 v0.0.55 welcome 발행과는 별도 계보입니다.

출시 뒤 feedback 채널의 `버그제보`, `버그 제보`, `버그제보: ...`, `버그 제보: ...`, `버그: ...`, `문제: ...`, `오류: ...` 입력은 제보자 소유 초안을 시작합니다. `COMMUNITY_CHANNEL_ID`로 설정한 비공개 관리·시험 채널에서는 멘션 없이도 `댓글이 안 보여요`, `등록했는데 아무것도 안 떠요`, `봇이 작동하지 않아요`처럼 명시적인 제품·동작 대상과 실패 증상이 함께 있는 자연어를 접수합니다. 접두어 없는 문장에 완료·부분 완료·미완료·휴식·후기·회고·목표 선택·기록 수정 문법이 하나라도 있으면 버그보다 ONE THING 흐름을 우선합니다. 혼합 문장을 버그로 명시할 때는 `버그:`·`문제:`·`오류:`를 사용합니다. 구두점뿐인 입력, 짧은 `안 돼요`, 일반 질문과 감정 표현도 접수하지 않습니다. 공개·업데이트 채널에서는 새 자연어 판정을 끄고 기존 명시 형식만 허용합니다.

이벤트 수신 직후 만드는 `community_records`의 incoming body에는 버그 원문을 넣지 않습니다. 고정된 `bug_intake` 표식, SHA-256 digest, 날짜·스레드·편집 시각만 저장하고, 정확한 제보 문장은 AES-GCM 비공개 객체에 먼저 보관합니다. 소유자 범위 read API가 반환하는 wrapped key와 revision metadata로만 다음 역질문을 이어갑니다.

누락되거나 모순된 내용은 한 번에 하나씩만 묻고, 관찰하지 않은 내용은 추가하지 않습니다. 24시간 안에 세 질문을 넘기거나 시간이 지나면 확정하지 않고 관리자 검토 대상으로 전환합니다.

제보자는 초안을 확인해 `맞아요`를 눌러야 합니다. 이 확인 전에는 관리자나 자동화가 확정 패킷을 만들 수 없습니다. 보안·개인정보 징후는 공개 답글을 계속 받지 않고 `private_incident`로 분리합니다. 새 초안·답변의 비공개 전환, 관계형 원문 제거, receipt·관리자 handoff 생성은 한 DB 트랜잭션으로 커밋하며 기존 중간 상태는 팀 범위 reconciliation이 한 번만 보정합니다. 운영자는 실제 식별자, 원문, 비밀, 첨부물 또는 private object 경로를 공개 채널·공개 export·Check Run 본문에 넣지 않습니다.

정규화 ledger와 `bug_jobs` outbox는 후속 재현·수정·검토·배포 작업을 기록할 수 있지만, 현재는 제공자 실행을 승인하지 않습니다. 별도의 delivery outbox는 질문·요약·접수 영수증·비공개 관리자 인계를 Slack 효과보다 먼저 기록합니다. lease를 가진 worker만 발송을 마칠 수 있고, 실패는 오류와 다음 시각을 남겨 재시도하며 세 번째 실패는 retry 없이 dead-letter `failed`로 보관합니다. 공개 채널에는 비공개 인계 원문·객체 경로를 쓰지 않습니다.

`reporter_thread`와 `admin_channel`처럼 다시 읽을 수 있는 영구 메시지는 Slack이 수락한 뒤 응답이나 DB 완료 기록을 잃어도 제한된 history에서 동일 payload를 대조해 중복 게시를 막습니다. `reporter_ephemeral`은 Slack history로 다시 읽을 수 없으므로 **at-least-once**입니다. Slack 수락 뒤 응답 또는 DB finish를 잃으면 비공개 receipt가 재시도 때 중복될 수 있습니다. 이 제한은 당사자에게만 보이는 receipt를 누락시키지 않기 위한 명시적으로 수용한 tradeoff이며, exactly-once로 표현하지 않습니다.

버그 delivery는 팀마다 하나인 전역 `CommunityClock` 인스턴스가 활동과 정확한 재시도·24시간 만료 시각에 실행됩니다. private reconciliation, 만료, delivery claim 중 하나라도 한 번에 10건의 전체 batch를 채우면 `possiblyMore`로 기록하고 5분 뒤 다시 실행하며, 모든 단계가 batch보다 적어질 때까지 한 시간 idle 검사로 늦추지 않습니다. 활동·실패·미처리 backlog가 계속되는 상한 모양은 5분 간격, 하루 288번 alarm이고, 완전히 비면 한 시간 안전 검사만 남도록 설계했습니다. 이 수치는 호출 모양의 상한일 뿐 실제 Neon 사용량이나 무료 범위를 증명하지 않습니다. 운영 비용은 실제 alarm invocation과 DB query 지표로 따로 측정합니다. 각 실행은 다음 alarm을 먼저 저장한 뒤 만료와 전달 재시도만 제한된 배치로 처리합니다. `*/5` Cron은 사라진 alarm을 다시 거는 backup/nudge이며 delivery SQL을 실행하지 않습니다. 전역 Durable Object alarm이 주 실행 경로입니다. GitHub Actions는 사용하지 않습니다.

비공개 reconciliation, 24시간 만료, delivery claim 중 어느 단계든 한 번에 10건을 처리하면 남은 작업이 있을 수 있다고 보고 5분 안에 다시 실행합니다. 다음 실행에서 세 단계가 모두 10건 미만이어야 한 시간 안전 검사로 돌아갑니다.

일반 배포와 DB 유지보수에서는 `wrangler.jsonc`의 Cron 선언을 그대로 둡니다. `DATABASE_MAINTENANCE=true`이면 전역 시계는 alarm을 다시 걸고 DB·Slack 작업을 건너뜁니다. `/health`는 Worker liveness, 필수 설정 여부와 정적 capability만 반환하는 엄격한 read-only 경로입니다. Durable Object stub 조회, alarm 설정, DB·R2·Slack 호출을 하지 않으므로 clock readiness 근거로 사용하지 않습니다. 유지보수 해제와 배포 뒤 clock readiness는 식별자를 제거한 Durable Object inspect/admin 영수증, 배포 영수증의 alarm 상태 또는 서명 검증을 통과한 Slack activity가 alarm을 건 기록으로 확인합니다. 운영자 진단은 이 readiness 근거, `community.bug.clock.failed`·`community.cron` 로그, scheduled invocation, `bug_deliveries.attempts`와 상태 순서로 진행하며 회원 식별자나 본문을 로그에 복사하지 않습니다.

Cron 등록이 실제로 stale이라는 Cloudflare 설정·호출 증거가 있을 때만 복구 예외를 적용합니다. 정확히 한 개의 기존 schedule을 삭제하고 같은 표현식으로 한 개만 다시 만든 뒤, 마지막 변경부터 최소 15분을 기다립니다. 설정 readback만으로 복구 성공이라 하지 않으며 이후 실제 scheduled invocation과 그 invocation이 alarm을 재무장한 사실, due delivery의 `attempts` 또는 상태 진전을 함께 확인해야 합니다. 그 증거가 없으면 schedule을 반복해서 지우거나 만들지 않습니다.

Slack delivery 실패 로그의 `providerSubcode`는 `invalid_blocks`, `invalid_arguments`, `invalid_form_data`, `msg_too_long`, `http_429`, `provider_5xx`, `other` 중 하나만 남깁니다. 원문 응답, 메타데이터 메시지, 사용자 입력은 로그나 delivery ledger에 저장하지 않습니다.

Slack workspace admin 또는 owner가 명세를 승인하면 같은 스레드에서 Codex 앱을 호출합니다. Codex는 문서 원본을 읽고 별도 `feedback/...` 브랜치와 draft PR까지만 만들며 자동 머지는 하지 않습니다. GitHub Actions는 사용하지 않습니다.

pre-release QA 배포는 기존 Worker의 승인된 검증 시나리오에만 쓰며 exact clean SHA와 rollback 대상을 기록합니다. Git push·merge·release·provider 권한은 포함하지 않습니다. 정식 배포는 private `ops/main`과 활성 ruleset readback이 준비된 뒤 별도 실행합니다.

## 장애와 알려진 경계

공개 초대는 현재 `/join`의 공식 Slack 공유 초대 redirect를 사용합니다. referral form 기반 direct-join은 삭제하지 않고 보류 상태로 유지합니다. 복원 전에는 Site POST, Turnstile, Core 예약, Slack redirect, `team_join` 이메일 귀속, welcome·자기소개 안내를 한 신규 사용자 세션에서 모두 확인해야 합니다. 일반 초대 우회로 들어온 사용자는 소개자 귀속과 lifetime 한도 예약이 자동으로 생기지 않습니다.

DB에 저장됐는지, Slack에 게시됐는지, 회원이 확인했는지를 따로 봅니다. 발송 실패나 응답이 불확실한 상태에서는 실제 채널과 발송 기록을 대조한 뒤 복구합니다. 무조건 다시 보내지 않습니다.

신규 입장·회원 정보는 Slack 이벤트와 실행 시점의 완전한 채널 회원 스냅샷을 사용합니다. 자연스러운 신규 입장 welcome의 배포 후 관찰, 모든 과거 카드의 자동 정리, 자동 백업 SLO, 관리자 재전송 UI는 아직 완성된 검증·기능이 아닙니다. 다음 작업은 [로드맵](ROADMAP.md)에서 관리합니다.

## 계획된 membership·site 운영 절차

이 절은 v0.0.56–v0.0.70를 배포하기 전의 runbook입니다. 현재 운영 설정을 바꾸거나 기능이 출시되었다고 선언하지 않습니다.

1. exact clean SHA와 `schema_migrations` 028을 readback하고, `029_member_lifecycle.sql`부터 `042_instant_shared_invite_join.sql`까지를 정확한 순서로 release receipt에 적습니다. 034의 runtime role은 30일 소개 신청 만료·정리와 12개월 비식별 decision/security audit 보존만 처리하며, 036은 초대 한도, 037은 비소속자 문의, 038은 플래그와 독립된 보존 작업, 039는 봇 소유 welcome 발행, 040은 본명 입력과 비공개 후보를 각각 추가합니다. 041은 정리 전용 interest runtime 권한만 부여합니다. 042는 기존 신청을 `manual_review`로 보존하고 `shared_invite` 직접 예약, INSERT까지 잠그는 한도 guard, 정확한 이메일 가입 귀속 함수만 referral runtime에 추가합니다. 기존 회원 본명 후보는 실제 Slack ID와 대조한 뒤 비공개로 넣고, 회원의 저장 또는 정확한 관리자 확인 전에는 초대 페이지에 노출하지 않습니다. 승인·거절·수동 초대 표시는 지정 관리자 경로에 남깁니다. 이미 적용한 migration을 고치거나 002–004의 retired invitation 경로를 되살리지 않습니다.
2. 유지보수를 켠 뒤 core Worker를 먼저 배포하고, `SITE_CORE_HMAC_SECRET`, `INVITE_EMAIL_PEPPER`, `INVITE_PRIVATE_KEK`, `INVITE_PRIVATE_KEK_VERSION`, 전용 `INVITE_PRIVATE_OBJECTS`를 값 없이 이름만 확인합니다. site Worker에는 core Service Binding과 Turnstile public site key를 두고, `TURNSTILE_SECRET`, `SITE_CORE_HMAC_SECRET`, `SLACK_SHARED_INVITE_URL`은 값이 아닌 secret binding 이름으로만 확인합니다. Slack·Neon·R2 비밀을 site asset이나 공개 vars에 넣지 않습니다.
3. site preview에서 Turnstile 성공·실패, nonce 재사용 거절, HMAC 거절, 이메일 전용 직접 참여, 잘못된 공유 URL의 fail-closed, 축소 모션·키보드·320/375/768/1440 폭을 브라우저로 확인합니다. preview가 통과한 뒤에만 DNS와 `otl1.hyuk.me` custom domain의 기존 레코드·binding 충돌을 read-only로 확인하고 연결합니다.
4. Slack manifest를 생성해 checked-in `slack-manifest.json`과 byte-for-byte 비교합니다. `im:write`, `users:read.email`, `team_join`은 Slack 앱 재설치와 event subscription readback이 필요한 변경입니다. `message.im`은 추가하지 않습니다. 그 밖의 기존 scope는 유지합니다.
5. 모든 새 플래그는 기본 꺼짐입니다. canonical review root, 계절 잔디, shadow 후보, 유예, 종료, 새 ONE THING 복귀, 초대 한도, 비공개 참여 문의, 확인된 소개 신청, 비공개 승인·join provenance, domain 순서로 하나씩 올립니다. 각 단계마다 Slack/DB/브라우저의 독립 관찰 영수증을 남기고 실패하면 해당 플래그만 즉시 되돌립니다. shadow의 zero-retroactive 후보 audit 전에는 enforce로 올리지 않습니다.

기존 `manual_review` 신청의 `approved`는 Slack 접근 권한이 아니며 지정 운영자의 수동 초대 표식을 유지합니다. `shared_invite` 직접 예약은 동의·Turnstile·회원별 한도를 통과한 방문자만 Site Worker의 공식 공유 초대로 이동시킵니다. 공유 URL은 Site Worker의 `SLACK_SHARED_INVITE_URL` secret으로 설치하고 저장소·정적 자산·로그에 남기지 않습니다. `https://join.slack.com/t/<workspace>/shared_invite/<token>` 형식만 허용하며 쿼리·fragment·자격증명·다른 host는 모두 503으로 닫습니다. 실제 `team_join`에서 Slack 계정 이메일 digest가 예약과 정확히 일치할 때만 출처를 기록하고 자기소개 DM을 보냅니다. 불일치 가입은 추정하거나 한도에 차감하지 않습니다.

### 계획된 초대 한도와 비공개 참여 문의

036 적용 뒤 `scripts/bootstrap-referral-admin-db-role.mjs`는 DB 소유자 연결에서 `otl_referral_admin_login`의 새 비밀번호를 만들어 지정한 secret sink로만 전달합니다. sink가 Core Worker의 `REFERRAL_ADMIN_DATABASE_URL`에 전용 연결을 설치합니다. 일반 `DATABASE_URL`이나 회원 링크에는 이 권한을 주지 않습니다. 지정 운영자는 비공개 admin 채널에서만 자연어 `초대 한도 보기`, `초대 한도 <@U...> 보기`, `초대 한도 <@U...> 3`, `초대 기본 한도 2`로 전체 기본값과 회원별 lifetime 한도를 읽거나 바꿉니다. 기본값은 2명이며, 가입과 승인 예약만 세고 joined 출처는 계속 셉니다. 회원은 한도를 바꾸거나 신청을 승인할 수 없습니다.

037의 비소속자 문의는 `PUBLIC_INTEREST_ENABLED`가 꺼진 상태에서 시작하지 않습니다. 열기 전에는 `INTEREST_RUNTIME_DATABASE_URL`, `INTEREST_ADMIN_DATABASE_URL`, `INTEREST_MEMBER_DATABASE_URL`, `INTEREST_ADMIN_CHANNEL_ID`, `INTEREST_ACTION_SECRET`, 비공개 R2 객체와 키를 각각 설치하고, admin 채널이 공개 채널과 다름을 Slack API로 확인합니다. `INTEREST_RUNTIME_DATABASE_URL`은 만료·정리 전용이며 승인·소개 첨부 권한이 없습니다. 공개 `/interest` 양식은 `interest-consent-v1`과 `invite-consent-v1`을 따로 받고, 이름·이메일 공유 동의가 없는 문의를 회원 확인이나 첨부 대상으로 만들지 않습니다. 임의의 offline digest나 운영자 메모는 signed active-member confirmation을 대신할 수 없습니다.

관심 문의가 `introduction_verified`가 된 뒤에만 별도의 일반 pending 소개 신청 하나를 붙일 수 있습니다. 이 단계는 한도를 예약하지 않던 문의를 새 소개 신청으로 바꾸는 것이며, 이후 `approved` 때만 reservation이 생깁니다. 승인 뒤 Slack 초대는 계속 Free Slack UI에서 수동으로 보내고, `team_join` 관찰 전에는 가입으로 쓰지 않습니다.

보존과 정리는 `PUBLIC_INTEREST_ENABLED` 또는 `REFERRALS_ENABLED`를 닫은 뒤에도 기존 신청에 대해 계속 실행합니다. 롤백 중에도 `INTEREST_RUNTIME_DATABASE_URL`, 일반 runtime DB 연결, 비공개 R2 바인딩, `INVITE_PRIVATE_KEK`, `INVITE_PRIVATE_KEK_VERSION`, `SITE_CORE_HMAC_SECRET`을 유지하고 */5 Cron과 Community Clock을 가동합니다. 누락되거나 DB/R2가 실패하면 정리 작업은 실패로 기록하고 다음 알람에서 재시도합니다. 새 공개 문의·소개 접수와 일반 관리자 Slack 알림만 닫힙니다. 보관 오류의 비공개 긴급 알림은 계속 보냅니다. 기존 신청의 보존 기간은 상태별로 적용합니다. pending/approved payload는 30일, rejected/withdrawn payload는 24시간, joined payload는 가입 뒤 7일 안에 R2에서 정리합니다. 비민감 decision/security audit는 12개월만 보존합니다. 암호문·nonce·digest·객체 경로·email·Turnstile token·Slack payload는 운영 로그와 공개 export에 쓰지 않습니다. purge 실패는 재시도 가능한 outbox 상태로 남기고, 삭제가 확인될 때까지 성공으로 쓰지 않습니다.

관심 문의의 서명된 R2 조정 마커가 digest 불일치나 DB 충돌로 `dead`가 되면 공개 플래그와 관계없이 비공개 `INTEREST_ADMIN_CHANNEL_ID`로 케이스 ID만 보냅니다. 운영자는 알림의 ID로 `interest-private-reconcile/v1/<workspace 해시>/<ID>.json`을 찾아 서명·`alertStatus`(`alert_pending` 또는 `alerted`)·ETag를 확인합니다. 암호문 경로와 digest는 Slack이나 로그에 복사하지 않습니다. `alert_pending`은 채널/API 오류, 응답 손실 또는 작업 중단 뒤 재시도되며, 재게시 전에 봇 기록을 대조합니다. 필요하면 비공개 채널 설정과 봇 권한을 복구하고 Community Clock/Cron을 다시 실행해 재시도합니다. `alerted`는 전송 영수증이며 오류의 해결을 뜻하지 않습니다. 운영자는 DB 상태와 암호문 무결성을 별도로 조사하고 근거를 남겨 forward repair 합니다. 충돌이나 digest 불일치의 암호문과 마커는 자동 삭제하지 않으며, 수동 해결 전에 보존 정책과 12개월 감사를 확인합니다.

장애가 나면 먼저 `REFERRALS_ENABLED`와 `PUBLIC_APPLICATIONS_ENABLED`를 닫고 Slack에서 공식 공유 초대를 회수·교체합니다. 이미 노출된 URL은 flag만으로 회수되지 않습니다. migration 042는 내려가지 않고 기존 직접 예약의 정확한 귀속과 30일 만료를 계속 처리합니다. 같은 버전의 core/site 이전 배포로 되돌릴 수 있는지와 schema의 forward repair 필요성을 분리하며 migration은 운영 DB에서 자동 down하지 않습니다. 잘못 분류된 lifecycle은 근거가 있는 관리자 correction만 같은 시즌을 복원할 수 있고, 과거 기록을 지우지 않습니다. canonical 잔디 교체는 새 review-thread 게시를 Slack Web에서 확인한 뒤에만 옛 봇 이미지를 그 메시지의 저장된 payload로 복구하거나 forward repair 합니다. 어떤 복구도 Slack 강퇴·계정 비활성화·공개 초대 링크 발급을 포함하지 않습니다.

### 계획된 lifecycle 관리자 자격증명

035은 Neon 호환 PostgreSQL에서 `otl_lifecycle_admin_login` 로그인 역할을 만들며, superuser·DB 생성·역할 생성 권한이 없고 `otl_lifecycle_admin`만 상속합니다. 이 로그인에는 직접 테이블 권한이나 일반 lifecycle runtime·소개·guide 함수 권한이 없습니다. 허용된 경로는 workspace/channel/member 범위의 후보 읽기와 `restore_error` 정정뿐입니다.

`DATABASE_URL`은 migration과 자격증명 설치에만 쓰는 DB 소유자 연결입니다. Worker의 일반 `DATABASE_URL`에는 lifecycle 정정 권한을 주지 않습니다. 035 적용 뒤 소유자 연결을 로컬 환경으로만 넣고 `scripts/bootstrap-lifecycle-admin-db-role.mjs`를 실행합니다. 이 스크립트는 새 비밀번호를 만들고 지정한 stdin secret sink로만 전용 연결 문자열을 전달합니다. sink는 `LIFECYCLE_ADMIN_DATABASE_URL`을 Core Worker의 별도 비밀로 설치해야 하며 stdout·stderr·명령 인자·공개 export·운영 로그에는 연결 문자열을 쓰지 않습니다. 정기 교체와 담당자 변경 때도 같은 스크립트를 다시 실행해 새 값만 sink로 설치합니다.

전용 연결은 Slack 서명이 검증되고, 설정된 workspace·공개 채널과 다른 비공개 admin 채널·지정 관리자 ID가 모두 일치한 `생애주기` 명령에서만 사용합니다. 운영자는 후보를 읽거나 dormant 상태와 revision 및 근거 키가 일치할 때만 `restore_error`를 기록할 수 있습니다. 범용 runtime 관리자 권한, 다른 회원·채널·workspace 조회, 임의 상태 전환 권한은 만들지 않습니다.

롤백은 먼저 lifecycle feature flag와 전용 `LIFECYCLE_ADMIN_DATABASE_URL`, 소개 플래그와 `REFERRAL_ADMIN_DATABASE_URL`, 관심 문의 플래그와 interest admin/member 역할 비밀을 닫아 새 관리 호출을 멈춥니다. 정리 전용 interest runtime 자격증명과 R2/KEK/HMAC 바인딩은 기존 암호문·감사 기록의 정리가 끝날 때까지 유지합니다. migration 029–041은 운영 DB에서 down하지 않으며, 필요한 복구는 audit를 보존한 forward repair로만 합니다. 다시 열기 전에는 새 자격증명을 설치하고 비공개 Slack 관리자 gate와 후보·정정 경로를 재검증합니다. 이 절은 v0.0.56–v0.0.70의 미출시 runbook이며, 자격증명 설치만으로 출시를 선언하지 않습니다.
