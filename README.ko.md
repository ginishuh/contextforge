# ContextForge

코딩 에이전트를 위한 셀프호스트 메모리와 디스틸 런타임.

[English README](README.md)

ContextForge는 단순한 메모리 파일이 아니다. Codex, Claude Code, OpenClaw
같은 에이전트가 프로젝트별 기억을 안전하게 공유하고, 대화 증거를 보존하며,
LLM으로 최근 작업 상태를 checkpoint로 압축해 다음 에이전트가 이어받을 수
있게 만드는 사이드카 런타임이다.

![ContextForge 설명 만화](docs/assets/contextforge-explainer-comic-ko.jpg)

## 핵심 개념

- `memory`: 검토 후 승격된 durable memory. 안정적인 정책, 계약, runbook,
  결정, 반복되는 선호를 저장한다.
- `checkpoint`: raw evidence를 LLM이 압축한 최근 handoff 상태. 신뢰할 수
  있는 최근 메모지만, branch, PR, CI 같은 live state는 다시 확인해야 한다.
- `memory_candidate`: checkpoint에서 나온 승격 후보. 검토 자료일 뿐 자동으로
  durable memory가 되지 않는다.
- `raw evidence`: user/assistant 대화 증거. 디스틸 실패가 나도 삭제하지 않는다.
- `working summary/context`: 현재 세션의 mutable resume state. durable
  memory가 아니다.

행동할 때의 신뢰 순서는 다음과 같다.

```text
live source > durable memory > checkpoint handoff > memory_candidate
```

## 0.5.0에서 좋아진 점

- checkpoint가 사람용 요약뿐 아니라 구조화된 handoff payload를 저장할 수 있다.
- `bootstrapContext`와 `syncResumeContext`가 검색 결과와 별개로
  `handoff.latestHandoff`를 제공한다.
- `structured.liveState`에는 repo, branch, PR, head commit, CI, worktree
  같은 mutable state와 재검증 힌트를 담을 수 있다.
- memory candidate v2 필드인 `durabilityReason`, `riskReason`,
  `evidenceRefs`, `suggestedAction`을 보존한다.
- 자동승격 감사는 distill 모델과 분리된다. `codex_exec` 또는
  `codex_sdk_python` 감사 provider를 사용할 수 있다.
- agent adapter registry가 Codex, Claude Code, OpenCode, Grok, Cursor CLI
  5종 built-in adapter를 제공한다. 새 에이전트는 registry에 추가하는
  방식으로 확장한다.

## 권장 구조

여러 머신이나 여러 에이전트가 같은 기억을 공유해야 한다면 remote mode를
권장한다.

```text
Codex / Claude Code / OpenCode / Grok / Cursor CLI
          |
      MCP tools / CLI
          |
   ContextForge Server
          |
 shared / repo / local scoped memory
          |
 SQLite + raw evidence + checkpoints + durable memory
```

단일 머신에서만 쓸 때는 `project-local` 또는 `local` storage로 충분하다.

## Multi-Agent Ingest

현재 built-in adapter는 5종이다.

```text
codex, claude_code, opencode, grok, cursor_cli
```

확인:

```bash
node src/cli.js listAgentAdapters
```

여러 에이전트 session store를 한 번에 repo registry로 라우팅할 수 있다.

```bash
node src/cli.js ingestAgentRoutedSessions \
  --codexSessionsDir ~/.codex/sessions \
  --claudeCodeProjectsDir ~/.claude/projects \
  --opencodeDb ~/.local/share/opencode/opencode.db \
  --grokSessionsDir ~/.grok/sessions \
  --cursorProjectsDir ~/.cursor/projects \
  --repoRegistry ~/.config/contextforge/repos.json \
  --sinceMinutes 1440 \
  --distill auto
```

`--adapters`를 생략하면 현재 머신에 실제로 있는 adapter store만 자동 감지한다.
환경마다 설치되지 않은 agent 경로를 따로 비활성화할 필요는 없다. repo registry의
`adapters` 필드는 선택 사항이며, 특정 repo가 특정 agent 기록만 받게 좁히고 싶을
때만 쓴다. 새 agent runtime을 나중에 설치했다면 service를 재시작해서 active set에
들어오게 하면 된다.

systemd user service로는 통합 router 하나를 설치하는 것이 기본 권장 형태다.

```bash
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
scripts/install-agent-router-service.sh \
  --name all-agents \
  --repo-registry ~/.config/contextforge/repos.json \
  --token-env-file ~/.config/contextforge/server.env \
  --distill auto
```

핵심 규칙:

- 구별은 `sourceAgent`, `sourceAdapter`, `nativeSessionId`, prefixed
  `sessionId`로 한다.
