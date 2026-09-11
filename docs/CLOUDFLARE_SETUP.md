# Cloudflare 개발 도구 설정

2026-09-08 사용자 요청에 따라 https://developers.cloudflare.com/agent-setup/prompt.md 의 Codex용 지침을 실행했다.

- Cloudflare 공식 스킬 14개: `/Users/zayden/.agents/skills/`에 설치 확인.
- Codex MCP: `/Users/zayden/.codex/config.toml`에 cloudflare, cloudflare-docs, cloudflare-bindings, cloudflare-builds, cloudflare-observability 등록, 모두 enabled.
- cloudflare 및 cloudflare-observability: `codex mcp list --json`에서 OAuth 인증 확인.
- cloudflare-docs: 공개 서버, OAuth 불필요.
- cloudflare-bindings, cloudflare-builds: 등록 완료, 개별 OAuth는 첫 사용 시 필요.
- Wrangler 4.62.0: 로그인 성공, `wrangler whoami`에서 단일 계정과 Workers 쓰기 권한 확인.
- 새 MCP 도구는 Codex 재시작 후 로드된다. 현재 세션에서 MCP 호출 성공을 검증한 것으로 보고하지 않는다.

설정 전 config.toml을 권한 0600의 임시 백업으로 보관했다. 비교 시 Cloudflare 항목 외에 node_repl args도 달라져 있었으며, 해당 항목은 별도로 수정하거나 되돌리지 않았다.

공식 설치 명령은 Codex 외의 탐지된 에이전트에도 스킬을 복사했다. 설치기가 PromptScript의 전역 설치 미지원 경고를 냈으나, Codex가 사용하는 `.agents/skills`의 14개 SKILL.md는 모두 존재한다.
