# ContextForge

Self-hosted memory and distillation runtime for coding agents.

ContextForge is designed for agents that need more than a flat memory file:
canonical project memory, scoped retrieval, evidence-preserving raw logs, and
LLM-backed distillation into checkpoints.

ContextForge is a sidecar memory runtime. It complements existing agent memory
systems by providing canonical project/repo memory, evidence retention, and
LLM-backed distillation.

## Goals

- Keep durable memory in a canonical local store.
- Support shared, repo, and local scopes without mixing them accidentally.
- Use retrieval on demand instead of dumping large memory files into context.
- Treat distillation as a core capability with pluggable providers.
- Work with coding agents such as Codex and Claude Code through adapters or MCP.

## Storage Modes

- `project-local`: repo-bound SQLite storage in a gitignored directory. This is
  the default v0 mode.
- `local`: single-machine SQLite storage under the user's home directory.
- `remote`: first-class VPS or server-backed canonical memory for multiple
  machines.

ContextForge starts project-local for zero-friction setup, but remote mode is a
first-class canonical deployment model for users who work from multiple machines
or want several agents to share the same source of truth. Set
`CONTEXTFORGE_STORAGE_MODE=local` to use home-directory storage, or
`CONTEXTFORGE_STORAGE_MODE=remote` with `CONTEXTFORGE_REMOTE_URL` to use a
server-backed store.

See [docs/architecture.md](docs/architecture.md) for the full product model and
[docs/roadmap.md](docs/roadmap.md) for the implementation roadmap.

## Distillation

ContextForge assumes useful checkpoints need an LLM. The runtime should support
bring-your-own distillation providers, such as:

- `codex_exec`
- `claude_code_exec`
- direct model APIs
- local model runners

The v0 implementation ships with a deterministic `mock` provider and a
`codex_exec` provider. The `codex_exec` provider shells out to `codex exec`,
requests JSON-only output with a schema, validates the result, and records
provider run metadata, including prompt and output schema versions.

## Quick Start

Requirements:

- Node.js 20 or newer

Install dependencies:

```bash
npm install
```

Run the test suite:

```bash
npm test
```

Inspect or initialize the local store:

```bash
node src/cli.js dbInfo
```

By default, runtime data is stored in `.contextforge/contextforge.db` under the
current working directory. This directory and SQLite sidecar files are ignored by
git. To use another location, set `CONTEXTFORGE_DATA_DIR`.

Repo scope keys default to the current git checkout when possible. ContextForge
normalizes common GitHub origin remotes to `github.com/owner/repo`; outside a
git checkout it falls back to a deterministic `path:<hash>:<name>` key. Pass
`--scopeKey` or set `CONTEXTFORGE_DEFAULT_SCOPE_KEY` when you want an explicit
scope key.

## Remote Mode

Run a ContextForge server on the machine that should own canonical memory:

```bash
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js serve --host 127.0.0.1 --port 8765
```

