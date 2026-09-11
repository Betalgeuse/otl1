# 원씽 잔디 연결

Worker: https://otl1-onething-garden.zzzaydenzz.workers.dev

멘션에 답하려면 Slack 앱 `OT1L`을 재설치할 때 Bot Token Scopes에 `chat:write`가 포함되어야 한다. 현재 배포된 토큰에서 이 권한이 빠져 있으면 이벤트는 도착해도 봇 응답이 생성되지 않는다. Event Subscriptions의 `app_mention`과 아래 Request URL도 켜져 있어야 한다.

`https://otl1-onething-garden.zzzaydenzz.workers.dev/slack/events`

채널에서 사용하려면 먼저 그 채널에서 `/invite @OT1L`로 봇을 초대합니다. Slack 자동완성에서 봇을 실제 멘션한 뒤 `@OT1L 오늘 책 10쪽 읽을게요`처럼 태그합니다. 봇이 스레드에 초안을 남기고, `등록`을 눌렀을 때만 공개 잔디를 저장합니다. 현재 배포 버전은 `114c1c9a-4f59-4469-9920-d7981eac2940`입니다.

2026-09-08 현재 실제 Slack에서 `/one` 응답과 잔디 이미지 표시, 색상 설정 모달 열기를 확인했다. 앱 OT1L에 빠져 있던 `/one`을 등록했고, Socket Mode를 끈 뒤 명령·버튼 HTTP 주소를 연결했다. Workers에서 지원하지 않던 redirect:error 옵션은 manual로 수정했다. 공개 보드 버전은 `56ee07db-757e-4da0-9e53-9519fbbeb337`이다.

자연어 입력은 아직 미구현이며 [자연어 UX](NATURAL_LANGUAGE_UX.md)에 다음 범위를 정리했다. 초대제는 `INVITATIONS_ENABLED=false`로 비활성 상태다.

## Slack 앱

1. https://api.slack.com/apps 에서 Create New App → From a manifest를 선택한다.
2. 커뮤니티 워크스페이스를 선택하고 프로젝트 루트 `slack-manifest.json` 내용을 붙여 넣는다.
3. 앱 생성 후 OAuth & Permissions에서 Install to Workspace를 진행한다.
4. Bot User OAuth Token (`xoxb-…`)을 로컬 `.dev.vars`의 `SLACK_BOT_TOKEN`에 저장한다.
5. Basic Information → App Credentials의 Signing Secret을 `SLACK_SIGNING_SECRET`에 저장한다.
6. 브라우저 Slack 주소 `https://app.slack.com/client/T…/…`의 워크스페이스 ID를 `SLACK_TEAM_ID`에 저장한다.

Manifest에 포함된 주소:

- Slash command `/one`: `https://otl1-onething-garden.zzzaydenzz.workers.dev/slack/commands`
- Interactivity: `https://otl1-onething-garden.zzzaydenzz.workers.dev/slack/interactions`
- 권한: `commands`. 일반 채널의 모든 메시지를 읽는 권한은 요청하지 않는다.

비밀값은 채팅이나 Git에 넣지 않는다. `.dev.vars`는 Git 제외 대상이며 파일 권한은 0600으로 생성했다. OAuth 토큰과 Signing Secret은 서로 다른 값이다.

## Neon

전용 PostgreSQL 데이터베이스의 연결 문자열을 `.dev.vars`의 `DATABASE_URL`에 넣는다. 기존 다른 서비스의 DB에 임의로 적용하지 않는다. 대상 DB를 확인한 뒤 `migrations/001_initial.sql`을 실행한다. 앱은 `otl` 스키마를 사용한다.

`BOARD_SIGNING_SECRET`에는 무작위 비밀키를, `PUBLIC_BASE_URL`에는 위 Worker origin을 사용한다. Slack과 Neon 설정이 준비되면 로컬 비밀값을 출력하지 않고 Wrangler secrets로 등록한 후 배포·실사용을 확인한다.

## 사용 흐름

