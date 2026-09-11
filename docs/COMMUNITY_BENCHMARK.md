# 원씽 커뮤니티 벤치마크

2026-09-10 수익·보상 추가 조사: [지인 신뢰와 수익을 연결하는 선례](TRUST_REWARDS_REVENUE.md). Tutorful·ClassPass·Skool·Vitality·Duolingo Family·Maven과 비교 사례 Beeminder를 공식 자료로 검토했다. 수익 모델·보상 정책은 인터뷰 중이며 현재 무료 운영을 유지한다.

2026-09-10 추가: 사용자는 먼저 챙기고 다시 참여할 기회를 주는 방향을 명확히 했다. 듀오링고 공식 사례, 후기 지원 흐름, 카카오 경로, Silo 및 DB 초안은 [선제적 지원 설계](PROACTIVE_SUPPORT_DESIGN.md)에 정리했다. 아래 초기 도입 순서는 현재 우선순위 확정안이 아니다. 목표·후기는 사용자 요구에 따라 Slack 채널에서 작성하고 DM은 선택적 지원에 사용한다.

확인일: 2026-09-08. 목적은 명령어를 기억하지 않고 목표를 등록하고 실천을 이어갈 수 있는 운영 방식을 고르는 것이다. 이 문서는 제품 구매 추천이나 효과 검증 보고서가 아니다.

## 결론

입력은 봇과의 짧은 대화, 공개 기록은 일일 실천 채널, 누적 관리는 개인 앱 홈으로 나누는 안을 추천한다. Geekbot·DailyBot의 대화형 입력과 채널 보고, HabitShare의 명확한 공유 범위, Focusmate의 시작·종료 확인을 조합한 **우리 서비스의 설계 제안**이다. 이런 조합이 참여율을 높인다는 인과적 근거를 확인한 것은 아니다.

## 조사 범위와 근거의 한계

- 공식 홈페이지·도움말·개발자 작성 앱 설명을 우선 사용했다. 제품에 가입하거나 유료 기능을 직접 사용하지 않았다.
- HabitShare·Habitica는 사회적 습관 관리 제품, Focusmate·Ness Labs는 실제 공동 활동이 있는 커뮤니티, Geekbot·DailyBot은 Slack 운영 도구다. 모두 같은 종류의 커뮤니티로 취급하지 않는다.
- 공식 자료의 기능 설명과 실제 사용 효과는 구분한다. 회원 수·후기·홍보 문구를 자기개발 성과의 증거로 사용하지 않는다.
- Habitica의 번역 원문·개발 저장소는 배포 화면과 다를 수 있다. 원씽의 3색 그리드나 자연어 상태 변경을 해당 제품의 기능이라고 주장하지 않는다.

## 비교