Point a client at that server:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=http://127.0.0.1:8765 \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js search \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --query "sqlite runtime"
```

Remote mode uses the same JSON CLI/core surface as local mode. The server owns
reads and writes for `shared`, `repo`, and `local` scopes, and the client sends
the requested scope explicitly with each operation. If a token is configured on
the server, clients must send it with `CONTEXTFORGE_REMOTE_TOKEN`.

Current v0 remote behavior is deliberately simple:

- `CONTEXTFORGE_STORAGE_MODE=remote` delegates core calls to
  `CONTEXTFORGE_REMOTE_URL`.
- `CONTEXTFORGE_STORAGE_MODE=project-local` stores data under `.contextforge/`.
- `CONTEXTFORGE_STORAGE_MODE=local` stores data under `~/.contextforge/`.
- No automatic offline cache or fallback writes are performed yet. If the
  remote server is unavailable, commands fail rather than silently writing to a
  different canonical store.
- Distillation runs server-side in remote mode, so provider configuration and
  credentials belong on the server for now.

Do not point git at live SQLite or raw runtime data. Use git only for source,
docs, examples, migrations, and reviewed exports.

### Remote Operation

A typical remote deployment runs the HTTP server behind nginx, Caddy, or another
TLS reverse proxy:

```bash
CONTEXTFORGE_REMOTE_HOST=127.0.0.1 \
CONTEXTFORGE_REMOTE_PORT=8765 \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
CONTEXTFORGE_SERVER_STORAGE_MODE=local \
CONTEXTFORGE_DATA_DIR=/var/lib/contextforge \
CONTEXTFORGE_DISTILL_PROVIDER=codex_exec \
CONTEXTFORGE_CODEX_EXEC_MODEL=gpt-5.4-mini \
CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT=low \
node src/server.js
```

Keep the bearer token in a private environment file and do not commit it. The
reverse proxy should expose only HTTPS to clients and forward to the local
server port.

ContextForge does not currently run distillation on a built-in timer. Raw
events are captured when callers use `appendRaw`, and checkpoints are produced
only when a caller invokes `distillCheckpoint` or the MCP `distill_checkpoint`
tool. This keeps cost and model usage explicit.

Codex TUI sessions can also be ingested from their rollout JSONL artifacts
without routing raw transcript text through the model. This keeps raw capture
out of the token path:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestCodexRollout \
  --file ~/.codex/sessions/2026/04/25/rollout-example.jsonl \
  --scope repo \
  --repoPath /path/to/repo \
  --distill auto
```

`ingestCodexRollout` captures user, assistant, tool-call, and tool-result
records, skips developer/system instructions, deduplicates previously ingested
records by stable ingest ids, then checks `sessionStatus`. Use `--distill never`
to capture only, `--distill auto` to distill when thresholds recommend it, or
`--distill always` to force a checkpoint after ingest.

For local machines with several active or recent Codex TUI sessions, scan the
sessions tree instead of naming one file:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestCodexSessions \
  --sessionsDir ~/.codex/sessions \
  --scope repo \
  --repoPath /path/to/repo \
  --sinceMinutes 1440 \
  --distill auto
```

The sessions scan is safe to run repeatedly. It keeps rollout files isolated by
their Codex session id, skips already-ingested records, and ignores a trailing
partial JSON line from an actively-written rollout file so the next scan can
pick it up when complete.

For local TUI use, the same command can stay resident and poll for new rollout
events:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestCodexSessions \
  --sessionsDir ~/.codex/sessions \
  --scope repo \
  --repoPath /path/to/repo \
  --sinceMinutes 1440 \
  --distill auto \
  --watch \
  --intervalMs 30000
```

Watch mode emits one compact JSON object per scan iteration plus a final
summary when it stops. Use `--iterations N` for bounded smoke checks or tests.
Repeated watch scans do not spend model tokens while capturing raw evidence;
model usage happens only when `--distill auto` decides to checkpoint or
`--distill always` is set.

Agents can call `sessionStatus` or the MCP `session_status` tool to inspect
whether a session has enough new raw evidence to justify a checkpoint. The
status response includes raw event counts, raw character counts, the latest
checkpoint, events and characters since that checkpoint, configured thresholds,
`shouldDistill`, and machine-readable reasons.

Recommended cadence depends on the agent workflow:

- Run distillation at session end when an agent finishes a coherent task.
- Run it every 10 to 30 minutes for long-running interactive sessions.
- Avoid distilling after every raw event unless the raw stream is very small.
- Retry failed distill runs after fixing the provider; raw evidence is retained.

Default distill recommendation thresholds are:

- `CONTEXTFORGE_DISTILL_MIN_EVENTS`: `5`
- `CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS`: `600000`
- `CONTEXTFORGE_DISTILL_CHAR_THRESHOLD`: 80% of
  `CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS`, which defaults to `9600`

Before the first checkpoint, `sessionStatus` recommends distillation only when
the raw character threshold is reached. The event threshold is combined with the
character threshold for diagnostics, but it does not trigger an initial
checkpoint by itself. After a checkpoint exists, the event threshold is paired
with the interval threshold, and the character threshold can trigger on its own
to avoid overrunning the provider input budget.