- `/one 책 10쪽 읽기`: 오늘의 목표 작성. 작성한 칸은 기본 연두색.
- `/one`: 나의 보드 확인. 첫 목표를 작성하기 전에는 Day 1을 확정하지 않는다.
- 완료하기 버튼: 해당 날짜 칸을 초록색으로 변경.
- 완료 취소: 같은 칸을 작성 상태로 복원.
- 등록 성공 시 원래 멘션 메시지에 봇이 `✅` 리액션을 단다. 중복 클릭에도 목표와 리액션은 하나만 유지된다. 이를 위해 Slack 앱에 `reactions:write` 권한을 추가하고 재설치해야 한다.
- 수정: 오늘 목표가 아직 미완료라면 같은 채널에서 `@OT1L 바꾼 목표 문장`을 다시 멘션하고 등록한다. 완료된 목표는 수정하지 않는다.
- 색상 설정: 상태별 색 선택 또는 직접 HEX 입력, 기본색 복원. 저장한 뒤 보드에 반영.
- `/one 기록 2026-09-08`: 해당 날짜가 포함된 보드와 그날 목표 확인.
- `/one 공유`: 조회의 별칭. 새 `/one` 조회·작성 응답은 기본적으로 실행한 채널에 공개된다. 완료·색상 변경은 작성자만 할 수 있다. 이전 버전의 개인 메시지는 소급 공개하지 않는다.

한국 시간 기준 하루 한 칸이다. Day 5에 기존 4칸 아래 4칸을 추가한다. Day 9부터는 다음 8일 구간을 표시하며 과거 날짜와 기록은 보관한다. 당일 미완료 목표만 수정할 수 있고, 과거에 새 목표를 소급 작성하지 않는다.

## 검증 범위와 운영 한계

- 실제 Neon과 서명된 로컬 HTTP 흐름을 확인했다. 별도로 Slack 자기 대화에서 실제 `/one` 응답과 설정 모달 열기를 확인했다. 타인에게 테스트 메시지를 보내거나 실제 사용자의 목표·색상을 변경하지 않았다.
- 로컬 Workers 런타임에서 생성한 PNG의 정상 로드와 375px 브라우저 폭에서 가로 넘침이 없음을 확인했다. 네이티브 iOS·Android Slack의 표시와 버튼 동작은 연결 후 확인해야 한다.
- Neon HTTP 전송 어댑터로 실제 DB의 목표 작성·완료·색상 변경·사용자 격리를 검증했다. 검증 데이터는 제거했다.
- 첫 버전은 `waitUntil`로 빠르게 응답하고 처리를 이어간다. 영속 큐가 없으므로 프로세스 중단 시 자동 복구를 보장하지 않는다. 응답이 없으면 `/one`으로 저장 여부를 확인한 뒤 다시 시도한다.
- 상태 변경은 원래 이벤트 시간으로 순서를 정한다. 같은 초의 목표 수정·설정 저장은 먼저 저장된 요청을 유지할 수 있다. 버튼에는 Slack의 소수점 타임스탬프를 사용한다.
- 이미지 주소에는 목표 문장과 사용자 ID를 넣지 않는다. 서명된 이미지 주소는 7일 후 만료되므로 이전 메시지 이미지는 `/one`으로 새로 조회한다.
- 별도 웹사이트, 자동 알림, 순위표, AI 평가, 추가 게임 단계는 없다.

## 로컬 도구

이 프로젝트는 런타임 외부 패키지를 추가하지 않았다. 현재 설치된 Bun 1.4.0, Biome 2.5.6, Wrangler 4.62.0과 캐시된 TypeScript를 사용한다.

```sh
bun run lint
bun run typecheck
bun run build
bun run dev
```

새 머신에서는 도구 설치가 필요하다. `typecheck`는 새 패키지를 다운로드하지 않으며, TypeScript가 없으면 실패한다. 호환 날짜 `2025-12-01`은 검증에 사용한 Wrangler 런타임과 함께 고정했다.
