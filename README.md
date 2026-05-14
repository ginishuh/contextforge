# ContextForge

Self-hosted memory and distillation runtime for coding agents.

This is not another memory file. ContextForge is a scoped memory runtime for
coding agents.

![ContextForge explainer comic](docs/assets/contextforge-explainer-comic-en.jpg)

[Korean version of the explainer comic](docs/assets/contextforge-explainer-comic-ko.jpg)

ContextForge is designed for agents that need canonical project memory, scoped
retrieval, evidence-preserving raw logs, and LLM-backed distillation into
checkpoints.

ContextForge is a sidecar memory runtime. It complements existing agent memory
systems by providing canonical project/repo memory, evidence retention, and
LLM-backed distillation.

Current 0.3.x builds add remote-first MCP workflows, start/resume handoff
tools, closeout memory promotion review, correction reconciliation, hybrid
retrieval, and an embedding job queue so vector indexing can recover
independently from memory or checkpoint writes.

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

ContextForge starts project-local for zero-friction setup, but remote mode is a
first-class canonical deployment model for users who work from multiple machines
or want several agents to share the same source of truth. Set
`CONTEXTFORGE_STORAGE_MODE=local` to use home-directory storage, or
`CONTEXTFORGE_STORAGE_MODE=remote` with `CONTEXTFORGE_REMOTE_URL` to use a
server-backed store.

See [docs/architecture.md](docs/architecture.md) for the full product model and
[docs/roadmap.md](docs/roadmap.md) for the implementation roadmap. For the
operator-facing distinction between local all-in-one, HTTP server, and external
remote client roles, see [ContextForge Runtime Modes](docs/runtime-modes.md).

## Distillation

ContextForge assumes useful checkpoints need an LLM. The runtime should support
bring-your-own distillation providers, such as:

- `codex_exec`
- `claude_code_exec`
- direct model APIs
- local model runners

The current implementation ships with a deterministic `mock` provider and a
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

Repo scope keys default to the current git checkout when possible. `repoPath`
and `cwd` locate the local checkout; they are not the canonical repo identity.
ContextForge normalizes common GitHub origin remotes to `github.com/owner/repo`,
so different local paths can share the same repo memory when they point to the
same GitHub repo. Outside a git checkout it falls back to a deterministic
`path:<hash>:<name>` key. Pass `--scopeKey` or set
`CONTEXTFORGE_DEFAULT_SCOPE_KEY` when you want an explicit canonical scope key.

## Usage Modes

ContextForge supports two common deployment modes. Choose one first; mixing the
setup commands is the most common source of confusion.

- Use **local-only mode** for one machine with its own private memory.
- Use **HTTP remote mode** when memory must follow the same repo across
  different PCs or agent environments.

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

1. Install Node.js 20 or newer and git. Install a reverse proxy such as nginx
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
# Optional admin UI login. Generate a PBKDF2 value with the documented helper or
# leave unset to disable password login and use bearer-token API access only.
CONTEXTFORGE_ADMIN_USER=admin
CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2=310000:saltHex:hashHex
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

Use a long random token and store the same value on client machines as
`CONTEXTFORGE_REMOTE_TOKEN`. Treat this token as an administrator credential:
it can call every remote API method, including pruning raw evidence and running
provider health checks. Do not put this file in git.

The HTTP server also serves an operator UI at `/ui/`. The UI can inspect
runtime/storage state, update DB-backed runtime settings, select `codex_exec` or
OpenAI-compatible distillation, tune distillation thresholds, review memory
candidates, promote candidates manually, correct durable memories, and
deactivate wrong memories with provenance. Runtime settings saved in the UI
override env defaults for new calls without restarting the server. API keys are
write-only in the UI/API: callers can set, replace, clear, and test them, but
stored values are never returned.

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
```

6. Choose how clients reach the server.

For a public internet endpoint, put HTTPS in front of the local server. A
minimal nginx location is:

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

For machines that use several repositories, prefer one ingest router per agent
adapter over one watcher per repository. A `codex` router scans the global
Codex sessions tree once; a `claude_code` router does the same for Claude
Code's transcript store. Each router matches file metadata such as `cwd`
against a repo registry and writes to the matched repo's canonical `scopeKey`.

Example repo registry:

```json
{
  "repos": [
    {
      "name": "suite",
      "repoPath": "/home/ginis/wastelite-suite",
      "scopeKey": "github.com/ginishuh-dev/wastelite-suite",
      "adapters": ["codex"]
    },
    {
      "name": "frontend",
      "repoPath": "/home/ginis/wastelite-suite/wastelite_frontend",
      "scopeKey": "github.com/ginishuh-dev/wastelite_frontend",
      "adapters": ["codex"]
    }
  ]
}
```

Run the `codex` agent router once:

```bash
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js ingestCodexRoutedSessions \
  --sessionsDir ~/.codex/sessions \
  --repoRegistry ~/.config/contextforge/repos.json \
  --sinceMinutes 1440 \
  --distill auto \
  --watch \
  --intervalMs 30000
```

Nested repo paths are matched by most-specific path first. Unknown `cwd` values
are skipped by default; the router does not silently write unmatched sessions to
`shared` or `local` memory. Each routed file result logs the matched repo name,
repo path, and `scopeKey`, or a skipped reason such as `unmatched_repo_cwd`.

Install the `codex` agent router as a systemd user service:

```bash
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
scripts/install-codex-router-service.sh \
  --name codex \
  --repo-registry ~/.config/contextforge/repos.json \
  --token-env-file ~/.config/contextforge/server.env \
  --distill auto
