# ContextForge Full Reference

Self-hosted memory and distillation runtime for coding agents.

[한국어 README](../README.ko.md)

Current package version: `0.5.1`

This is not another memory file. ContextForge is a scoped memory runtime for
coding agents.

![ContextForge explainer comic](https://raw.githubusercontent.com/ginishuh/contextforge/main/docs/assets/contextforge-explainer-comic-en.jpg)

[Korean version of the explainer comic](https://raw.githubusercontent.com/ginishuh/contextforge/main/docs/assets/contextforge-explainer-comic-ko.jpg)

ContextForge is designed for agents that need canonical project memory, scoped
retrieval, evidence-preserving raw logs, and LLM-backed distillation into
checkpoints.

ContextForge is a sidecar memory runtime. It complements existing agent memory
systems by providing canonical project/repo memory, evidence retention, and
LLM-backed distillation.

Current 0.5.1 builds add periodic checkpoint consolidation for richer
bootstrap context, `handoff.latestConsolidation`, `memoryLifecycle` visibility,
and refreshed packaged `contextforge-memory` skill guidance. They also include
the 0.5.0 structured checkpoint handoff payloads, deterministic
`handoff.latestHandoff` bootstrap state, preserved memory-candidate review
fields, a server-hosted operator UI, DB-backed runtime settings,
OpenAI-compatible distillation for DeepSeek-style Chat Completions APIs,
separate auto-promotion audit runners including the experimental
`codex_sdk_python` audit provider, remote-first MCP workflows, correction
reconciliation, hybrid retrieval, and an embedding job queue so vector indexing
can recover independently from memory or checkpoint writes.

## What's New In 0.5.1

- Checkpoints can be consolidated by thread or repo time window so bootstrap can
  include period context without loading raw evidence by default.
- `bootstrapContext` exposes `handoff.latestConsolidation.thread`,
  `handoff.latestConsolidation.repo`, and `memoryLifecycle` alongside ordinary
  latest handoff checkpoints.
- CLI, remote client, and MCP surfaces now include `listDueConsolidations` /
  `processConsolidations` and `list_due_consolidations` /
  `process_consolidations`.
- The packaged `contextforge-memory` skill documents checkpoint consolidation,
  memory lifecycle checks, candidate audit flow, and scope migration guidance.

## What's New In 0.5.0

- Checkpoints can include an optional structured handoff object with work
  status, observed live state, verification, risks, and next actions.
- `bootstrapContext` and `syncResumeContext` expose
  `handoff.latestHandoff` separately from ordinary search results, so agents can
  read recent continuation state even when the query is narrow or unrelated.
- Memory candidates preserve v2 review fields such as `durabilityReason`,
  `riskReason`, `evidenceRefs`, and `suggestedAction` for audit and closeout
  review surfaces.
- Auto-promotion audit can run through either `codex_exec` or the experimental
  `codex_sdk_python` provider. This keeps cheap distillation and stricter audit
  decisions on separate model/runtime paths.

## Goals

- Keep durable memory in a canonical local store.
- Support shared, repo, and local scopes without mixing them accidentally.
- Use retrieval on demand instead of dumping large memory files into context.
- Treat distillation as a core capability with pluggable providers.
- Work with coding agents such as Codex and Claude Code through adapters or MCP.

## Recommended Architecture

For real multi-agent or multi-machine work, run ContextForge as a remote
sidecar server and let each agent retrieve scoped memory through MCP or the CLI.

```text
Codex / Claude Code / OpenClaw
          |
      MCP tools / CLI
          |
   ContextForge Server
          |
 repo memory / shared memory / local memory
          |
 SQLite + raw evidence + promoted durable facts
```

## Storage Modes

- `project-local`: repo-bound SQLite storage in a gitignored directory. This is
  the default zero-friction mode.
- `local`: single-machine SQLite storage under the user's home directory.
- `remote`: first-class VPS or server-backed canonical memory for multiple
  machines.

On POSIX systems, ContextForge creates and repairs the active data directory to
mode `0700` and the SQLite database plus existing
`-journal`/`-wal`/`-shm` sidecars to `0600`. `dbInfo.permissions` reports the
applied policy. Windows does not use POSIX modes; ContextForge reports
`windows_acl_inherited`, so run it under a dedicated account and restrict the
parent directory ACL when the host is shared.
ContextForge secures its leaf data directory; operators remain responsible for
permissions and ACLs on parent directories.

ContextForge starts project-local for zero-friction setup, but remote mode is a
first-class canonical deployment model for users who work from multiple machines
or want several agents to share the same source of truth. Set
`CONTEXTFORGE_STORAGE_MODE=local` to use home-directory storage, or
`CONTEXTFORGE_STORAGE_MODE=remote` with `CONTEXTFORGE_REMOTE_URL` to use a
server-backed store.

See [docs/architecture.md](architecture.md) for the full product model and
[docs/roadmap.md](roadmap.md) for the implementation roadmap. For the
operator-facing distinction between local all-in-one, HTTP server, and external
remote client roles, see [ContextForge Runtime Modes](runtime-modes.md).
`CONTEXTFORGE_MIGRATION_BACKUP_KEEP` (default `3`) bounds how many
`pre-migration-v*.bak` copies are kept after a successful migration. See
`docs/operations.md` for what is pruned and what never is.

For readiness, metrics, verified backup/restore, and graceful shutdown, see
[ContextForge Operations](operations.md).

## Workspace Profiles

Workspace profiles are optional retrieval topology. They do not change storage
mode and they do not introduce a `workspace` scope type.

```text
storage mode       -> where memory is authoritative
workspace profile  -> which existing scopes are consulted together
agent provenance   -> which adapter/session produced evidence
```

A profile can group several existing scopes, usually repo scope keys such as
`github.com/example/backend`, `github.com/example/web`, and
`github.com/example/suite`. Routing rules explain why a member scope belongs in
a plan for a query. This is useful for multi-repo products where API contracts,
frontend consumers, E2E tests, and release gates live in separate repositories.

Remote mode plus workspace profiles is the recommended setup when several
machines or agents should share one canonical memory store. Workspace profile
reads and writes go through the same remote canonical server in remote mode; the
client must not silently fall back to local or project-local storage.

Workspace selection is explicit. ContextForge does not infer a workspace from
the primary repo scope or workspace membership, and persisting a profile does
not activate federation for agent calls. There is no process-global default
workspace. The caller must pass `workspaceKey` to relevant MCP calls such as
`resolve_workspace`, `bootstrap_context`, and `search`. Core callers use
`resolveWorkspace`; the corresponding CLI command is `workspaceResolve`.
`bootstrapContext`, `search`, and `agentStart` also accept the option on their
core/CLI surfaces. For repeated use, put the key in repo-local agent
instructions or adapter/wrapper configuration; one agent may work across
several unrelated workspaces. Without `workspaceKey`, bootstrap and search
retain their ordinary single-repo behavior.

Example:

```bash
node src/cli.js workspaceUpsert \
  --workspaceKey synthetic-product \
  --displayName "Synthetic Product" \
  --canonicalScope repo \
  --canonicalScopeKey github.com/example/suite

node src/cli.js workspaceMemberUpsert \
  --workspaceKey synthetic-product \
  --name backend \
  --scope repo \
  --scopeKey github.com/example/backend \
  --role api-domain-ssot \
  --priority 100

node src/cli.js workspaceResolve \
  --workspaceKey synthetic-product \
  --scope repo \
  --scopeKey github.com/example/backend \
  --query "OpenAPI permission frontend contract"
```

`resolveWorkspace` returns a scope plan with included/excluded members,
`includedBecause`, matched routing rules, and warnings. `bootstrap_context`
and `bootstrapContext` can opt into that plan with `workspaceKey`. Without a
workspace key, single-repo bootstrap remains unchanged.

Workspace bootstrap returns a separate `workspace` block. Top-level `results`
keep the existing primary-scope behavior; `workspace.results` defaults to
supplemental member scopes only so the primary repo is not shown twice. Use
`includePrimaryInWorkspaceResults=true` only when a merged workspace result view
is explicitly useful. Cross-repo retrieval is bounded with
`workspaceResultLimit` (default `8`) and `workspacePerScopeLimit` (default `4`).
Workspace checkpoint handoffs are excluded by default; set
`includeWorkspaceHandoffs=true` when the caller wants stale-prone recent
handoff state from member repos. Top-level `includeShared=true` only adds
shared results to the primary bootstrap view; workspace shared retrieval is
enabled by workspace routing rules with `includeShared`.

Example bootstrap:

```bash
node src/cli.js bootstrapContext \
  --scope repo \
  --scopeKey github.com/example/backend \
  --query "OpenAPI permission frontend contract" \
  --consultReason startup \
  --workspaceKey synthetic-product \
  --workspaceMode auto \
  --workspaceResultLimit 8 \
  --workspacePerScopeLimit 4
```

Use `includeByDefault` sparingly, usually for a canonical suite or contract
repo. It only affects scope-plan inclusion; workspace retrieval still respects
bounded per-scope and total result limits. `workspaceDeactivate` soft-deletes a
profile by marking it inactive, and a later `workspaceUpsert` with the same key
reactivates the existing profile.

Workspace retrieval can be checked with a public-safe synthetic eval fixture:

```bash
node src/cli.js evalRetrieval \
  --fixture docs/examples/workspace-eval/wastelite.synthetic.json
```

The CLI command always runs against an isolated temporary local store, even when
the caller normally uses project-local or remote mode. It seeds only the fixture
data and exits non-zero when required terms or expected scope roles are missing
from the top primary/workspace result windows.

## Distillation

ContextForge assumes useful checkpoints need an LLM. The runtime should support
bring-your-own distillation providers, such as:

- `codex_exec`
- `claude_code_exec`
- direct model APIs
- local model runners

The current implementation ships with a deterministic `mock` provider,
`codex_exec`, and `openai_compatible`. The `codex_exec` provider shells out to
`codex exec`, requests JSON-only output with a schema, validates the result,
and records provider run metadata, including prompt and output schema versions.
The OpenAI-compatible provider calls Chat Completions APIs such as DeepSeek at
`{baseUrl}/chat/completions`, validates the same checkpoint contract locally,
and records provider metadata without returning API keys.

Checkpoint output is intentionally split into three lanes:

- human-readable summaries for quick inspection
- structured handoff payloads for the next agent
- memory candidates for reviewed durable-memory promotion

For cost and quality separation, a common deployment uses a smaller model for
distillation, for example `codex_exec` with `gpt-5.4-mini` and reasoning effort
`low`, while using a stronger audit runner such as `gpt-5.5` with reasoning
effort `low` before any automatic durable-memory promotion.

## Quick Start

Requirements:

- Node.js 22 or newer

Install dependencies:

```bash
npm install
```

Run the test suite:

```bash
npm run lint
npm test
# or run both
npm run verify
```

`npm run lint` is the hand-rolled source gate: syntax, tabs/trailing
whitespace, and the line-budget ratchet in `scripts/line-budgets.json`.
`npm run lint:eslint` is a separate CI gate for `no-undef`, `no-unused-vars`,
and `no-shadow`. It is not part of `npm run verify` and adds no
devDependency — it fetches a pinned `eslint` through `npx` against the
`eslint.config.mjs` flat config in the repository root, so it needs network
access on first run. Both gates run in CI's source-lint job.

Tests are organized by topic, one file per subject area, with shared helpers
in `test/helpers/`. Contract tests live in `test/contracts/`, the offline
quality eval in `test/eval/`, and opt-in provider smoke tests in `test/live/`.
`scripts/run-tests.js` enumerates the real `*.test.js` paths depth-first in
sorted order instead of passing a glob, so run-to-run duration artifacts stay
comparable and helper modules are not reported as empty test files.

Run the deterministic memory-quality baseline with `npm run eval:quality`. It
covers retrieval, distillation persistence/source-link contracts, and candidate
quality without external providers; live LLM writing quality remains a separate
opt-in eval. See [Memory Quality Evals](quality-evals.md).

For bounded indexed-search behavior, diagnostics, and the 100-to-100,000-memory
synthetic benchmark, see
[Retrieval Performance](retrieval-performance.md).
For bounded list defaults, opaque cursor envelopes, compatibility behavior, and
the explicit CLI all-pages flow, see [List Pagination](list-pagination.md).

Normal tests run in fail-closed test mode: real Codex/Python provider runners
and default external provider fetches are rejected unless a fake is injected.
JUnit and JSON duration artifacts are written to `artifacts/test/`; the default
budgets are 10 seconds per test and 120 seconds for the suite. Override them
with `CONTEXTFORGE_TEST_SLOW_MS` and `CONTEXTFORGE_TEST_BUDGET_MS` when needed.
Live provider smoke tests are separate and require both the live script and an
explicit opt-in:

```bash
CONTEXTFORGE_LIVE_TESTS=true npm run test:live
```

Inspect or initialize the local store:

```bash
node src/cli.js --version
node src/cli.js dbInfo
```

By default, runtime data is stored in `.contextforge/contextforge.db` under the
current working directory. This directory and SQLite sidecar files are ignored by
git. To use another location, set `CONTEXTFORGE_DATA_DIR`.

Repo scope keys default to the current git checkout when possible. `repoPath`
and `cwd` locate the local checkout; they are not the canonical repo identity.
ContextForge normalizes common GitHub origin remotes to `github.com/owner/repo`,
so different local paths can share the same repo memory when they point to the
same GitHub repo. Outside a git checkout it falls back to a deterministic
`path:<hash>:<name>` key. Pass `--scopeKey` or set
`CONTEXTFORGE_DEFAULT_SCOPE_KEY` when you want an explicit canonical scope key.

When a repository moves or is renamed, set `CONTEXTFORGE_SCOPE_ALIASES` on the
server or local runtime to canonicalize future reads and writes. Aliases accept
comma, newline, or semicolon separated entries with `=` or `->` separators:

```bash
CONTEXTFORGE_SCOPE_ALIASES='repo:github.com/old/suite=repo:github.com/new/suite'
CONTEXTFORGE_SCOPE_ALIASES='{"repo:github.com/old/suite":"repo:github.com/new/suite"}'
```

Scope prefixes are optional and default to `repo`. `dbInfo` reports the loaded
aliases. Aliases cannot change scope type; use `repo:old=repo:new`, not
`repo:old=shared:new`. JSON object and array forms are also accepted for
deployments that prefer structured environment values. Existing rows are not
moved implicitly, and once an alias is enabled those old rows are hidden from
normal scoped reads until you migrate them. Inspect and migrate them explicitly:

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

`migrateScope` treats `fromScope`/`fromScopeKey` as the raw stored scope, without
alias canonicalization, so it can still find rows written before the alias was
configured. `toScope`/`toScopeKey` is canonicalized through aliases.

## Usage Modes

ContextForge supports two common deployment modes. Choose one first; mixing the
setup commands is the most common source of confusion.

- Use **local-only mode** for one machine with its own private memory.
- Use **HTTP remote mode** when memory must follow the same repo across
  different PCs or agent environments.

### MCP Tool Profiles

MCP exposes the bounded `agent-core` profile by default instead of preloading
every maintenance and administration schema. Select a broader surface only for
clients that need it:

| Profile | Tools | Intended caller |
| --- | ---: | --- |
| `agent-core` | 24 | normal agent bootstrap, retrieval, evidence, distillation, and closeout |
| `review` | 45 | candidate and durable-memory review |
| `operator` | 67 | queues, retention, embeddings, usage, and server maintenance |
| `workspace-admin` | 11 | workspace topology and scope migration |
| `all` | 73 | complete surface, including compatibility with pre-profile tools |

Set `CONTEXTFORGE_MCP_PROFILE`, or use `CONTEXTFORGE_MCP_TOOLS` as an exact
comma-separated allowlist. An allowlist takes precedence over the profile;
unknown profiles and tool names fail at startup. For local stdio, the equivalent
CLI flags are `--profile` and `--tools`. For `node src/cli.js serve`, use
`--mcpProfile` and `--mcpTools`.

Inspect the selected surface without opening a transport:

```bash
node src/mcp.js --describe-surface --profile agent-core
```

The report includes enabled and disabled names, instruction/schema byte counts,
per-tool description/schema counts, and a conservative initial-token estimate.
Budgets for every profile are recorded in `scripts/mcp-surface-budgets.json`
and ratcheted: the surface may never grow past what is recorded, and a change
that needs more room updates the manifest in the same commit. Verify with
`npm run lint:mcp-surface`. Use `--profile all` temporarily when
migrating an existing client that depended on the old full surface. Detailed
workflow guidance lives in the packaged `contextforge-memory` skill; profile
selection does not depend on that skill being installed.
See [MCP Surface Budget](mcp-surface-budget.md) for the reproducible
transport measurements, selection contract, and host-token caveat.

### Local-Only Mode

Use local-only mode when one machine owns its own memory and you do not need to
share memory with other PCs.

- Storage lives on the same machine as the agent.
- No HTTP server or bearer token is required.
- Local stdio MCP is enough.
- This is simplest for single-machine development.

Local project store:

```bash
CONTEXTFORGE_STORAGE_MODE=project-local \
node src/cli.js dbInfo
```

Local user-wide store:

```bash
CONTEXTFORGE_STORAGE_MODE=local \
node src/cli.js dbInfo
```

Register a local stdio MCP server:

```bash
codex mcp add contextforge \
  -- node /path/to/contextforge/src/mcp.js
```

To opt a dedicated operator client into maintenance tools, append
`--profile operator`. Keep ordinary coding-agent registrations on the default
`agent-core` surface.

In local-only mode, do not set `CONTEXTFORGE_REMOTE_URL`. Each machine writes
to its own SQLite database, so memories do not follow you across machines.

### HTTP Remote Mode

Use HTTP remote mode when multiple PCs, shells, or agent environments should
share the same canonical memory.

- One server owns the canonical SQLite database.
- Other machines connect through `/mcp` or `/v0/*` over HTTPS.
- Clients need `CONTEXTFORGE_REMOTE_URL` and `CONTEXTFORGE_REMOTE_TOKEN`.
- Distillation runs on the server, so provider configuration belongs there.
- This is the recommended mode for multi-machine workflows.

For this repository's live-style setup, the client shape is:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js dbInfo
```

## HTTP Remote Server And API

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

Current remote behavior is deliberately simple:

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

### VPS Server Setup For HTTP Remote Mode

Use this path on the VPS or always-on machine that should own the canonical
ContextForge database. Client machines should use the later "New Machine Setup"
section instead.

1. Install Node.js 22 or newer and git. Install a reverse proxy such as nginx
or Caddy if this server will be exposed on the public internet.

2. Create a dedicated runtime user and directories:

```bash
sudo useradd --system --create-home \
  --home-dir /var/lib/contextforge \
  --shell /usr/sbin/nologin \
  contextforge

sudo install -d -o contextforge -g contextforge /opt/contextforge
sudo install -d -o contextforge -g contextforge /var/lib/contextforge
sudo install -d -m 750 -o root -g contextforge /etc/contextforge
```

3. Install ContextForge:

```bash
sudo git clone https://github.com/ginishuh/contextforge.git /opt/contextforge
sudo chown -R contextforge:contextforge /opt/contextforge
cd /opt/contextforge
sudo -u contextforge npm install --omit=dev
```

4. Create the private server environment file:

```bash
sudo install -m 640 -o root -g contextforge /dev/null /etc/contextforge/server.env
sudoedit /etc/contextforge/server.env
```

Use `examples/server.env.example` as the public template. Example contents:

```bash
CONTEXTFORGE_REMOTE_HOST=127.0.0.1
CONTEXTFORGE_REMOTE_PORT=8765
CONTEXTFORGE_REMOTE_TOKEN=change-me
# Optional admin UI login. Leave unset to disable password login and use
# bearer-token API access only. The password value is PBKDF2:
# iterations:saltHex:hashHex
# CONTEXTFORGE_ADMIN_USER=admin
# CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2=
# Trust forwarded headers only when the direct peer matches this IP/CIDR list.
# Prefer the proxy network over `true`; `loopback` is useful for a local proxy.
# CONTEXTFORGE_TRUST_PROXY=127.0.0.1/32,::1/128
CONTEXTFORGE_SERVER_STORAGE_MODE=local
CONTEXTFORGE_DATA_DIR=/var/lib/contextforge
CONTEXTFORGE_RAW_TTL_DAYS=30
CONTEXTFORGE_DISTILL_PROVIDER=codex_exec
CONTEXTFORGE_CODEX_EXEC_MODEL=gpt-5.4-mini
CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT=low
CONTEXTFORGE_OPENAI_COMPATIBLE_PRESET=deepseek
CONTEXTFORGE_OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com
CONTEXTFORGE_OPENAI_COMPATIBLE_MODEL=deepseek-v4-flash
CONTEXTFORGE_OPENAI_COMPATIBLE_RESPONSE_FORMAT=json_object
CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY=sk-...
CONTEXTFORGE_EMBEDDINGS_PROVIDER=openai
CONTEXTFORGE_OPENAI_API_KEY=sk-...
CONTEXTFORGE_EMBEDDINGS_MODEL=text-embedding-3-small
CONTEXTFORGE_EMBEDDINGS_DIMENSIONS=1536
CONTEXTFORGE_EMBEDDINGS_TIMEOUT_MS=30000
CONTEXTFORGE_EMBEDDINGS_STALE_AFTER_MS=600000
# Keep false unless this trusted deployment should allow dryRun=false
# closeout-scoped safe auto-promotion. Real auto-promotion uses a separate
# audit runner before writing durable memory.
CONTEXTFORGE_AUTO_PROMOTE_ENABLED=false
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED=true
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER=codex_exec
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_MODEL=gpt-5.5
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_REASONING_EFFORT=low
# For Python-backed audit deployments, use codex_sdk_python instead:
# CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER=codex_sdk_python
# CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN=/home/ubuntu/.local/bin/codex
# CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND=python3
# CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH=/opt/contextforge/openai-codex-sdk
```

The default and recommended embedding model is `text-embedding-3-small`.
`CONTEXTFORGE_EMBEDDINGS_DIMENSIONS` is sent to OpenAI only for
`text-embedding-3-*` models; legacy models such as `text-embedding-ada-002` do
not support that request field and must return the configured dimension count.
`CONTEXTFORGE_EMBEDDINGS_STALE_AFTER_MS` controls when a stuck `processing`
embedding job is returned to `pending`; the default is 10 minutes.
`CONTEXTFORGE_AUTO_PROMOTE_ENABLED=true` is required before
`auto_promote_memory_candidates` can run with `dryRun=false`; even then, the
tool only promotes strict closeout-scoped safe candidates. When real
auto-promotion is enabled, `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED=true`
uses a separate audit runner before the durable memory write. The default audit
runner is `codex_exec` with `gpt-5.5` and reasoning effort `low`, independent
from the distillation runner.

For agent closeout review without durable-memory promotion, use
`audit_memory_candidates`. It uses the same closeout-scoped safety policy,
selects a bounded candidate batch, and calls the configured audit provider once
per selected candidate. It persists candidate review metadata and audit usage
events while leaving candidate status and durable memory unchanged. Keep
`auto_promote_memory_candidates dryRun=false` for the separate explicit
automation path.

For Python-backed services, the audit gate can also use the experimental
`codex_sdk_python` provider. It calls the Codex Python SDK from a small Python
runner and points that SDK at an existing Codex binary:

```bash
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER=codex_sdk_python
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN=/home/ubuntu/.local/bin/codex
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND=python3
CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH=/opt/contextforge/openai-codex-sdk
```

If the SDK's pinned `openai-codex-cli-bin` wheel is not available for the
server platform, install only the Python SDK package and its pure Python
dependency into the configured `PYTHONPATH`, then rely on
`CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN` for the runtime binary:

```bash
uv pip install --python /path/to/python3 \
  --target /opt/contextforge/openai-codex-sdk \
  --no-deps openai-codex
uv pip install --python /path/to/python3 \
  --target /opt/contextforge/openai-codex-sdk \
  'pydantic>=2.12'
```

Use the same Python interpreter that the ContextForge server will run through
`CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND`. If the target directory is
built with a different Python version, native wheels such as `pydantic-core`
may fail to import at audit time.

Use a long random token and store the same value on client machines as
`CONTEXTFORGE_REMOTE_TOKEN`. Treat this token as an administrator credential:
it can call every remote API method, including pruning raw evidence and running
provider health checks. Do not put this file in git. For least-privilege remote
agents, configure `CONTEXTFORGE_API_TOKENS_JSON` with separate `read`, `write`,
`review`, and `operator` capabilities plus explicit `repo`/`shared`/`local`
scope rules. HTTP JSON and HTTP MCP share one deny-by-default authorization
matrix; see [API Token Authorization](api-token-authorization.md).

The HTTP server also serves an operator UI at `/ui/`. The UI can inspect
runtime/storage state, view recent distillation runs, update DB-backed runtime
settings, select `codex_exec` or OpenAI-compatible distillation, pick preset or
manual distillation models, tune distillation thresholds, review memory
candidates, promote candidates manually, correct durable memories, bulk reject
or deactivate bad memory material, and deactivate wrong memories with
provenance. Non-secret runtime settings saved in the UI override env defaults
for new calls without restarting the server. Keep provider credentials in
`CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY` by default. DB-backed API keys are
write-only in the UI/API but are plaintext inside SQLite; storing a new value is
therefore disabled unless the server explicitly sets
`CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS=true`. Existing stored secrets
continue to work and make `getRuntimeSettings` return a
`plaintext_runtime_secret_stored` warning until they are cleared. Optional admin password login is cookie-session based; bearer-token
access remains available for API clients. Admin UI cookies use
`CONTEXTFORGE_ADMIN_COOKIE_SECURE=auto` by default. Direct HTTP access gets a
non-`Secure` cookie so local operator sessions work. Forwarded headers are
ignored unless the direct peer matches `CONTEXTFORGE_TRUST_PROXY`. Set it to a
comma-separated proxy IP/CIDR list (or `loopback` for a proxy on the same
machine) so `X-Forwarded-Proto: https` can produce a `Secure` cookie and
`X-Forwarded-For` can identify the client for login rate limiting. `true` trusts
every direct peer and should only be used when ContextForge is unreachable
except through a proxy that overwrites client-supplied forwarded headers. If
Node terminates TLS directly, set `CONTEXTFORGE_ADMIN_COOKIE_SECURE=true`
instead. Failed-login state is bounded by `CONTEXTFORGE_ADMIN_LOGIN_MAX_KEYS`
(default `10000`) and rejects new keys while the cap is full rather than
dropping active rate limits.

`CONTEXTFORGE_OPENAI_API_KEY` is only needed on the process that performs
embedding calls. In remote/server-backed deployments, keep that key only in the
server environment file. Clients that call the remote server need
`CONTEXTFORGE_REMOTE_TOKEN`, not the OpenAI key.

If you run the remote server as a systemd user service instead of a system
service, use the same variable names in a private user env file such as:

```text
~/.config/contextforge/server.env
```

and point the user unit at it:

```ini
EnvironmentFile=%h/.config/contextforge/server.env
```

5. Install a systemd service:

```ini
# /etc/systemd/system/contextforge-remote.service
[Unit]
Description=ContextForge remote memory server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=contextforge
Group=contextforge
WorkingDirectory=/opt/contextforge
EnvironmentFile=/etc/contextforge/server.env
ExecStart=/usr/bin/node /opt/contextforge/src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and verify it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now contextforge-remote.service
systemctl status contextforge-remote.service
curl -fsS http://127.0.0.1:8765/healthz
curl -fsS http://127.0.0.1:8765/readyz
```

6. Choose how clients reach the server.

For a public internet endpoint, put HTTPS in front of the local server. A
minimal nginx location is shown below. With this loopback proxy, set
`CONTEXTFORGE_TRUST_PROXY=loopback` in the server environment. The right-to-left
trust-chain parser treats nginx's appended client address as untrusted and does
not accept spoofed addresses farther to its left.

```nginx
server {
    listen 443 ssl http2;
    server_name memory.example.com;

    ssl_certificate /etc/letsencrypt/live/memory.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/memory.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Reload the proxy and verify the public endpoint:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsS https://memory.example.com/healthz
```

For a private network, VPN, Tailscale, or firewall-restricted host, clients can
connect directly to an IP address and port. Bind the server to a reachable
interface:

```bash
CONTEXTFORGE_REMOTE_HOST=0.0.0.0
CONTEXTFORGE_REMOTE_PORT=8765
```

Then verify from another machine:

```bash
curl -fsS http://203.0.113.10:8765/healthz
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=http://203.0.113.10:8765 \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js dbInfo
```

Do not expose a direct HTTP port to the open internet unless another network
layer already provides encryption and access control. The bearer token protects
the ContextForge API, but it is not a replacement for TLS on untrusted networks
or for operator-only handling of admin-capable credentials.

When embeddings are enabled on the server, successful `distillCheckpoint` calls
immediately queue embedding work for the new checkpoint and its memory
candidates. Durable memory writes also queue their own embedding work. The
actual sqlite-vec index write is processed by the embedding worker, so vector
indexing can retry or recover independently from the canonical write path:

```bash
node src/cli.js processEmbeddingJobs --scope repo --scopeKey github.com/example/repo
```

Inspect queue state with `listEmbeddingJobs`, or with `dbInfo` for aggregate
job counts and degraded retrieval signals. The canonical tables remain SQLite
memory/checkpoint tables; the vector index is rebuildable with:

```bash
node src/cli.js rebuildEmbeddings --scope repo --scopeKey github.com/example/repo
```

If embedding fails after a successful write or distillation, the canonical
memory/checkpoint data remains stored and the embedding job records `failed`
with attempts and the last error. Retry failed jobs with:

```bash
node src/cli.js processEmbeddingJobs --retryFailed true
```

Stuck `processing` jobs are reset to `pending` after the configured stale
timeout. Set `CONTEXTFORGE_EMBEDDINGS_STALE_AFTER_MS` on the worker/server, or
pass `--staleAfterMs` for one run.

If the configured embedding dimensions change, ContextForge refuses to silently
drop the existing vector index. Run a forced rebuild only when you intentionally
want to reset and repopulate the derived sqlite-vec tables:

```bash
node src/cli.js rebuildEmbeddings --scope repo --scopeKey github.com/example/repo --force
```

Embedding vectors, index rows, and completed jobs are derived data, but their
lifecycle still needs an explicit operator workflow. Inventory is read-only:

```bash
node src/cli.js embeddingInventory --scope repo --scopeKey github.com/example/repo
```

It reports missing sources, inactive-memory rows, rejected/stale/snoozed
candidate rows, content-hash mismatches, retired model/dimension rows,
vector-only rows, and old completed jobs. Failed jobs with a current source and
model remain available for retry; only orphaned or retired failed jobs are GC
candidates. Scoped inventory does not classify or
delete vector-only rows because a missing index also removes the only stored
scope evidence; run a global inventory to inspect those rows. Inventory scans
are bounded by `scanLimit` and report conservative per-table truncation flags,
while the processing-job safety check always uses complete status counts. When
`nextCursor` is present, pass it as `--cursor` to continue the index,
terminal-job, and vector-only keyset scans; an empty plan is final only when
`nextCursor` is null. For non-dry GC, handle `needsRescan=true` first by
repeating the call with the same input cursor (or no cursor when the first page
was capped); advance to `nextCursor` only after `needsRescan=false`. GC
responses keep the nested inventory summary-only by
default to bound MCP/remote payloads; use `--includeInventory true` only when
the full scanned page is required for diagnosis.

GC is a bounded dry-run by default:

```bash
node src/cli.js pruneEmbeddingArtifacts --batchSize 100
node src/cli.js pruneEmbeddingArtifacts --batchSize 100 --dryRun false
node src/cli.js pruneEmbeddingArtifacts --batchSize 100 --cursor '<nextCursor>'
```

Before applying it, back up the canonical SQLite store and stop embedding
workers. A non-dry run refuses to start while `processing` jobs exist unless
`--force true` is supplied. Each call removes at most `batchSize` eligible
vector/index/job records in one transaction; repeat dry-run and apply calls
until the plan is empty. Current active-memory embeddings and pending/promoted
candidate embeddings are preserved. Run SQLite `incremental_vacuum` separately
when physical file-size reclamation is required. In remote storage mode these
methods execute on the canonical server; verify `dbInfo.connection` before an
operator run instead of assuming the current checkout owns the database.
Retired model/dimension rows are classified only when an embedding provider is
active and are excluded from deletion unless `--includeRetired true` is also
explicit. If at least half of indexed rows differ from the active provider,
non-dry retired cleanup is blocked again until `--confirmMassRetired true` is
provided. If the plan removes a content-hash mismatch, process its embedding
job or run an intentional scoped rebuild after GC; the response lists those
source ids in `reindexSuggestedSourceIds`.
Blocked responses set `blockedRetry=true`, `needsRescan=true`, and preserve the
input cursor. Resolve the blocking condition and retry that same cursor before
advancing.

ContextForge uses the npm `sqlite-vec` package and expects sqlite-vec 0.1.x with
`vec0` support for auxiliary primary-key columns. Check `node src/cli.js dbInfo`
for `vector.sqliteVecAvailable`, `vector.sqliteVecVersion`, and any load error.
The package is routinely used on Linux and macOS; platform SQLite build options
can affect extension loading.

After the VPS is healthy, configure each laptop, desktop, or agent host with
the same URL and bearer token using the next section.

### New Machine Setup For HTTP Remote Mode

Use this path when another PC should share the same canonical memory server.
The remote server should already be running and reachable through HTTPS or a
trusted direct IP endpoint.

1. Install ContextForge:

```bash
git clone https://github.com/ginishuh/contextforge.git
cd contextforge
npm install
```

2. Store the remote bearer token in a private env file:

```bash
mkdir -p ~/.config/contextforge
printf 'CONTEXTFORGE_REMOTE_TOKEN=%s\n' 'change-me' > ~/.config/contextforge/server.env
chmod 600 ~/.config/contextforge/server.env
```

Do not commit this file. Use the token configured on the remote server.
Do not put `CONTEXTFORGE_OPENAI_API_KEY` on client machines unless they also run
ContextForge in local/project-local mode and perform embeddings directly.

3. Register the remote HTTP MCP endpoint with Codex:

```bash
set -a
. ~/.config/contextforge/server.env
set +a

codex mcp add contextforge \
  --url https://memory.example.com/mcp \
  --bearer-token-env-var CONTEXTFORGE_REMOTE_TOKEN
```

Codex reads the token from `CONTEXTFORGE_REMOTE_TOKEN` when it connects to the
HTTP MCP endpoint. If your shell does not export that variable automatically,
source the env file before starting Codex or add equivalent shell startup
configuration.

4. Verify the remote server and MCP registration:

```bash
set -a
. ~/.config/contextforge/server.env
set +a

curl -fsS https://memory.example.com/healthz
codex mcp list
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN="$CONTEXTFORGE_REMOTE_TOKEN" \
node src/cli.js dbInfo
```

5. For each repo that should auto-capture local Codex TUI sessions, install a
repo-specific watch service:

```bash
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
scripts/install-codex-watch-service.sh \
  --name my-repo \
  --repo-path /absolute/path/to/my-repo \
  --scope-key github.com/example/my-repo \
  --token-env-file ~/.config/contextforge/server.env \
  --distill auto
```

The service scans the global Codex sessions directory but only ingests rollout
files whose recorded TUI `cwd` is inside `--repo-path`, so one machine can have
separate watch services for separate repos without crossing repo scopes.
`--scope-key` is optional when the checkout has a stable GitHub origin, but it
is recommended for cross-machine deployments because it pins the canonical repo
memory key independent of local paths.

6. Check service logs:

```bash
systemctl --user status contextforge-codex-watch-my-repo.service
journalctl --user -u contextforge-codex-watch-my-repo.service -n 50 --no-pager
```

Use the same remote URL and token on every machine that should share memory.
Use different `--repo-path` values per checkout; either pass the same
`--scope-key` on every machine or let ContextForge infer the same normalized
GitHub remote key from each checkout.

### Remote Operation

A typical remote deployment runs the HTTP server behind nginx, Caddy, or another
TLS reverse proxy:

```bash
CONTEXTFORGE_REMOTE_HOST=127.0.0.1 \
CONTEXTFORGE_REMOTE_PORT=8765 \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
CONTEXTFORGE_SERVER_STORAGE_MODE=local \
CONTEXTFORGE_DATA_DIR=/var/lib/contextforge \
CONTEXTFORGE_RAW_TTL_DAYS=30 \
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

Raw evidence can be pruned by age without deleting checkpoints, distill runs,
or promoted durable memories. Set `CONTEXTFORGE_RAW_TTL_DAYS` on the server or
local runtime to enable automatic pruning during raw-event writes. The prune
check runs at most once per `CONTEXTFORGE_RAW_PRUNE_INTERVAL_MS`, which defaults
to one hour. You can also run it manually:

```bash
CONTEXTFORGE_RAW_TTL_DAYS=30 \
node src/cli.js pruneRawEvents
```

Distillation cost is controlled by the threshold policy. `CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS`
sets the normal minimum interval after a checkpoint, and
`CONTEXTFORGE_DISTILL_CHAR_MIN_INTERVAL_MS` controls how soon a char-threshold
trigger may create another checkpoint. By default the char trigger uses the same
minimum interval, so one long conversation turn does not immediately force
another LLM distillation right after a checkpoint.

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

`ingestCodexRollout` captures user and assistant conversation records, skips
developer/system instructions, and leaves tool-call/tool-result payloads in the
native Codex transcript. ContextForge raw events are distillation-ready
conversation evidence, not a clone of the native JSONL log. The adapter
deduplicates previously ingested records by stable ingest ids, then checks
`sessionStatus`. Use `--distill never` to capture only, `--distill auto` to
distill when thresholds recommend it, or `--distill always` to force a
checkpoint after ingest.

Codex-ingested raw events use a namespaced session id:
`codex:<native-codex-session-id>`. Their metadata also includes
`sourceAgent: "codex"`, `sourceRuntime: "codex_tui"`,
`sourceAdapter: "codex_rollout_jsonl"`, and `nativeSessionId`. Future TUI
adapters should use the same provenance pattern, for example
`claude_code:<native-session-id>` plus a distinct `sourceAgent` and
`sourceAdapter`. Durable repo memory stays shared across agents; raw evidence
and checkpoints stay attributable to the originating TUI session.

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
pick it up when complete. When `--repoPath` is set, files whose recorded TUI
cwd is outside that repo path are skipped so a global sessions directory can be
watched safely by a repo-specific service.

For machines that use several repositories, prefer one unified ingest router
over one watcher per repository or per agent. The multi-agent router
auto-detects installed adapter stores on the machine, skips missing runtimes,
matches file metadata such as `cwd` against a repo registry, and writes to the
matched repo's canonical `scopeKey`.

Example repo registry:

```json
{
  "repos": [
    {
      "name": "suite",
      "repoPath": "/home/ginis/wastelite-suite",
      "scopeKey": "github.com/ginishuh-dev/wastelite-suite"
    },
    {
      "name": "frontend",
      "repoPath": "/home/ginis/wastelite-suite/wastelite_frontend",
      "scopeKey": "github.com/ginishuh-dev/wastelite_frontend"
    }
  ]
}
```

The `adapters` field is optional. Omit it when all installed adapters may route
to a repo; include it only to narrow which agents can write that repo scope.
When a session `cwd` is outside the registered `repoPath`, for example a
temporary PR review checkout, the router falls back to the checkout's Git
`origin` remote and matches it against the registry `scopeKey`.

Run the unified agent router:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestAgentRoutedSessions \
  --repoRegistry ~/.config/contextforge/repos.json \
  --sinceMinutes 1440 \
  --distill auto \
  --watch \
  --intervalMs 30000
```

Nested repo paths are matched by most-specific path first. Unknown `cwd` values
that cannot be matched by path or Git remote are skipped by default; the router
does not silently write unmatched sessions to `shared` or `local` memory. Each
routed file result logs the matched repo name,
repo path, and `scopeKey`, or a skipped reason such as `unmatched_repo_cwd`.

Install the unified agent router as a systemd user service:

```bash
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
scripts/install-agent-router-service.sh \
  --name all-agents \
  --repo-registry ~/.config/contextforge/repos.json \
  --token-env-file ~/.config/contextforge/server.env \
  --distill auto
```

The older repo-specific watcher remains supported for simple single-repo
setups, and the older per-agent router installers remain available for
compatibility. For suite-style workspaces and mixed agent environments, the
unified router is the recommended operating shape.

ContextForge also exposes an extensible multi-agent adapter registry. The
built-in adapter ids are `codex`, `claude_code`, `opencode`, `grok`, and
`cursor_cli`; future adapters should register the same normalized contract
instead of adding another copy of the router. Use `listAgentAdapters` to inspect
the available set:

```bash
node src/cli.js listAgentAdapters
```

Agent-neutral lifecycle helpers wrap existing ContextForge calls without
changing their authority or review policy. `agentStart` calls
`bootstrapContext` and can pass `workspaceKey`; `agentCloseout` checks the exact
session/checkpoint source, optionally distills, runs read-only candidate audit
and promotion suggestions, and defaults to `dryRun=true`.

```bash
node src/cli.js agentStart \
  --agent codex \
  --scope repo \
  --scopeKey github.com/example/backend \
  --workspaceKey synthetic-product \
  --query "monthly closing export review" \
  --consultReason startup

node src/cli.js agentCloseout \
  --agent codex \
  --sessionId codex:00000000-0000-0000-0000-000000000000 \
  --scope repo \
  --scopeKey github.com/example/backend \
  --trigger manual_closeout \
  --distill auto \
  --audit true \
  --dryRun true
```

`agentCloseout` requires `sessionId` or `checkpointId`; it never scans the scope
backlog by default. Durable promotion still requires the existing explicit
promotion tools or intentional auto-promotion policy.

For a bounded multi-agent routed scan, use `ingestAgentRoutedSessions`. Each
adapter keeps its own source provenance and session id prefix while writing
matched records into the same repo `scopeKey`.

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestAgentRoutedSessions \
  --adapters codex,claude_code,opencode,grok,cursor_cli \
  --codexSessionsDir ~/.codex/sessions \
  --claudeCodeProjectsDir ~/.claude/projects \
  --opencodeDb ~/.local/share/opencode/opencode.db \
  --grokSessionsDir ~/.grok/sessions \
  --cursorProjectsDir ~/.cursor/projects \
  --repoRegistry ~/.config/contextforge/repos.json \
  --sinceMinutes 1440 \
  --distill auto
```

`--watch` is supported for the multi-agent command as the default unified
router. When `--adapters` is omitted, the watcher auto-detects installed
adapters at startup by checking each adapter root or database and skips missing
runtimes instead of walking non-existent trees. Restart the service after
installing a new agent runtime so it can join the active set. Explicit
`--adapters` keeps the requested adapter in the result and reports
`missing_root` when its store is absent. JSONL-backed adapters use the shared
incremental byte cursor; OpenCode uses its SQLite store only when the configured
DB exists.

Cross-agent visibility is intentional: durable repo memory and checkpoint
handoff are read by `scopeKey`, not by the originating agent. Origin is still
preserved with `sourceAgent`, `sourceRuntime`, `sourceAdapter`,
`nativeSessionId`, and a prefixed `sessionId` such as `codex:<id>` or
`opencode:<id>`. Raw tails, working context, and closeout/audit review stay
exact-session scoped to prevent cross-agent evidence pollution.
Memory candidate and audit surfaces carry the same source provenance so users
can see which agent produced a candidate before deciding whether to promote it.

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

Watch mode is incremental by default. It stores a local-only JSON cursor under
`${XDG_STATE_HOME:-$HOME/.local/state}/contextforge/watch` so each polling
iteration reads only bytes appended after the previous successful ingest. In
remote storage mode this cursor still stays on the watcher machine; the remote
database stores raw events, checkpoints, and durable memories, not local file
offsets. Override the cursor location with `--watchStateDir <path>` or
`CONTEXTFORGE_WATCH_STATE_DIR`.

The cursor is separated by adapter, routed versus non-routed mode, source root,
and registry or scope fingerprint. Deleting the matching state file is safe:
on restart the watcher reboots from the `--sinceMinutes` discovery window and
dedupes records already present in ContextForge. Use `--watchFullScan` to
temporarily restore the older full-scan behavior for debugging or rollback.

Watch mode emits one compact JSON object per scan iteration plus a final
summary when it stops. The default log omits per-file details; pass
`--watchVerbose` to include `fileResults`. Use `--iterations N` for bounded
smoke checks or tests. Repeated watch scans do not spend model tokens while
capturing raw evidence; model usage happens only when `--distill auto` decides
to checkpoint or `--distill always` is set.

To install that Codex watch loop as a systemd user service:

```bash
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
scripts/install-codex-watch-service.sh \
  --name contextforge \
  --repo-path /path/to/repo \
  --token-env-file ~/.config/contextforge/server.env \
  --distill auto
```

The token env file should define `CONTEXTFORGE_REMOTE_TOKEN`. The installer
creates and starts a `contextforge-codex-watch-<name>.service` user unit. Use
`systemctl --user status contextforge-codex-watch-<name>.service` to inspect
logs and health.

Claude Code transcripts can be ingested with the same model:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestClaudeCodeSessions \
  --projectsDir ~/.claude/projects \
  --scope repo \
  --repoPath /path/to/repo \
  --sinceMinutes 1440 \
  --distill auto
```

For multi-repo machines, use the routed form instead:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestClaudeCodeRoutedSessions \
  --projectsDir ~/.claude/projects \
  --repoRegistry ~/.config/contextforge/repos.json \
  --sinceMinutes 1440 \
  --distill auto \
  --watch \
  --intervalMs 30000
```

Claude Code sessions are stored as `claude_code:<native-session-id>` with
`sourceAgent: "claude_code"`, `sourceRuntime: "claude_code_tui"`, and
`sourceAdapter: "claude_code_jsonl"` metadata. This lets Codex and Claude Code
share durable repo memory while keeping raw evidence and checkpoints
attributable to the originating TUI.

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
- `CONTEXTFORGE_DISTILL_MAX_EVENTS`: `80`
- `CONTEXTFORGE_DISTILL_MAX_CHARS`: `CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS`,
  which defaults to `12000`

Before the first checkpoint, `sessionStatus` recommends distillation only when
the raw character threshold is reached. The event threshold is combined with the
character threshold for diagnostics, but it does not trigger an initial
checkpoint by itself. After a checkpoint exists, the event threshold is paired
with the interval threshold, and the character threshold can trigger on its own
to avoid overrunning the provider input budget.

Checkpoint distillation uses a bounded oldest-first conversation window after
the latest checkpoint. Very large sessions are not sent to the provider as one
prompt; ContextForge selects at most `CONTEXTFORGE_DISTILL_MAX_EVENTS` and
`CONTEXTFORGE_DISTILL_MAX_CHARS` from eligible user/assistant events, then
records `sourceEventWindow` and `sourceRawEventIds` metadata on the
run/checkpoint for auditability. When a window is truncated, the next
checkpoint continues after the last selected raw id so conversation evidence is
drained sequentially rather than skipping older raw events.

If a session has a large backlog, oldest-first draining may require several
`distillCheckpoint` calls before the newest conversation turns appear in a
checkpoint. This is intentional: ContextForge favors gap-free checkpoint
chains over jumping straight to the newest tail.

Watch-mode ingestion is file-change driven, so a small raw tail can remain
after a checkpoint if the native transcript receives final events and then goes
quiet. Use `listDueDistillSessions` to inspect those catch-up candidates without
calling a provider, and `processDueDistills` to run a bounded batch:

```sh
node src/cli.js listDueDistillSessions --limit 20
node src/cli.js processDueDistills --dryRun true --limit 5
node src/cli.js processDueDistills --limit 5
```

The catch-up scanner is deliberately conservative: it uses checkpoint
`sourceRawEventIds` to continue after the last covered raw event, defaults to a
10 minute `idleMs` window to avoid active sessions, skips fresh `started`
distill runs, and only processes sessions that still satisfy the normal
distillation thresholds.

Tool output is evidence, not conversation memory. Long logs, DB dumps, and
shell output should remain in the native transcript or an explicit artifact;
checkpoints should preserve the assistant's interpreted verification facts,
commands, paths, errors, and conclusions that matter for future continuation.
Existing databases may still contain older `tool_call` or `tool_result`
`raw_events` rows. Those rows are preserved and still visible through
`listRawEvents`, but new distillation windows exclude them from
`eventsSinceLastCheckpoint`, `charsSinceLastCheckpoint`, and provider input.
The lower-level storage API intentionally remains permissive for legacy data
and tests; the public `appendRaw` API and MCP `append_raw` tool enforce the
`user`/`assistant` role boundary.

Each successful `distillCheckpoint` also updates one scoped working summary for
the session. Checkpoints remain immutable delta records for retrieval,
provenance, and memory-candidate review. The working summary is different: it
is overwritten with the latest rolling task state for live continuation and
handoff. When a previous working summary exists, the distillation provider
receives it together with the new raw-event window so it can update current
state instead of emitting a delta-only summary. Treat it as current session
state, not reviewed durable memory.

Checkpoint providers may also return an optional structured handoff payload:

```json
{
  "structured": {
    "schemaVersion": "contextforge.structured_checkpoint.v1",
    "work": {
      "intent": "What the user wanted",
      "status": "in_progress | implemented | verified | blocked | abandoned",
      "outcome": "What actually happened"
    },
    "liveState": {
      "repo": "github.com/example/contextforge",
      "branch": "feature/example",
      "headCommit": "abcdef0",
      "ciStatus": "pass | fail | pending | unknown",
      "observedAt": "2026-06-03T00:00:00Z",
      "verificationRequired": true,
      "staleReasons": ["branch, commit, and CI are mutable live state"],
      "verifyHints": ["git status --short --branch", "gh pr view 123 --json statusCheckRollup"]
    },
    "changes": [],
    "verification": [],
    "risks": [],
    "nextActions": []
  }
}
```

The structured payload is stored as `checkpoint.metadata.structured` and exposed
as `checkpoint.structured`. It is a handoff object, not durable memory. Mutable
branch, PR, commit, CI, worktree, runtime, and deployment state may appear in
`liveState`, but agents must treat it as observed state and recheck it before
acting. Memory candidates can include optional review fields such as
`durabilityReason`, `riskReason`, `evidenceRefs`, and `suggestedAction`; these
fields are preserved in the candidate index for suggestion and audit surfaces.

`bootstrapContext` includes recent checkpoint handoff separately from ordinary
query results. By default it returns the latest ordinary session checkpoint for
the requested scope in `handoff.latestCheckpoints`, even when that checkpoint
does not win semantic search ranking. Set `--latestCheckpointLimit 0` to disable
this lane, or a value up to `3` to preload more recent checkpoints per scope.
It also exposes `handoff.latestConsolidation.thread` and
`handoff.latestConsolidation.repo` when periodic checkpoint consolidation exists,
so agents can see a richer period summary without loading raw evidence by
default. For multi-repo work, pass comma-separated repo `--relatedScopeKeys` so a
subrepo can also receive the suite/root repo's latest handoff.
For configured workspace profiles, pass `--workspaceKey` to add a separate
`workspace` block with a scope plan, bounded supplemental member-scope results,
and compact per-scope memory overview. Top-level `results` remain the primary
scope view unless the caller explicitly enables primary duplication in the
workspace block.
Targeted `search` calls can also opt into the same bounded workspace federation
with `--workspaceKey`. Without `workspaceKey`, `search` keeps the legacy array
response. With `workspaceKey`, it returns `{ kind: "workspace_search", results,
workspace }`, where `results` are the primary-scope search view and
`workspace.results` are bounded supplemental member-scope results with
workspace provenance.
Bootstrap also returns a separate `memoryMap` channel for progressive durable
memory navigation. The map groups related active memories into compact clusters,
chooses a canonical `consolidatedMemory` for each cluster, and includes an
`expand_memory_cluster` hook. This lets agents orient on durable context without
loading every atomic memory, then pull details only for the cluster that matters.
The map reports embedding/vector readiness and marks confidence degraded when
embeddings are disabled, stale, pending, or failed. `memoryMap` is scoped to the
requested primary scope; shared results still appear in `results` when
`includeShared` is enabled.

When a caller knows the session id, `bootstrapContext` can also return the
working summary and a recent raw tail alongside ordinary retrieval results:

```bash
node src/cli.js bootstrapContext \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId current-session-id \
  --query "current task handoff" \
  --relatedScopeKeys github.com/example/suite \
  --rawTailLimit 5
```

`rawTailLimit` defaults to `0`, which omits raw events. Set a positive value
only when last-mile transcript continuity is needed.

The bootstrap response keeps these channels separate:

- `handoff.latestByAgent`: latest visible checkpoint per `sourceAgent`, useful
  when Codex, Claude Code, OpenCode, Grok, and Cursor CLI are all contributing
  to the same repo scope.
- `handoff.latestCheckpoints`: latest recent handoff checkpoints loaded
  independently of query ranking; read these before durable memory for current
  work status, recent decisions, open todos, branch/PR/CI flow, and next
  actions.
- `handoff.latestHandoff`: the first latest checkpoint in deterministic handoff
  order, including structured handoff payload and live-state stale warnings when
  available.
- `handoff.latestConsolidation`: latest thread and repo time-window
  consolidation checkpoints, when available; use these for period context, not
  as durable memory.
- `memoryLifecycle`: review/promotion visibility for the scope, including
  latest candidate/promoted timestamps, pending candidate counts, and recent
  candidate/promotion counts.
- `memoryMap`: compact durable-memory clusters for map-first navigation. Read
  `consolidatedMemory` first, then expand a cluster only when atomic memories
  are needed.
- `results`: durable memories, checkpoints, and memory candidates from search.
- `workingSummary`: latest rolling handoff state for the requested session.
- `rawTail`: newest raw events for last-mile continuity.

To expand one memory-map cluster:

```bash
node src/cli.js expandMemoryCluster \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --clusterId cluster:abc123def456
```

Alternatively pass `--query` and ContextForge will expand the top matching
cluster. Provenance is omitted by default; add `--includeProvenance true` only
when the evidence trail is needed. `memoryMapLimit`, `memoryMapClusterSize`, and
expand `limit` are capped at `20`; the response echoes the effective cap in
`memoryMap.limits.maxLimit`. Cluster ids are stable handles for the current
canonical durable memory, but cluster membership is recomputed from current
memory and embedding state when expanded.

For a direct lookup, use:

```bash
node src/cli.js getWorkingSummary \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId current-session-id
```

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
`retrieval` rank metadata so callers can debug why an item was returned. The
lexical tokenizer normalizes text with Unicode NFKC, recognizes Unicode letters,
numbers, and combining marks, and preserves `_./:-` for paths, APIs, and error
identifiers. This is not a language-specific morphological analyzer: Korean and
other languages use punctuation/whitespace token boundaries plus explainable
exact, prefix, and substring matching. Embeddings remain the semantic retrieval
path for inflectional or conceptual matches.

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

Summarize distillation usage for a session:

```bash
node src/cli.js distillUsage \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

`distillUsage` reports run counts, success/failure counts, selected raw-event
characters, estimated input tokens, elapsed time, and actual provider token
usage when a provider records it. For providers that expose prompt-cache
details, it also reports prompt cache hit/miss tokens and an aggregate cache
hit ratio. When actual provider usage is unavailable, `estimatedInputTokens`
uses `selectedCharCount / 4` by default. Override the estimation ratio with
`--charsPerToken`. Older runs that do not have `sourceEventWindow` metadata may
report `selectedCharCount` and `estimatedInputTokens` as `0`.

Inspect or process bounded distillation catch-up work:

```bash
node src/cli.js listDueDistillSessions --limit 20
node src/cli.js processDueDistills --dryRun true --limit 5
```

`listDueDistillSessions` is read-only. `processDueDistills` runs a small
oldest-first batch, defaults to `--limit 5`, and respects the same normal
distillation thresholds plus the default idle window.

Inspect and queue small-session candidate audits independently of distillation
thresholds:

```bash
node src/cli.js listDueCandidateAudits --scope repo --scopeKey github.com/example/contextforge --limit 20
node src/cli.js processDueCandidateAudits --scope repo --scopeKey github.com/example/contextforge --dryRun true --limit 5
node src/cli.js processDueCandidateAudits --scope repo --scopeKey github.com/example/contextforge --limit 5
```

The list call is provider-free. The process call only enqueues bounded durable
`session` audit jobs; `processJobs` performs provider work. Each row carries a
raw-event fingerprint plus checkpoint `coversTo`, and enqueue revalidates that
watermark transactionally. A late event therefore becomes a later audit epoch
instead of silently changing the source selected by the queued job. The default
idle grace is ten minutes (`CONTEXTFORGE_AUTO_PROMOTE_AUDIT_IDLE_CLOSEOUT_MS`).
The grace period is measured from the last raw event; creating the required
checkpoint or its candidates does not restart that clock.
Quiet-time inference is reported as `sourceSignal: "inferred_idle"`; it is not
an adapter terminal signal.

Run all bounded candidate lifecycle stages continuously with an explicit repo
registry:

```bash
node src/cli.js candidateLifecycleWorker \
  --repoRegistry /srv/contextforge/repos.json \
  --watch \
  --dryRun false \
  --intervalMs 60000
```

The one-shot command defaults to dry-run. The watch loop handles each canonical
scope independently and fences audit-job claims to that scope. Use
`scripts/install-candidate-lifecycle-worker-service.sh` to install the equivalent
remote-backed systemd user unit.

Snooze a pending candidate only with a finite review deadline:

```bash
node src/cli.js snoozeMemoryCandidate --scope repo --scopeKey github.com/example/contextforge \
  --candidateId candidate-id --snoozedUntil 2026-07-15T09:00:00.000Z \
  --reason "Review after rollout" --actor reviewer-id
node src/cli.js listDueCandidateWakeups --scope repo --scopeKey github.com/example/contextforge --limit 50
node src/cli.js processDueCandidateWakeups --scope repo --scopeKey github.com/example/contextforge --dryRun true
node src/cli.js processDueCandidateWakeups --scope repo --scopeKey github.com/example/contextforge --limit 50
```

The process call requires one canonical scope, invokes no provider, and uses a
candidate-status plus snooze-epoch CAS before reopening to `pending`. Manual
`wakeMemoryCandidate` can reopen early. Snooze is rejected while an audit is
`queued` or `running`, and every transition retains actor/reason provenance in
the candidate lifecycle history. To extend a snooze, wake the current epoch and
create a new finite snooze rather than changing its deadline in place. The
default maximum is 90 days; set `CONTEXTFORGE_CANDIDATE_SNOOZE_MAX_MS` to an
explicit positive millisecond limit when a different policy is required.

Inspect and process candidates that exceeded their review queue SLA:

```bash
node src/cli.js listDueCandidateStaleTransitions --scope repo --scopeKey github.com/example/contextforge --limit 50
node src/cli.js processDueCandidateStaleTransitions --scope repo --scopeKey github.com/example/contextforge --dryRun true
node src/cli.js processDueCandidateStaleTransitions --scope repo --scopeKey github.com/example/contextforge --limit 50
node src/cli.js reopenStaleMemoryCandidate --scope repo --scopeKey github.com/example/contextforge \
  --candidateId candidate-id --reason "Review resumed" --actor reviewer-id
```

The inventory is provider-free. Processing requires one explicit canonical
scope, reports per-candidate results, and CAS-fences disposition, audit state,
audit decision, and the `reviewedAt` or `createdAt` SLA anchor. Active audits
are excluded. `stale` is reversible and does not delete raw evidence or
checkpoints. Default thresholds are 14 days for deterministic triage and reject
recommendations, 90 days for approved-awaiting-promotion, and 30 days for the
other review queues. Override them with the corresponding positive millisecond
settings:

- `CONTEXTFORGE_CANDIDATE_SLA_UNAUDITED_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_TRIAGED_NO_AUDIT_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_FAILED_RETRYABLE_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_FAILED_TERMINAL_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_LEGACY_UNKNOWN_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_APPROVED_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_NEEDS_REVIEW_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_REJECT_RECOMMENDED_MS`
- `CONTEXTFORGE_CANDIDATE_SLA_AUDITED_UNKNOWN_MS`

Plan deterministic triage and provider cost before submitting any backlog
audit job:

```bash
node src/cli.js planMemoryCandidateBacklogAudit \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --limit 100 \
  --maxProviderCalls 10 \
  --charsPerToken 4 \
  --estimatedOutputTokensPerCall 250 \
  --inputUsdPerMillionTokens 2 \
  --outputUsdPerMillionTokens 8
```

This review-capability operation is provider-free and read-only. It reuses the
real audit safety rules and prompt builder, groups exact candidate duplicates,
detects exact active durable-memory matches, marks weak old candidates as stale
suggestions, excludes those stale suggestions from paid audit selection, and
reports both the next bounded batch and the full eligible
inventory. Omit the two price inputs when only call and token estimates are
needed; ContextForge does not hardcode model pricing. Supplying one price
without the other is rejected. Admin UI exposes the same plan as `감사 비용
dry-run` and does not mutate candidates.

Queue provider work durably when it must outlive the submitting request:

```bash
node src/cli.js submitDistillJob \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session

node src/cli.js processJobs --workerId worker-1 --limit 2
node src/cli.js getJob --jobId <job-id>
node src/cli.js listJobs --status failed
node src/cli.js cancelJob --jobId <queued-job-id>
```

`submitAuditJob` provides the same durable path for candidate audits and
requires a closeout `trigger` plus exactly one source: `sessionId`,
`checkpointId`, or an explicit bounded `candidateIds` backlog batch. Session
sources retain session semantics and are not reduced to the latest checkpoint.
Backlog batches are limited to one canonical scope and at most ten ids.
Submissions are idempotent for the same scoped source window and policy unless
the caller supplies `idempotencyKey`. Workers claim bounded batches, renew
leases while providers run, recover expired leases after crashes, and retry
retryable failures up to `maxAttempts`. Queued cancellation is guaranteed;
running provider calls report `running_not_interruptible` and are not
force-killed. Candidate audits are still one provider call per selected
candidate; this API does not claim true provider batching.

Use `memoryCandidateBacklog` for the review-capability, provider-free inventory
surface. It returns a cursor page, an `asOf` timestamp, and lifecycle summary
counts from the same canonical scope. See
[Memory candidate lifecycle](memory-candidate-lifecycle.md) for audit state,
immutable attempt, retry, and promotion revision rules.

Provider execution is at-least-once: a process that loses its lease may already
have incurred provider cost, but lease-attempt fencing prevents it from
committing checkpoint or audit side effects. After `maxAttempts` is exhausted,
submit a deliberately new `idempotencyKey` only after reviewing the terminal
failure; `retryFailed` does not reset an exhausted attempt budget.

Inspect or create scope/time-window checkpoint consolidation:

```bash
node src/cli.js listDueConsolidations \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --target repo \
  --windowKind daily \
  --day 2026-06-07

node src/cli.js processConsolidations \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --target repo \
  --windowKind daily \
  --day 2026-06-07 \
  --dryRun true
```

Consolidation recompresses existing session checkpoints for one thread or repo
time window. `windowKind: "daily"` uses UTC day boundaries; `windowKind:
"custom"` requires explicit `coversFrom` and `coversTo`. Consolidation reads
ordinary `source: "distill"` checkpoints as input, does not reread raw events,
does not promote durable memory by itself, and should be dry-run before
unattended scheduling.

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

If the checkpoint already contains a reviewed memory candidate, promote it by
candidate id without copying the candidate fields by hand:

```bash
node src/cli.js promoteMemoryCandidate \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --candidateId candidate-id \
  --reason "Reviewed and accepted by the maintainer."
```

The older `--checkpointId checkpoint-id --sourceCandidateIndex 0` form still
works for compatibility.

Candidate promotion performs lightweight review checks before writing durable
memory. It blocks obvious duplicate keys, identical content under another key,
near-duplicate durable memories, refinement/supersede/conflict cases that should
update an existing memory, high-sensitivity candidates, low
confidence/stability signals, and candidates whose recommendation is `ignore` or
`reject`. `importance` is clamped to the durable ranking range `0..10` before it
can affect retrieval ordering. After manual review, pass `--allowWarnings true`
to promote anyway. Already promoted or rejected candidates are protected from
accidental re-review; pass `--allowStatusOverride true` only for explicit repair
work.

Promotion is intentional: checkpoints can suggest memory candidates, but durable
memory is written only when a caller promotes a reviewed fact or decision.
Candidate review, correction, and deactivation use separate commands so durable
memory changes remain auditable:

```bash
node src/cli.js listMemoryCandidates \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session \
  --status pending \
  --candidateType project_policy \
  --promotionRecommendation promote \
  --sort recommendation \
  --limit 20

node src/cli.js rejectMemoryCandidate \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --candidateId candidate-id \
  --reason "Too temporary for durable memory."

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

When a candidate overlaps existing durable memory, prefer an update proposal
over a new memory. `suggestMemoryPromotions --createUpdateCandidates true` can
persist `memory_update_candidates` for refinement/supersede/conflict cases. To
dry-run and then persist routing for an existing audited-approved backlog:

```bash
node src/cli.js routeAuditedMemoryCandidates \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --limit 25

node src/cli.js routeAuditedMemoryCandidates \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --candidateIds candidate-a,candidate-b \
  --dryRun false
```

The operation never promotes durable memory. Duplicate routes create no new
memory; refinement/supersede/conflict routes create idempotent review-only
update candidates. Applying, rejecting, or skipping a routed update also closes
the linked source candidate as promoted, rejected, or stale respectively.

To
find existing duplicate durable memories without promoting anything, run:

```bash
node src/cli.js auditMemoryDuplicates \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --minOverlap 0.82 \
  --scanLimit 250 \
  --limit 20
```

Add `--createUpdateCandidates true` to persist reviewed
`merge_duplicate_memories` proposals; applying them is still a separate approval
step. Duplicate auditing compares memory pairs inside the scanned window, so use
`--scanLimit` deliberately for large scopes.

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
- `sync_resume_context`
- `search`
- `get_memory`
- `remember`
- `list_memory_events`
- `list_memory_candidates`
- `list_memory_update_candidates`
- `audit_memory_duplicates`
- `append_raw`
- `prune_raw_events`
- `distill_checkpoint`
- `submit_distill_job`
- `submit_audit_job`
- `get_job`
- `list_jobs`
- `process_jobs`
- `cancel_job`
- `distill_usage`
- `list_due_distill_sessions`
- `process_due_distills`
- `list_due_consolidations`
- `process_consolidations`
- `suggest_memory_promotions`
- `audit_memory_candidates`
- `auto_promote_memory_candidates`
- `reconcile_memory`
- `promote_memory`
- `promote_memory_candidate`
- `reject_memory_candidate`
- `correct_memory`
- `deactivate_memory`
- `embedding_inventory`
- `prune_embedding_artifacts`
- `process_embedding_jobs`
- `list_embedding_jobs`
- `rebuild_embeddings`

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
`repoPath` takes precedence when both are provided. For cross-machine
consistency, treat `scopeKey` as the canonical repo memory key and pass an
explicit normalized GitHub key such as `github.com/example/contextforge` when a
checkout has no useful remote, points at a fork, or may live at different local
paths.

Agents should use `search` for scoped retrieval on demand, call `get_memory`
only when they know the durable key they need, append raw evidence for later
distillation, and call `remember` when the user or agent intentionally decides
that an important fact, preference, decision, or runbook note should become
durable memory. Use `promote_memory` only after a checkpoint candidate or
decision has been reviewed, or `promote_memory_candidate` when promoting a
reviewed candidate directly by candidate id. Use
`correct_memory` to preserve the previous value while changing a durable key,
and `deactivate_memory` to remove stale memories from retrieval without
deleting their history. `distill_checkpoint` returns `memoryCandidateCount`,
and `session_status` reports `latestCheckpointMemoryCandidateCount`; agents
should call `list_memory_candidates` when either count is greater than zero.

For agent runtime workflow guidance, use the installed `contextforge-memory`
skill. It is written as an agent-neutral reusable guide for ContextForge MCP
startup, storage authority, scopes, resume/handoff, session IDs, evidence
capture, distillation, checkpoint candidates, closeout promotion, correction,
and embedding maintenance. The ContextForge repo source package is
[docs/skills/contextforge-memory/SKILL.md](skills/contextforge-memory/SKILL.md);
agent-specific systems should install or update that skill through their normal
runtime skill installer. See
[Installing The contextforge-memory Skill](skills/contextforge-memory/INSTALL.md).

For copyable prompt or `AGENTS.md` snippets, see
[ContextForge Agent Instruction Snippets](agent-instructions.md). For
rules about what belongs in a repository `AGENTS.md`, see the
[AGENTS.md Authoring Guide](agents-md-guide.md). Keep repository
`AGENTS.md` files short: include only the local operating contract, a small
ContextForge bootstrap snippet, the critical session invariant, and a direction
to use the installed `contextforge-memory` skill instead of copying every MCP
rule into each project.
If a checkout is also a live server or remote client, include a short
secret-free runtime mode section that tells agents to inspect env/config and
live process state instead of assuming the clone is the server. Link to
[ContextForge Runtime Modes](runtime-modes.md).
For downstream repositories that consume an external ContextForge service,
state the expected connection mode and storage authority directly in
`AGENTS.md`; sandboxed agents may not be able to inspect the ContextForge
server's env files, service manager, or local database. When available, use
`db_info` or `bootstrap_context` `connection.summary` or `connection.accessMode`
as the live access-path check.
For loose continuation prompts like "yesterday", "continue", "previous work",
issue/PR follow-up, context compaction, or cross-agent handoff, agents should
call `bootstrap_context` or `bootstrapContext` early with an explicit
`consultReason` such as `resume`, `compaction_recovery`, or `agent_switch`.
The bootstrap response includes `handoff.latestCheckpoints` independently of
search ranking, then reviews repo-scoped `memory`, `checkpoint`, and
`memory_candidate` hits as context candidates, optionally includes up to three
shared-scope hits, exposes `handoff.latestConsolidation` for thread/repo period
context when available, and reports `memoryLifecycle` so agents can notice
stale or missing candidate/promotion flow. It then reminds the agent to verify
current branch, issue/PR, CI, migration, and runtime state against live sources
before acting. Only for startup, resume, compaction recovery, or agent switch,
agents should read latest checkpoints and consolidation before durable memory
for fast-moving work status; durable memory remains the stable
policy/contract/runbook layer. Legacy calls that omit `consultReason` are
treated as `unknown`: latest handoff is still returned for compatibility, but
the response warns callers to pass an explicit reason.

Inside the same uninterrupted active session, current conversation context is
the source for current intent. Do not call `bootstrap_context` merely to
re-confirm what was just discussed. Use targeted `search` for file/API/error or
domain lookups, and use `db_info`, SQL, git, GitHub, health checks, or service
manager state for mutable runtime facts.

When resuming a known session, pass `sessionId` to `bootstrap_context` or
`bootstrapContext`. ContextForge will include the session's latest
`workingSummary` separately from search results so agents can see current task
state without treating it as canonical memory.

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

- `CONTEXTFORGE_PROVIDER_CONCURRENCY_LIMIT`: maximum concurrent tasks for each
  provider name across ContextForge instances in one Node.js process. Distill
  and candidate-audit calls share the same provider bucket. Default: `2`.
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

Auto-promotion audit runner variables are intentionally separate from the
distillation runner:

- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED`: set to `false` to disable the
  audit gate and rely only on local strict checks. Default: enabled.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER`: `codex_exec` or
  `codex_sdk_python`.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_COMMAND`: Codex executable for the
  audit runner. Defaults to `CONTEXTFORGE_CODEX_EXEC_COMMAND` or `codex`.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN`: Codex binary used by the
  `codex_sdk_python` provider. Defaults to the audit command.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND`: Python executable for the
  `codex_sdk_python` runner. Default: `python3`.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH`: optional target directory
  containing the Codex Python SDK and dependencies.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_MODEL`: audit model. Default:
  `gpt-5.5`.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_REASONING_EFFORT`: audit reasoning
  effort. Default: `low`.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_SANDBOX`: sandbox for the audit
  runner. Default: `read-only`.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_TIMEOUT_MS`: audit timeout. Default:
  `120000`.

Failure modes are preserved as distillation runs. If `codex exec` exits
non-zero, times out, or returns malformed JSON, ContextForge records a failed
`distill_runs` row and leaves raw events untouched for retry or debugging.
Provider failures record whether they are retryable. Same-session concurrent
distill retries share one in-flight run, and candidate audit retries are
serialized by closeout source so one provider result produces one metadata
write. These fast-path guards are process-local. For work that must survive a
client disconnect or server restart, use the durable operation-job API below.

Remote long-running calls send their client timeout to the canonical server.
When a configured provider timeout is not shorter than that client timeout,
the server prevents provider execution and surfaces an explicit timeout-contract
error or candidate-audit status. Increase
`CONTEXTFORGE_REMOTE_TIMEOUT_MS` or lower the relevant provider timeout instead
of allowing a client to abandon a still-running synchronous task.
`submitDistillJob` and `submitAuditJob` only persist queued work, so a
submit-only client does not need to cover provider execution. The server-side
`processJobs` worker does. See the
[environment-specific timeout table](operations.md#timeout-requirements-by-environment).
Failed and successful runs include provider prompt/schema version metadata so
operators can tell which prompt contract produced the result.

## OpenAI-Compatible Provider

Use `openai_compatible` for DeepSeek or another Chat Completions-compatible
provider:

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

DeepSeek is configured as the first built-in template. As of 2026-05-14, the
official DeepSeek docs list `https://api.deepseek.com` as the OpenAI-compatible
base URL, `deepseek-v4-flash` and `deepseek-v4-pro` as current V4 model ids, and
JSON output via `response_format: {"type":"json_object"}`. The provider still
validates the returned checkpoint JSON locally and records failed runs without
deleting raw evidence.

`CONTEXTFORGE_OPENAI_COMPATIBLE_RESPONSE_FORMAT` defaults to `json_object`.
When set to `json_schema`, ContextForge sends a strict-safe subset of the
checkpoint schema with `strict: true`: object schemas use
`additionalProperties: false`, all properties are listed in `required`, optional
values are represented with nullable union types, and type-specific validation
keywords unsupported by strict structured-output implementations are omitted.
Local validation still runs after the provider response is parsed.

## Public Repo Hygiene

- Runtime state lives under `.contextforge/` by default and is ignored by git.
- SQLite database files and sidecars are ignored.
- Examples and tests use synthetic data only.
- ContextForge does not require a private workspace or external agent runtime.

## Status

0.5.1 runtime. The current implementation includes SQLite migrations, scoped
durable memories, raw event capture, rolling working summaries, checkpoint
distillation with `mock`, `codex_exec`, and `openai_compatible` providers,
remote HTTP mode for server-backed canonical memory, an operator UI, stdio and
Streamable HTTP MCP, explainable hybrid retrieval, embedding job processing,
bounded distillation catch-up, closeout promotion review, audited strict safe
auto-promotion controls, and memory reconciliation for user corrections.
Further provider adapters and large-store performance hardening remain future
work.