Use an external scheduler if you want unattended checkpoints. For example, a
systemd timer or cron job can call:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId current-session-id
```

That scheduler must choose the session id and scope key intentionally.
ContextForge will not guess which active session should be distilled.

## v0 CLI Workflow

Create or update a durable memory:

```bash
node src/cli.js remember \
  --scope repo \
  --key storage-mode \
  --category decision \
  --tag storage \
  --content "Use local SQLite in .contextforge for v0 runtime state."
```

Search durable memories:

```bash
node src/cli.js search \
  --scope repo \
  --query "sqlite runtime"
```

Search repo memory together with shared rules:

```bash
node src/cli.js search \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --searchScopes repo+shared \
  --sharedScopeKey global \
  --query "retrieval policy"
```

`--searchScopes` accepts `scope`, `repo`, `shared`, `repo+shared`, or `local`.
The default, `scope`, searches only the explicit `--scope` and `--scopeKey`.
`repo+shared` searches the repo scope plus shared durable memory while leaving
`local` memory out. Local memory appears only when `--scope local` or
`--searchScopes local` is requested. If `--sharedScopeKey` is omitted,
ContextForge uses `CONTEXTFORGE_SHARED_SCOPE_KEY` or `global`.

Search uses a SQLite FTS5 index as an explainable retrieval surface over the
canonical `memories` table. Results include `why` match metadata and
`retrieval` rank metadata so callers can debug why an item was returned.

Fetch one memory by key:

```bash
node src/cli.js getMemory \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key storage-mode
```

Start a session and append synthetic raw evidence:

```bash
node src/cli.js beginSession \
  --scope repo \
  --scopeKey github.com/example/contextforge

node src/cli.js appendRaw \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session \
  --role user \
  --content "Decision: keep v0 retrieval lexical and explainable."
```

Inspect whether the session is ready for distillation:

```bash
node src/cli.js sessionStatus \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

Distill a checkpoint with the mock provider:

```bash
node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

Inspect distillation run metadata:

```bash
node src/cli.js listDistillRuns \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

CLI output is JSON so adapters and scripts can consume it directly.

Promote a reviewed checkpoint candidate into durable memory:

```bash
node src/cli.js promoteMemory \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key retrieval-policy \
  --content "Search repo and shared memory before loading raw evidence." \
  --sourceCheckpointId checkpoint-id \
  --reason "Reviewed and accepted by the maintainer."
```

Promotion is intentional: checkpoints can suggest memory candidates, but durable
memory is written only when a caller promotes a reviewed fact or decision.
Candidate review, correction, and deactivation use separate commands so durable
memory changes remain auditable:

```bash
node src/cli.js listMemoryCandidates \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session

node src/cli.js correctMemory \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key retrieval-policy \
  --content "Search repo and shared memory before loading raw evidence." \
  --reason "Clarified the retrieval order."

node src/cli.js listMemoryEvents \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key retrieval-policy

node src/cli.js deactivateMemory \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --key retrieval-policy \
  --reason "Superseded by a newer policy."
```

Inactive memories are retained for provenance but excluded from search results.

## MCP Server

ContextForge supports both remote Streamable HTTP MCP and local stdio MCP.
Use HTTP MCP when multiple machines or agent environments should share the
same canonical memory. Use stdio MCP for local-only or development setups.

Run the remote server, then register its MCP endpoint:

```bash
contextforge-server
codex mcp add contextforge \
  --url https://memory.example.com/mcp \
  --bearer-token-env-var CONTEXTFORGE_REMOTE_TOKEN
```

The HTTP MCP endpoint uses the same bearer token as the remote `/v0/*` API.

Run ContextForge as a local stdio MCP server:

```bash
node src/mcp.js
```

Package installs also expose:

```bash
contextforge-mcp
```

The MCP server exposes a narrow tool surface over the same core API:

- `begin_session`
- `session_status`
- `search`
- `get_memory`
- `remember`
- `list_memory_events`
- `list_memory_candidates`
- `append_raw`
- `distill_checkpoint`
- `promote_memory`
- `correct_memory`
- `deactivate_memory`

Example MCP client configuration:

```json
{
  "mcpServers": {
    "contextforge": {
      "command": "contextforge-mcp",
      "env": {
        "CONTEXTFORGE_STORAGE_MODE": "project-local",
        "CONTEXTFORGE_DEFAULT_SCOPE": "repo",
        "CONTEXTFORGE_DEFAULT_SCOPE_KEY": "github.com/example/contextforge"
      }
    }
  }
}
```

Codex can also register ContextForge as a stdio MCP server while still using
the remote canonical store. This is useful when an environment cannot reach the
HTTP MCP endpoint but can run the local ContextForge package:

```bash
codex mcp add contextforge \
  --env CONTEXTFORGE_STORAGE_MODE=remote \
  --env CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
  --env CONTEXTFORGE_REMOTE_TOKEN="$CONTEXTFORGE_REMOTE_TOKEN" \
  --env CONTEXTFORGE_DISTILL_PROVIDER=codex_exec \
  -- node /path/to/contextforge/src/mcp.js
```

Do not pin the MCP server `cwd` to one project when the same registration should
serve many repositories. Repo scope keys are inferred from the active git
checkout when possible. If an agent is launched outside the repository but is
working on a specific checkout, pass `repoPath` or `cwd` on scoped tool calls so
the client can resolve that checkout before talking to the remote store.
`repoPath` takes precedence when both are provided. Pass an explicit `scopeKey`
when the client cannot provide a useful working directory.

Agents should use `search` for scoped retrieval on demand, call `get_memory`
only when they know the durable key they need, append raw evidence for later
distillation, and call `remember` when the user or agent intentionally decides
that an important fact, preference, decision, or runbook note should become
durable memory. Use `promote_memory` only after a checkpoint candidate or
decision has been reviewed. Use `correct_memory` to preserve the previous value
while changing a durable key, and `deactivate_memory` to remove stale memories
from retrieval without deleting their history.

## codex_exec Provider

Use the Codex CLI as the distillation backend:

```bash
node src/cli.js doctorCodexExec
```

That dry check verifies the configured Codex command without making a model
call. To prove the logged-in Codex CLI can complete a structured `codex exec`
request, run the opt-in live smoke:

```bash
node src/cli.js doctorCodexExec --live
```

Then enable the provider:

```bash
CONTEXTFORGE_DISTILL_PROVIDER=codex_exec \
node src/cli.js distillCheckpoint \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

Optional environment variables:

- `CONTEXTFORGE_CODEX_EXEC_COMMAND`: Codex executable name or path. Default:
  `codex`.
- `CONTEXTFORGE_CODEX_EXEC_MODEL`: model passed to `codex exec --model`.
- `CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT`: optional reasoning effort passed
  through `codex exec -c model_reasoning_effort="..."`. Use `low` for routine
  checkpoint distillation unless your prompt needs deeper synthesis.
- `CONTEXTFORGE_CODEX_EXEC_SANDBOX`: sandbox passed to `codex exec --sandbox`.
  Default: `read-only`.
- `CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS`: provider timeout. Default: `120000`.
- `CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS`: raw-event prompt budget. Default:
  `12000`.
- `CONTEXTFORGE_CODEX_EXEC_CWD`: working directory passed to `codex exec --cd`.
  Default: current working directory.

Failure modes are preserved as distillation runs. If `codex exec` exits
non-zero, times out, or returns malformed JSON, ContextForge records a failed
`distill_runs` row and leaves raw events untouched for retry or debugging.
Failed and successful runs include provider prompt/schema version metadata so
operators can tell which prompt contract produced the result.

## Public Repo Hygiene

- Runtime state lives under `.contextforge/` by default and is ignored by git.
- SQLite database files and sidecars are ignored.
- Examples and tests use synthetic data only.
- ContextForge does not require a private workspace or external agent runtime.

## Status

Early v0 core. The current implementation includes SQLite migrations, scoped
durable memories, raw event capture, FTS-backed explainable search, mock
checkpoint distillation, `codex_exec` checkpoint distillation, and a minimal
remote HTTP mode for server-backed canonical memory. Search can combine repo and
shared memory while keeping local memory opt-in. MCP stdio integration and an
explicit promotion workflow are available. Additional providers are future work.