| 사례 | 공식 자료에서 확인한 기능·운영 | 가져올 원리 | 첫 버전에서 가져오지 않을 것 |
| --- | --- | --- | --- |
| HabitShare | 일간·주간 습관 목표, 체크인, 친구와 진행 공유. 습관은 기본 비공개이고 공유할 친구를 선택한다. [공식 소개](https://habitshareapp.com/), [개발자 앱 설명](https://play.google.com/store/apps/details?id=com.habitshareapp) | 입력·공개 범위를 명확히 구분하고, 수행 기록에 동료가 반응할 수 있게 한다. | 기본 비공개 정책을 그대로 복제하는 것. 우리 사용자는 등록한 원씽의 채널 공개를 요청했다. |
| Habitica | To Do·Dailies·Habits를 구분하고 완료에 게임 보상을 연결한다. Party와 Challenge는 공동 참여 구조다. [공식 온보딩 원문](https://translate.habitica.com/projects/habitica/overview/en/), [공식 FAQ 원문](https://raw.githubusercontent.com/HabitRPG/habitica/develop/website/common/locales/en/faq.json) | 한 번 달성할 목표와 매일의 실천을 구분한다. 개인 행동이 함께하는 활동에 연결되게 한다. | 장비·상점·복잡한 점수·체력 감소·공동 벌점. 과제 가치에 따른 색을 날짜별 상태색과 혼동하지 않는다. |
| Geekbot | 질문을 DM으로 받고 평문으로 답하면 지정 채널에 보고한다. Timeline에서 사람·질문·날짜로 이력을 조회한다. [응답 가이드](https://help.geekbot.com/en/articles/4153311-reporting-guidelines-how-do-i-report), [Timeline](https://help.geekbot.com/en/articles/10807814-navigating-the-timeline-in-geekbot-s-dashboard) | 입력과 공개 위치를 분리한다. 기록을 시간순 채팅에서 다시 찾게 하지 않는다. | 기업용 상세 보고·다수 질문·관리자 지표를 그대로 옮기는 것. |
| DailyBot | 한 질문씩 대화하며 응답을 수집한다. 채널 보고는 즉시 또는 정해진 시각의 취합 방식으로 구성할 수 있고, 채널·대시보드 등 게시 위치를 정한다. [체크인 흐름](https://www.dailybot.com/academy/product/check-ins/how-check-ins-work/), [보고 방식](https://www.dailybot.com/help/using-dailybot/check-ins/what-is-checkins/), [게시 위치](https://www.dailybot.com/help/using-dailybot/check-ins/report-destination/) | 한 번에 한 질문. 개인 입력은 간단하게, 공개 채널은 정리된 상태로 유지한다. | 미응답자를 계속 독촉하거나 같은 기록을 여러 공간에 중복 입력하게 하는 것. |
| Focusmate | 시작에 할 일을 공유하고 작업한 뒤 종료에 실제 진도를 나눈다. [시작 가이드](https://support.focusmate.com/en/articles/9110188-getting-started) | 계획과 종료 결과를 같은 기록에 연결한다. 완료와 부분 진행을 구별한다. | 화상 통화·실시간 매칭. 종료 자기보고를 객관적인 성과 검증으로 표현하지 않는다. |
| Ness Labs | 커뮤니티는 작은 실험·동료 학습·공동 작업을 안내한다. 별도 회고 방법론 Plus Minus Next는 잘된 점·어려운 점·다음 행동을 정리한다. [회원 안내](https://nesslabs.com/membership), [회고 방법](https://nesslabs.com/plus-minus-next) | 주간 회고를 다음 목표 조정에 연결한다. 선택적인 도움·공동 작업을 제공한다. | 회고 방법론을 전체 회원의 의무 운영 규칙이라고 소개하거나 코칭을 기본 기능으로 만드는 것. |

## 자연어에 관한 중요한 구분

Geekbot·DailyBot의 대화형 체크인은 질문에 일반 문장으로 답하는 구조다. 명령을 입력해야만 시작하는 구조와 다르다. 별도의 수동 명령도 공존한다. [Geekbot 명령](https://help.geekbot.com/en/articles/4283332-how-to-use-geekbot-commands), [DailyBot 명령](https://www.dailybot.com/help/using-dailybot/commands/native-commands/)

Geekbot의 자연어 질의 기능은 보고서 등을 바탕으로 질문에 답하며, DailyBot은 별도의 AI assistant를 안내한다. 이 자료만으로 “아무 문장이나 보내면 올바른 목표를 자동 수정·완료한다”는 기능을 입증할 수 없다. [Ask Geekbot](https://help.geekbot.com/en/articles/13549105-ask-geekbot), [DailyBot AI](https://www.dailybot.com/help/using-dailybot/ai/assistant/)

따라서 첫 단계는 **문장을 그대로 목표 초안으로 받고, 사용자가 등록·완료를 확정하는 방식**을 추천한다. 자유로운 표현을 지원하는 것과 모든 표현에 자동 변경 권한을 주는 것은 별개의 설계 문제다.

## 채택할 것과 우리만의 정책

| 구분 | 내용 |
| --- | --- |
| 여러 사례에서 확인한 패턴 | 쉬운 입력, 계획과 실행 기록의 연결, 동료가 볼 수 있는 공간, 누적 이력 조회 |
| 사용자 요구로 정한 정책 | 하루 한 원씽, 회색·연두·초록, 사용자 색상, 4칸에서 8칸, 채널 공개 |
| 사용자 요구지만 아직 미완성 | 사람 간 초대만 허용, 월 1장 초대권, 초대 관계에 따른 팀 배정 |
| 이번 조사로 입증하지 못한 것 | 이 정책 조합의 지속 참여 효과, 자연어 인식 정확도, 적정 팀 크기, 초대권 수의 최적값 |

국내 사례도 살폈지만 현재 운영 여부가 분명하지 않은 과거 프로그램은 비교표에서 제외했다. 예를 들어 확인 시점의 [밑미 프로그램 페이지](https://www.nicetomeetme.kr/explorer)는 지난 마감 프로그램을 안내했다. 이를 현재 운영 중인 인증 커뮤니티의 근거로 사용하지 않았다.

## 도입 판단

도구를 바꾸거나 여러 SaaS를 구매할 필요를 결론으로 삼지 않는다. 기존 Slack과 자체 봇에 다음 순서로 적용하는 안이다.

1. 커맨드를 몰라도 열 수 있는 시작 버튼과 평문 입력.
2. 오늘 등록한 목표와 완료 상태를 한 공개 카드에서 관리.
3. 개인 앱 홈에서 현재 목표와 과거 기록 확인.
4. 참여가 이어지는 것을 확인한 뒤 주간 목표·회고·선택 알림 추가.

세부 운영안은 [운영 모델](COMMUNITY_OPERATING_MODEL.md), 자연어 처리와 구현 경계는 [자연어 UX](NATURAL_LANGUAGE_UX.md)를 따른다.
