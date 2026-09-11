# v0.0.27 Townhall 신규 입장 환영

2026-09-11. sua의 townhall 입장 `1789091995.608629`는 있었지만 기존 커뮤니티 이벤트 라우터는 `channel_join` subtype을 무시했다. townhall 연결은 업데이트 게시·피드백만 담당했고 환영 처리는 구현되지 않았다.

sua 환영 메시지는 사용자 요청으로 즉시 게시하고 실제 Slack 화면과 history에서 확인했다:
https://onething1line.slack.com/archives/C0C0621V0QZ/p1789092158237149

## 변경

- `src/community-events.ts`, `src/community-welcome.ts`: townhall의 `member_joined_channel` 및 `message/channel_join`을 처리한다. 다른 팀·채널, 봇·삭제 계정은 제외한다. LLM 호출 없이 멘션·원씽 채널 안내·동료 환영 요청을 게시한다.
- 기존 영속 record/claim 기능을 재사용한다. 팀·채널·회원별 `townhall-welcome`을 한 번 처리하므로 두 이벤트의 중복, Slack 재전송, 재입장에 재게시하지 않는다. sua 수동 복구도 동일한 기록을 사용한다.
- `src/community-social.ts`: `users.info`는 user 쿼리를 담은 GET으로 요청한다. 실제 API 시험에서 기존 JSON POST로 user_not_found가 발생한 것을 확인하고 수정했다.
- Slack 앱 화면에서 `member_joined_channel` 봇 이벤트를 추가·저장했다. 기존 message.channels/groups 구독 유지. `slack-manifest.json` 및 생성 스크립트도 맞췄으며 이벤트 설정은 settings 아래에 둔다.

입장 이벤트 기준은 워크스페이스 가입 자체가 아닌 **townhall 채널 첫 입장**이다. 기존 회원도 이 기능 도입 후 처음 관측한 입장이면 환영될 수 있다. welcome 가이드 재게시·온보딩 DM은 별도 계획이며 이번 발송에 포함되지 않는다.

## 검증 및 한계

- `qa/community-welcome.mjs`: 기존 코드에서 첫 입장 발송 0건으로 실패 → 수정 후 통과. 처음 입장, 두 이벤트 간 중복, 봇/다른 팀/다른 채널 제외 검증.
- private admin에서 실제 Slack·Neon을 이용한 함수 드라이버로 최초 발송 및 반복 호출을 실행하고 화면에서 확인했다. 새 회원을 임의로 초대하거나 탈퇴시키지 않았다.
- `qa/community-welcome-live.mjs`: 배포된 HTTP에 sua의 실제 입장 데이터를 두 이벤트 형식으로 재전송, 기존 환영글 한 건 유지 확인. HTTP ACK는 비동기 전체 성공의 증명이 아니므로 최초 경로의 실제 API 드라이버와 별도로 기록한다.
- lint·typecheck·build, social·admin 권한·townhall 회귀 검사 통과. 다음 실제 신규 입장의 Slack→Worker 자동 전달은 아직 관측하지 않았다.
- 발송 claim 이후 Slack 응답이 불확실한 경우 자동 재발송하지 않는다. 중복 환영을 피하기 위해 운영자가 실제 채널과 record를 대조해 복구해야 한다. 중복 방지는 전달 보장을 뜻하지 않는다.

배포: `df6cf612-51c2-43d3-910d-af6cda661c74`. 소스 해시·검증 기록은 `.omx/qa/townhall-welcome/`에 보존한다.

공식 근거: [channel_join](https://docs.slack.dev/reference/events/message/channel_join/), [member_joined_channel](https://docs.slack.dev/reference/events/member_joined_channel/). channel_join 메시지는 생략될 수 있어 입장 전용 이벤트를 함께 구독한다.

## 후속 v0.0.28·v0.0.29

최종 배포 `5cd283df-abdd-46af-8c2c-422fc1e67ed1`.

- `community-emoji.ts`: emoji.list의 실제 커스텀 이미지 목록을 5분 캐시하고 복원 없이 무작위 추출한다. 표준 이모지를 가리킬 수 있는 alias 항목은 제외한다. 목록을 읽을 수 없으면 기존 기본 표현으로 대체해 기록 자체를 막지 않는다.
- `community-records.ts`: 원씽·후기 리액션을 커스텀 목록에서 선택한다. 선택한 이름은 기존 undo 기록에 보존하므로 되돌리기가 다른 리액션을 지우지 않는다. 응원 문구, 첫 달성 축하, 신규 환영, 공통·개인 안내의 장식 이모지도 커스텀으로 변환한다. 회원이 작성한 원문과 상태 구분용 표시는 바꾸지 않는다.
- 환영 게시 후 봇이 직접 커스텀 리액션을 단다. sua 글에도 실제 봇 계정의 3개 반응이 추가된 것을 Slack API로 확인했다 (`custom-live.json`). 이름·이미지의 의미에 대한 자동 적합성 심사는 없다.
- emoji:read를 추가하고 앱을 재설치한 뒤 실제 목록 조회를 확인했다. 실제 적용 권한은 Slack 앱 화면이 원본이다.
- `community-scheduler.ts`: “오늘 최우선순위로 가장 먼저 해결할 중요한 일 한 가지는 무엇인가요?”를 공통 안내에 반영하고 개인 안내도 같은 기준으로 변경했다. 오늘10시 게시물 `1789088402.592259`도 수정·재조회했다 (`daily-copy.json`).
- `qa/community-emoji.mjs`: 실제 목록 형태, 중복 없는 선택, alias 제외, 캐시, 봇 표현 변환 검증. welcome/social/admin/townhall 회귀·lint·typecheck·build 통과.
