# ContextForge

코딩 에이전트를 위한 셀프호스트 메모리·디스틸 런타임.

[English README](README.md) · [전체 참조](docs/reference.ko.md) ·
[아키텍처](docs/architecture.md) · [운영 가이드](docs/operations.md)

현재 package version: `0.5.1`

ContextForge는 scope가 분리된 durable memory, raw evidence, distilled
checkpoint handoff를 자체 호스팅 런타임에 보관한다. Codex, Claude Code,
OpenCode, Grok, Cursor CLI, MCP client가 같은 기억 경계를 사용하되, 오래된
대화를 전부 durable truth로 취급하지 않게 한다.

![ContextForge 설명 만화](https://raw.githubusercontent.com/ginishuh/contextforge/main/docs/assets/contextforge-explainer-comic-ko.jpg)

## 핵심 모델

- `memory`: 검토 후 승격한 durable fact, decision, contract, preference,
  runbook.
- `checkpoint`: 압축된 최근 handoff state. git, CI, 배포, runtime처럼 바뀌는
  값은 live source에서 다시 확인한다.
- `memory_candidate`: distillation이 만든 review material. 명시적으로
  승격하기 전에는 durable truth가 아니다.
- `raw evidence`: distillation이 실패해도 보존되는 user/assistant 대화 증거.
- `shared`, `repo`, `local`: 명시적인 retrieval scope.

Storage mode는 세 가지다.

- `project-local`(기본): repo의 `.contextforge/` 아래 SQLite.
- `local`: 사용자 data directory의 단일 머신 SQLite.
- `remote`: 여러 agent·machine이 쓰는 canonical HTTP server.

SQLite나 raw runtime data의 live backend로 Git을 쓰지 않는다.

## 0.5.1에서 좋아진 점

- thread/repo 주기 checkpoint consolidation과 memory lifecycle 가시성.
- mutable state 재검증 힌트를 가진 structured checkpoint handoff.
- durable distill/audit job, provider concurrency control, retry fencing.
- bounded indexed retrieval, Unicode/한국어 lexical search, pagination,
  embedding lifecycle maintenance.
- MCP tool profile, capability·scope API token, readiness/metrics, 검증된
  backup/restore, deterministic offline memory-quality gate.

전체 unreleased·historical 기록은 [CHANGELOG.md](CHANGELOG.md)에 있다. English와
Korean release summary가 package version과 맞는지는 CI가 검사한다.

## 빠른 시작

요구사항: Node.js 20 이상.

```bash
npm install
npm run verify
node src/cli.js dbInfo
```

내장 mock provider로 synthetic repo evidence를 저장하고 distill한다.

```bash
export CONTEXTFORGE_STORAGE_MODE=project-local
export CONTEXTFORGE_DISTILL_PROVIDER=mock

node src/cli.js appendRaw \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session \
  --role assistant \
  --content "Synthetic handoff evidence for the demo."

node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session

node src/cli.js bootstrapContext \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --query "demo handoff" \
  --consultReason startup
```

모든 예시는 synthetic이다. `.env`, token, DB·sidecar, raw log, private runtime
evidence는 Git에 넣지 않는다.

## Server·MCP sidecar 실행

Local HTTP server:

```bash
node src/server.js
```

Local stdio MCP server:

```bash
node src/mcp.js
```

Remote canonical deployment는 public template과 운영 문서에서 시작한다.

```bash
cp examples/server.env.example .env
node src/server.js
```

- [Runtime mode](docs/runtime-modes.md)
- [Memory candidate lifecycle](docs/memory-candidate-lifecycle.md)
- [Readiness·metrics·backup·restore](docs/operations.md)
- [Capability·scope authorization](docs/api-token-authorization.md)
- [MCP profile·context budget](docs/mcp-surface-budget.md)

## Provider·agent 연동

Distillation provider는 pluggable이다. 저장소에는 `mock`, `codex_exec`,
`openai_compatible`가 포함되고 candidate audit에는 별도 execution provider를
쓸 수 있다. 일반 테스트는 외부 provider 실행 전에 fail-closed한다. Live
provider 테스트는 명시적 opt-in이 필요하다.

```bash
CONTEXTFORGE_LIVE_TESTS=true npm run test:live
```

Agent adapter는 Codex, Claude Code, OpenCode, Grok, Cursor CLI session을 source
provenance와 함께 ingest할 수 있다. Packaged memory skill에는 bootstrap,
scoped search, session ID, closeout, promotion 규칙이 정리돼 있다.

- [contextforge-memory skill 설치](docs/skills/contextforge-memory/INSTALL.md)
- [Skill workflow](docs/skills/contextforge-memory/SKILL.md)
- [Agent instruction snippet](docs/agent-instructions.md)
- [전체 CLI·provider·operator 참조](docs/reference.ko.md)

## Retrieval·품질

Workspace profile은 호출별로 명시해야 하는 opt-in retrieval topology다.
ContextForge는 현재 repo scope에서 workspace를 자동 추론하지 않으며,
profile을 만드는 것만으로 federation이 활성화되지 않는다. Process-global
기본 workspace 설정도 없다. Caller가 `resolve_workspace`, `bootstrap_context`,
`search` 같은 MCP 호출에 `workspaceKey`를 넘겨야 한다. Core에서는
`resolveWorkspace`, 대응하는 CLI 명령은 `workspaceResolve`를 쓴다. `bootstrapContext`,
`search`, `agentStart`도 core/CLI surface에서 같은 option을 받는다. 반복적으로
사용할 workspace key는 repo-local agent 지침이나 wrapper 설정에 기록한다.
`workspaceKey`가 없으면 bootstrap과 search는 기존 단일 repo 동작을 유지한다.

- [Workspace profile·architecture](docs/architecture.md)
- [Retrieval performance·diagnostic](docs/retrieval-performance.md)
- [Cursor pagination contract](docs/list-pagination.md)
- [Offline memory quality eval](docs/quality-evals.md)

```bash
npm run benchmark:retrieval
npm run eval:quality
```

Offline quality suite는 public synthetic fixture와 격리된 임시 SQLite만 쓴다.
Live LLM writing quality는 별도 opt-in 범위다.

## 개발

```bash
npm run lint
npm test
npm run eval:quality
npm run verify:release
```

`npm run verify:release`는 README/docs link, command reference, version drift,
npm package 구성과 size budget을 검사한다. 자세한 정책은
[Release·package 정책](docs/releases.md)에 있다.

## 안전 원칙

- Distillation 실패가 raw evidence를 지우면 안 된다.
- Checkpoint는 credible handoff state이지 무조건 맞는 live truth가 아니다.
- Memory candidate는 review 전 durable memory로 승격하지 않는다.
- Secret, credential, customer data, private runtime evidence를 committed example,
  report, durable memory에 넣지 않는다.
- Remote mode는 client가 실제 remote server를 사용할 때만 canonical이다.
  운영 판단 전에 runtime mode를 확인한다.

License: [MIT](LICENSE)