- 참고는 repo `scopeKey` 기준으로 한다. 같은 repo scope의 durable memory와
  checkpoint handoff는 에이전트 간 공유된다.
- `rawTail`, working context, closeout/audit source는 exact `sessionId` 기준으로
  유지한다. 이 부분은 cross-agent로 섞지 않는다.
- memory candidate와 감사 UI도 같은 source provenance를 보여준다. 후보를
  승격하기 전에 어느 agent가 만든 후보인지 확인할 수 있다.

`ingestAgentRoutedSessions --watch`는 기본 단일 router watcher로 쓸 수 있다.
`--adapters`를 생략하면 각 adapter의 root directory 또는 DB 존재 여부를 보고
설치된 것만 자동 활성화한다. 없는 런타임은 non-existent tree를 계속 걷지 않고
`inactiveAdapters`에 남긴다. `--adapters cursor_cli`처럼 명시한 adapter가 없으면
스캔하지 않고 결과에 `missing_root`로 표시한다. JSONL 기반 adapter는 공통
incremental byte cursor를 쓰고, OpenCode는 설정된 SQLite DB가 있을 때만 읽는다.

## 빠른 시작

요구사항:

- Node.js 20 이상

설치:

```bash
npm install
```

테스트:

```bash
npm test
```

로컬 DB 확인:

```bash
node src/cli.js dbInfo
```

기본값은 현재 checkout 아래 `.contextforge/contextforge.db`에 저장하는
`project-local` 모드다. 이 디렉터리와 SQLite sidecar 파일은 git에 넣지 않는다.

repo가 이전되거나 이름이 바뀐 경우에는 서버 또는 local runtime에
`CONTEXTFORGE_SCOPE_ALIASES`를 설정해서 이후 read/write를 canonical scope로
접을 수 있다.

```bash
CONTEXTFORGE_SCOPE_ALIASES='repo:github.com/old/suite=repo:github.com/new/suite'
CONTEXTFORGE_SCOPE_ALIASES='{"repo:github.com/old/suite":"repo:github.com/new/suite"}'
```

scope prefix를 생략하면 `repo`로 취급한다. `dbInfo`에서 로드된 alias를 확인할
수 있다. alias는 scope type을 바꿀 수 없으므로 `repo:old=repo:new`처럼 같은
scope type 안에서만 사용한다. 구조화된 env 값을 선호하는 배포에서는 JSON object
또는 array 형식도 사용할 수 있다. 기존 row는 자동으로 옮기지 않으며, alias를 켜면
old scope row는 일반 scoped read에서 가려진다. 먼저 dry-run으로 확인한 뒤
명시적으로 migration을 실행한다.

```bash
node src/cli.js migrateScope \
  --fromScope repo \
  --fromScopeKey github.com/old/suite \
  --toScope repo \
  --toScopeKey github.com/new/suite

node src/cli.js migrateScope \
  --fromScope repo \
  --fromScopeKey github.com/old/suite \
  --toScope repo \
  --toScopeKey github.com/new/suite \
  --dryRun false
```

`migrateScope`의 `fromScope`/`fromScopeKey`는 alias canonicalization을 거치지
않는 raw stored scope로 처리한다. 그래서 alias 설정 전에 쓰인 old row를 찾을 수
있다. `toScope`/`toScopeKey`는 alias를 거쳐 canonical scope로 접힌다.

## 저장 모드

- `project-local`: checkout-local SQLite. 기본값이며 실험에 좋다.
- `local`: 사용자 홈 디렉터리 아래 단일 머신 SQLite.
- `remote`: HTTP 서버가 canonical DB를 소유하고, 여러 머신이 MCP/CLI로 접근한다.

