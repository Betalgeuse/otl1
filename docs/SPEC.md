# ONE THING 실행 명세

이 문서는 Slack에서 실제로 실행되는 ONE THING 기록의 기준 문서입니다. 제품 원칙은 왜 이 규칙을 지키는지 설명하고, 시스템 구조는 어떻게 구현하는지 설명합니다. 둘이 다르게 보이면 이 문서의 사용자-visible 동작과 불변조건을 먼저 확인합니다.

## 문서 우선순위

| 질문 | 기준 문서 |
| --- | --- |
| 실제로 어떤 입력이 어떤 기록과 메시지를 만드는가 | 이 문서 `SPEC.md` |
| 왜 이 규칙을 지키는가 | [제품 원칙](PRODUCT_PRINCIPLES.md) |
| DB·Worker·Durable Object가 어떻게 나뉘는가 | [시스템 구조](ARCHITECTURE.md) |
| 회원이 무엇을 입력하면 되는가 | [사용 가이드](USER_GUIDE.md) |
| 예약·복구·배포를 어떻게 운영하는가 | [운영 가이드](OPERATIONS.md), [개발 가이드](DEVELOPMENT.md) |
| 앞으로 할 일과 출시 번호 | [로드맵](ROADMAP.md), [업데이트 이력](UPDATE_HISTORY.md) |

로드맵이나 업데이트 이력은 현재 동작을 정의하지 않습니다. 실제 동작 변경은 코드·migration·QA·운영 readback을 함께 남기고 이 문서의 해당 규칙을 갱신합니다.

## 기록 원본과 상태

`community_days(team_id, channel_id, user_id, day)`가 회원별 하루 기록의 단일 원본입니다. 목표, 수행 상태, 후기, 휴식, revision은 이 행에서 함께 읽습니다. Slack 메시지와 `community_records`는 입력 원문·멱등 키·발송 영수증을 보존하는 근거이며, 목표나 후기를 대신하는 별도 원본이 아닙니다.

하루 기록은 다음 상태를 독립적으로 가집니다.

| 항목 | 값 | 의미 |
| --- | --- | --- |
| 목표 | 비어 있음 / 문자열 | 오늘 가장 먼저 해결할 한 가지 |
| 수행 상태 | `pending`, `complete`, `partial`, `not_done` | 목표를 실제로 어디까지 했는지 |
| 후기 | 빈 문자열 / 원문 | 결과·느낌·배움·다음 행동 |
| 휴식 | `true` / `false` | 쉬었다는 명시적 선택 |

목표 등록, 완료 상태, 후기는 서로 다른 이벤트입니다. 후기 없이 완료만 남길 수 있고, 목표 없이 수행 상태를 만들 수 없습니다. 응답하지 않았다고 자동으로 미완료로 바꾸지 않습니다.

## 입력 처리 순서

모든 Slack 메시지는 다음 순서를 지킵니다.

1. Slack 서명·workspace·channel·작성자를 확인합니다.
2. 원문, `source_ts`, parent `thread_ts`, 작성자, 수신 시각을 `community_records`에 먼저 보존합니다.
3. 명시 형식을 결정적으로 파싱합니다.
   - `원씽`, `원띵`, `원싱`, `ONE THING`, `목표`와 bullet 접두사를 목표 형식으로 인식합니다.
   - `후기:`, `회고:`, `완료!` 다음 줄의 `후기:`를 후기 형식으로 인식합니다.
   - `9/20`처럼 날짜만 있는 줄 다음에 목표 marker가 오면 9월 20일 기록으로 인식합니다.
4. 본문의 숫자·시간·링크를 날짜로 추정하지 않습니다. 명시된 과거 날짜는 오늘 기록으로 자동 전환하지 않고 확인 흐름으로 보냅니다.
5. 인지 오프로딩을 적용합니다.
   - 명확한 목표·후기·상태는 확인 버튼 없이 즉시 저장합니다.
   - 안전하게 해석할 수 있는 애매한 표현은 봇이 먼저 해석한 결과를 같은 parent thread에 제시하고 우선 반영합니다. 사용자는 버튼 없이 자연어로 바로 수정할 수 있습니다.
   - 날짜·작성자·대상이 서로 충돌하는 경우에만 canonical 변경을 보류하고 같은 parent thread에 한 가지 질문을 남깁니다.
   - LLM은 해석만 하며 권한·날짜·revision·발송·퇴장을 최종 결정하지 않습니다.
6. `community_days` revision 조건을 확인하고 멱등 키로 한 번만 변경합니다.
7. 원문이 작성된 Slack parent thread에 등록·상태·후기 결과를 답글로 남기고, 같은 원문에 리액션을 추가합니다.
8. DB 변경 후 잔디 projection을 만들고 Durable Object가 Slack 게시를 claim합니다. 게시 성공 영수증을 확인한 뒤 같은 route의 이전 카드를 retire합니다.

봇의 기본 상호작용은 `선 제시 → 즉시 반영 → 자연어 수정`입니다. 버튼은 보조 수단이며 기록의 필수 관문이 아닙니다.

## 목표 등록과 잔디

10시 목표 등록 글은 ONE THING 선택 질문과 함께 두 기준을 제시합니다. 선택한 일을 해내면 다른 일이 더 쉬워지거나 필요 없어지는지, 목표가 오늘 안에 끝낼 만큼 작고 완료 여부가 분명한지를 묻습니다. `발표 자료 준비하기`처럼 막연한 표현은 `발표 자료 1~5쪽 초안을 완성해 동료에게 공유하기`처럼 결과와 완료 기준이 드러나는 한 문장 예시로 안내합니다. 주말 선택 참여 글도 같은 작성 기준을 보여주되 참여를 요구하거나 미참여를 기록하지 않습니다.

