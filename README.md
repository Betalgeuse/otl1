# ONE THING

Slack에서 가장 중요한 일 한 가지와 후기를 나누는 커뮤니티 봇입니다. 현재 운영 기능은 v0.0.49까지 적용했습니다.

## 개발

Bun과 Node.js 24를 사용합니다. 기존 개발 도구 버전은 package.json과 bun.lock에 고정했습니다.

```sh
bun install --frozen-lockfile
bun run check
```

check는 lint → 타입 검사 → 외부 서비스를 모킹한 26개 회귀 스크립트 → 배포 없는 빌드를 실행합니다. 운영 DB 이관이나 Slack 발송 스크립트는 포함하지 않습니다.

## 문서

- [현재 기능과 우선순위](docs/UPDATE_HISTORY.md)
- [운영 원칙](docs/PRODUCT_PRINCIPLES.md)
- [DB 구조·백업·복구](docs/DATABASE_NORMALIZATION.md)
- [환영·첫 기록 축하·가이드](docs/TOWNHALL_ONBOARDING.md)
- [테스트 실행 범위](docs/TESTING.md)
- [공개 코드 게시 규칙](docs/GIT_WORKFLOW.md)

## 구조

src는 봇 실행 코드, migrations는 순서가 있는 DB 변경, qa는 검증, scripts는 개발·운영 도구입니다. 초기 구축 설명은 [보관 문서](docs/archive/INITIAL_README.md)로 옮겼으며 현재 설치 절차로 사용하지 않습니다.

공개 저장소는 https://github.com/Betalgeuse/otl1 입니다. 이 로컬 저장소에는 비공개 운영 이력이 있으므로 공개 원격에 현재 브랜치를 직접 push하지 않습니다. 설정 예시와 합성 테스트만 공개용 작업본에 반영합니다.