remote client 예시:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js dbInfo
```

## HTTP 서버

서버 실행:

```bash
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js serve --host 127.0.0.1 --port 8765
```

서버는 `/mcp`, `/v0/*`, `/healthz`, `/ui/`를 제공한다. token이 설정되어 있으면
remote API 호출에는 `CONTEXTFORGE_REMOTE_TOKEN`이 필요하다.

운영 UI는 `/ui/`에서 사용할 수 있다. UI에서는 runtime 설정, distill provider,
모델, threshold, memory candidates, durable memory correction 등을 확인하고
수정할 수 있다. API key는 write-only로 저장되며 응답에 노출되지 않는다.
admin UI cookie는 기본적으로 `CONTEXTFORGE_ADMIN_COOKIE_SECURE=auto`로 동작한다.
직접 HTTP 접속에서는 로컬 운영 세션이 동작하도록 non-`Secure` cookie를 쓰고,
신뢰된 reverse proxy가 HTTPS 요청으로 표시한 경우에는 `Secure` cookie를 쓴다.
Node가 직접 TLS를 종료하는 배포라면 `CONTEXTFORGE_ADMIN_COOKIE_SECURE=true`를
설정하고, reverse proxy는 client가 보낸 `X-Forwarded-Proto`를 덮어써야 한다.

## 모델 분리

ContextForge는 distill과 audit을 분리하는 구성을 권장한다.

```text
distill:
  codex_exec / gpt-5.4-mini / low

audit:
  codex_sdk_python 또는 codex_exec / gpt-5.5 / low

embedding:
  text-embedding-3-small / 1536 dimensions
```

distill은 raw evidence를 checkpoint와 memory candidate로 압축한다. audit은 이미
만들어진 candidate를 durable memory로 자동 승격해도 되는지 별도로 판단한다.
이렇게 하면 비용이 큰 모델을 모든 distill에 쓰지 않고, 중요한 승격 판단에만
더 강한 모델을 사용할 수 있다.

## Distillation

지원 provider:

- `mock`
- `codex_exec`
- `openai_compatible`

`codex_exec`는 Codex CLI를 실행해 JSON-only checkpoint output을 받고,
로컬 schema validation을 통과한 결과만 저장한다.

예시:

```bash
CONTEXTFORGE_DISTILL_PROVIDER=codex_exec \
CONTEXTFORGE_CODEX_EXEC_MODEL=gpt-5.4-mini \
CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT=low \
node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

DeepSeek 같은 Chat Completions 호환 provider는 `openai_compatible`로 사용할 수
있다.

```bash
CONTEXTFORGE_DISTILL_PROVIDER=openai_compatible \
CONTEXTFORGE_OPENAI_COMPATIBLE_PRESET=deepseek \
CONTEXTFORGE_OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com \
CONTEXTFORGE_OPENAI_COMPATIBLE_MODEL=deepseek-v4-flash \
CONTEXTFORGE_OPENAI_COMPATIBLE_RESPONSE_FORMAT=json_object \
CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY=sk-... \
node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

## 구조화 checkpoint

checkpoint provider는 선택적으로 `structured` payload를 반환할 수 있다.

```json
{
  "structured": {
    "schemaVersion": "contextforge.structured_checkpoint.v1",
    "work": {
      "intent": "사용자가 원한 것",
      "status": "in_progress | implemented | verified | blocked | abandoned",
      "outcome": "실제로 끝난 상태"
    },
    "liveState": {
      "repo": "github.com/example/contextforge",
      "branch": "feature/example",
      "headCommit": "abcdef0",
      "ciStatus": "pass | fail | pending | unknown",
      "observedAt": "2026-06-03T00:00:00Z",
      "verificationRequired": true,
      "staleReasons": ["branch, commit, CI는 변할 수 있는 live state"],
      "verifyHints": ["git status --short --branch", "gh pr view 123 --json statusCheckRollup"]
    },
    "changes": [],
    "verification": [],
    "risks": [],
    "nextActions": []
  }
}
```

이 payload는 `checkpoint.metadata.structured`에 저장되고,
`checkpoint.structured`로도 노출된다. durable memory가 아니라 handoff object다.
따라서 branch, PR, commit, CI, runtime 상태는 반드시 live source에서 재확인해야
한다.

## Bootstrap과 Resume

작업 시작 시 에이전트는 먼저 `bootstrap_context` 또는 `bootstrapContext`를
호출한다.

```bash
node src/cli.js bootstrapContext \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --query "current task handoff"
```

응답의 주요 채널:

- `handoff.latestHandoff`: 최신 checkpoint handoff. 검색 결과와 분리되어
  deterministic하게 제공된다.
- `handoff.latestByAgent`: 같은 repo scope에서 agent별 최신 checkpoint.
  Codex, Claude Code, OpenCode, Grok, Cursor CLI가 섞여 작업할 때 각 원천의
  최신 handoff를 구분해 볼 수 있다.
- `handoff.latestCheckpoints`: 최근 checkpoint 목록.
- `results`: durable memory, checkpoint, memory candidate 검색 결과.
- `workingSummary`: sessionId를 알 때 가져오는 현재 세션 resume state.
- `rawTail`: 필요한 경우에만 요청하는 최근 raw event 꼬리.

에이전트는 `handoff.latestHandoff`를 먼저 읽고, `liveState.verifyHints`로
branch/PR/CI/worktree를 재검증한 뒤 durable memory와 검색 결과를 참고해야 한다.

## Memory Candidate와 감사

distill은 durable memory를 직접 쓰지 않는다. 대신 후보를 만든다.

candidate는 다음과 같은 review field를 가질 수 있다.

- `durabilityReason`
- `riskReason`
- `evidenceRefs`
- `suggestedAction`

provider의 `suggestedAction`은 자동 승인으로 취급하지 않는다. 제안은
`providerSuggestedAction`으로 노출되고, 실제 승격은 사용자의 선택 또는 별도 audit
gate를 통과해야 한다.

read-only 후보 검토:

```bash
node src/cli.js suggestMemoryPromotions \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --checkpointId checkpoint-id \
  --trigger manual_closeout
```

자동승격 dry-run:

```bash
node src/cli.js autoPromoteMemoryCandidates \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --checkpointId checkpoint-id \
  --trigger manual_closeout \
  --dryRun true
```

`dryRun=false`는 `CONTEXTFORGE_AUTO_PROMOTE_ENABLED=true`인 trusted deployment에서만
사용해야 한다.

## Python SDK 감사 provider

Python 백엔드나 Python 서비스와의 연결을 실험할 때는 `codex_sdk_python` 감사
provider를 사용할 수 있다. 이 provider는 Codex Python SDK runner를 통해 Codex
thread를 열고, 기존 Codex binary를 runtime으로 사용한다.

환경 변수 예시:

```bash
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER=codex_sdk_python
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN=/home/ubuntu/.local/bin/codex
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND=python3
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH=/opt/contextforge/openai-codex-sdk
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_MODEL=gpt-5.5
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_REASONING_EFFORT=low
```

SDK target 설치 예시:

```bash
uv pip install --python /path/to/python3 \
  --target /opt/contextforge/openai-codex-sdk \
  --no-deps openai-codex

uv pip install --python /path/to/python3 \
  --target /opt/contextforge/openai-codex-sdk \
  'pydantic>=2.12'
```

중요: target 디렉터리는 서버가 실제로 실행할 Python interpreter 기준으로 만들어야
한다. 예를 들어 서버 runner가 `/usr/bin/python3` 3.12를 쓰는데 `uv` 기본 Python
3.11로 target을 만들면 `pydantic-core` 같은 native wheel import가 실패할 수
있다.

## MCP 사용 원칙

ContextForge MCP는 repo/shared/local scope를 명시적으로 다룬다.

작업 시작:

1. `bootstrap_context`를 repo scope로 호출한다.
2. `handoff.latestHandoff`와 `handoff.latestCheckpoints`를 먼저 읽는다.
3. live state는 source에서 재검증한다.
4. durable memory와 search results를 그 다음 참고한다.

작업 종료:

1. 필요하면 `session_status`로 distill 필요성을 확인한다.
2. `distill_checkpoint`로 checkpoint를 만든다.
3. `suggest_memory_promotions` 또는 `list_memory_candidates`로 후보를 검토한다.
4. stable하고 비밀이 아닌 사실만 `promote_memory_candidate`로 승격한다.

`bootstrap_context`는 세션을 만들지 않는다. adapter가 ingest한 세션을 닫을
때는 새 `cf_...` 세션을 만들지 말고 기존 `codex:<id>`,
`claude_code:<id>`, `opencode:<id>`, `grok:<id>`, `cursor_cli:<id>` 같은
adapter-prefixed session id를 사용해야 한다.

## Embeddings

retrieval 품질을 위해 embedding index를 권장한다.

기본 권장 모델:

```text
provider: openai
model: text-embedding-3-small
dimensions: 1536
```

embedding job은 checkpoint/memory write와 분리되어 있어서 실패해도 durable
memory나 checkpoint가 사라지지 않는다. 실패하거나 멈춘 job은
`processEmbeddingJobs`로 재시도할 수 있다.

## 안전 원칙

- `.db`, `.db-wal`, `.db-shm`, raw log, `.env` 파일을 git에 넣지 않는다.
- raw evidence는 보존하되, 긴 tool output dump를 checkpoint 본문으로 복사하지
  않는다.
- checkpoint는 최근 handoff state이고 durable truth가 아니다.
- secrets, tokens, credentials, customer data, PII는 memory로 승격하지 않는다.
- mutable live state는 항상 source에서 다시 확인한다.

## 개발

테스트:

```bash
npm test
```

서버:

```bash
node src/server.js
```

MCP:

```bash
node src/mcp.js
```

스토리지 확인:

```bash
node src/cli.js dbInfo
```

## 더 보기

- [Architecture](docs/architecture.md)
- [Runtime modes](docs/runtime-modes.md)
- [Roadmap](docs/roadmap.md)
- [Changelog](CHANGELOG.md)