목표를 저장하면 즉시 `goal_prompt / recorded` projection을 만듭니다. 이 잔디 칸은 작성 상태이며 완료 칸이 아닙니다. 따라서 목표만 남긴 회원도 해당 parent thread에서 잔디를 볼 수 있습니다.

후기나 수행 상태가 저장되면 `review_prompt / recorded` projection으로 같은 parent thread의 잔디를 갱신합니다. 이전 작성 상태 카드가 있으면 새 카드 게시와 DB 영수증을 먼저 완료한 뒤 이전 카드의 이미지만 제거하고 댓글은 보존합니다.

공통 10시·18시 prompt에 대한 재촉과 prompt 자체의 안내 카드는 공통 prompt root를 사용합니다. 회원이 직접 남긴 목표·후기에서 생성되는 잔디와 확인 답글은 회원 메시지의 parent thread를 사용합니다. Slack은 답글 안에 nested thread를 만들 수 없으므로 reply timestamp가 아니라 parent timestamp를 사용합니다.

## 입력별 기대 결과

| 입력 예시 | 대상 날짜 | canonical 변경 | 잔디 |
| --- | --- | --- | --- |
| `원띵: CV 수정` | 오늘 | 목표 저장 | 즉시 작성 상태 |
| `• 원띵: 논문 읽기` | 오늘 | 목표 저장 | 즉시 작성 상태 |
| `완료!\n후기: 배운 점` | 오늘 | 완료 + 후기 저장 | 완료 잔디로 교체 |
| `부분 완료. 시간이 부족했어요` | 오늘 | 부분 완료 + 후기 저장 | 부분 완료 잔디로 교체 |
| `9/20\n• 원띵: 신청서 작성\n• 완료` | 9/20 | 확인 후 9/20 기록 | 9/20 parent thread |
| `오늘 쉬었어요` | 오늘 | 휴식 저장 | 공개 잔디는 만들지 않음 |
| 일반 잡담·질문 | 없음 | 기록 변경 없음 | 없음 |

## 복구 규칙

누락 원인은 회원 지연으로 처리하지 않습니다. 다음 세 가지를 분리해 확인합니다.

1. Slack 원문은 있는데 `community_days`가 없는가
2. `community_days`는 있는데 garden delivery/projection이 없는가
3. delivery는 sent인데 Slack 카드가 없는가

복구할 때는 원문 timestamp와 parent thread를 사용하고, 새 멱등 키를 남깁니다. 잘못된 잔디는 기존 댓글을 삭제하지 않고 `chat.update`로 이미지만 제거합니다. 임의의 목표·후기·완료 상태를 추정해 만들지 않습니다.

## Share Info

`#all-shareinfo`의 사람이 작성한 top-level 새 글만 한 번 처리합니다. 봇 글, 기존 글의 답글, 편집 이벤트는 무시합니다. 봇은 원문에 커스텀 이모지를 추가하고 같은 parent thread에 감사 답글을 먼저 남긴 뒤, Qwen으로 한 줄 요약과 관련 회원·자료·주제를 연결하는 한 줄 생각거리를 별도 답글로 남깁니다. Qwen이 실패해도 앞의 이모지와 감사 답글은 유지하며 요약·생각거리는 재시도합니다.

## 임시 초대 우회와 보류된 복구

회원별 `/r/<token>` 초대장 발급과 초대자 이름이 표시되는 소개 페이지는 계속 운영합니다. 현재 공개 가입은 해당 초대장의 최종 버튼과 Site의 `/join`만 운영자가 제공한 공식 Slack 공유 초대 URL로 303 이동시키는 임시 경로입니다. 기존 referral form POST는 코드와 감사 데이터를 보존하지만 기본 UI에서 사용하지 않습니다.

보류된 직접 가입 경로는 `referral token 확인 → 이메일 동의 → Turnstile → Core direct-join 예약 → Slack 공유 초대 → team_join 이메일 digest 귀속 → welcome·자기소개 안내`입니다. 이 경로는 실제 신규 사용자 브라우저에서 끝까지 관찰되기 전에는 복구 완료나 기본 가입 경로로 표시하지 않습니다. 우회 경로는 소개자 귀속과 lifetime 한도 예약을 제공하지 않습니다.

## 구현 연결표

| 책임 | 주요 코드·migration |
| --- | --- |
| Slack event intake | `src/community-events.ts`, `src/community-message-router.ts` |
| 명시 날짜·목표 파싱 | `src/community-temporal.ts`, `src/community-explicit-goal.ts` |
| 후기·상태 파싱 | `src/reflection-header.ts`, `src/community-reflection.ts` |
| canonical 저장 | `src/community-store.ts`, `migrations/005_community.sql` 이후 normalized schema |
| member goal/review garden route | `migrations/043_member_review_garden_route.sql`, `migrations/044_member_goal_garden_route.sql` |
| garden delivery | `src/community-garden-delivery.ts`, `src/community-garden.ts`, `src/community-garden-store.ts` |
| 예약·재촉 | `src/community-scheduler.ts`, `src/community-reminder-batch.ts` |
| regression QA | `qa/community-target-date.mjs`, `qa/garden-publication.mjs`, `scripts/test-unit.mjs` |

새 변경은 먼저 이 표의 어느 경계를 바꾸는지 적고, 해당 규칙·migration·회귀 테스트·운영 readback을 한 묶음으로 갱신합니다.