```

Install the `claude_code` agent router as a systemd user service:

```bash
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
scripts/install-claude-code-router-service.sh \
  --name claude-code \
  --repo-registry ~/.config/contextforge/repos.json \
  --token-env-file ~/.config/contextforge/server.env \
  --distill auto
```

The older repo-specific watcher remains supported for simple single-repo
setups, but one router per agent adapter is the recommended operating shape for
suite-style workspaces and other multi-repo environments.

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

When a caller knows the session id, `bootstrapContext` can return the working
summary and a recent raw tail alongside ordinary retrieval results:

```bash
node src/cli.js bootstrapContext \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId current-session-id \
  --query "current task handoff" \
  --rawTailLimit 5
```

`rawTailLimit` defaults to `0`, which omits raw events. Set a positive value
only when last-mile transcript continuity is needed.

The bootstrap response keeps these channels separate:

- `results`: durable memories, checkpoints, and memory candidates from search.
- `workingSummary`: latest rolling handoff state for the requested session.
- `rawTail`: newest raw events for last-mile continuity.

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

Summarize distillation usage for a session:

```bash
node src/cli.js distillUsage \
  --scope repo \
  --scopeKey github.com/example/contextforge \
  --sessionId demo-session
```

`distillUsage` reports run counts, success/failure counts, selected raw-event
characters, estimated input tokens, elapsed time, and actual provider token
usage when a provider records it. When actual provider usage is unavailable,
`estimatedInputTokens` uses `selectedCharCount / 4` by default. Override the
estimation ratio with `--charsPerToken`. Older runs that do not have
`sourceEventWindow` metadata may report `selectedCharCount` and
`estimatedInputTokens` as `0`.

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
high-sensitivity candidates, low confidence/stability signals, and candidates
whose recommendation is `ignore` or `reject`. After manual review, pass
`--allowWarnings true` to promote anyway. Already promoted or rejected
candidates are protected from accidental re-review; pass
`--allowStatusOverride true` only for explicit repair work.

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
- `append_raw`
- `prune_raw_events`
- `distill_checkpoint`
- `distill_usage`
- `suggest_memory_promotions`
- `auto_promote_memory_candidates`
- `reconcile_memory`
- `promote_memory`
- `promote_memory_candidate`
- `reject_memory_candidate`
- `correct_memory`
- `deactivate_memory`
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
[docs/skills/contextforge-memory/SKILL.md](docs/skills/contextforge-memory/SKILL.md);
agent-specific systems should install or update that skill through their normal
runtime skill installer. See
[Installing The contextforge-memory Skill](docs/skills/contextforge-memory/INSTALL.md).

For copyable prompt or `AGENTS.md` snippets, see
[ContextForge Agent Instruction Snippets](docs/agent-instructions.md). For
rules about what belongs in a repository `AGENTS.md`, see the
[AGENTS.md Authoring Guide](docs/agents-md-guide.md). Keep repository
`AGENTS.md` files short: include only the local operating contract, a small
ContextForge bootstrap snippet, the critical session invariant, and a direction
to use the installed `contextforge-memory` skill instead of copying every MCP
rule into each project.
If a checkout is also a live server or remote client, include a short
secret-free runtime mode section that tells agents to inspect env/config and
live process state instead of assuming the clone is the server. Link to
[ContextForge Runtime Modes](docs/runtime-modes.md).
For downstream repositories that consume an external ContextForge service,
state the expected connection mode and storage authority directly in
`AGENTS.md`; sandboxed agents may not be able to inspect the ContextForge
server's env files, service manager, or local database. When available, use
`db_info` or `bootstrap_context` `connection.summary` or `connection.accessMode`
as the live access-path check.
For loose continuation prompts like "yesterday", "continue", "previous work",
issue/PR follow-up, or cross-agent handoff, agents should call
`bootstrap_context` or `bootstrapContext` early. The bootstrap response reviews
repo-scoped `memory`, `checkpoint`, and `memory_candidate` hits as context
candidates, optionally includes up to three shared-scope hits, then reminds the
agent to verify current branch, issue/PR, CI, migration, and runtime state
against live sources before acting.

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
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER`: currently `codex_exec`.
- `CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_COMMAND`: Codex executable for the
  audit runner. Defaults to `CONTEXTFORGE_CODEX_EXEC_COMMAND` or `codex`.
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

## Public Repo Hygiene

- Runtime state lives under `.contextforge/` by default and is ignored by git.
- SQLite database files and sidecars are ignored.
- Examples and tests use synthetic data only.
- ContextForge does not require a private workspace or external agent runtime.

## Status

0.3.x runtime. The current implementation includes SQLite migrations, scoped
durable memories, raw event capture, rolling working summaries, checkpoint
distillation with `mock` and `codex_exec` providers, remote HTTP mode for
server-backed canonical memory, stdio and Streamable HTTP MCP, explainable
hybrid retrieval, embedding job processing, closeout promotion review, strict
safe auto-promotion controls, and memory reconciliation for user corrections.
Additional distillation providers and large-store performance hardening remain
future work.
