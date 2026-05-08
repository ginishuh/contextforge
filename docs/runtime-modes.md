# ContextForge Runtime Modes

Use this guide before changing deployment, MCP registration, or storage
configuration. The first decision is the agent's role in the runtime topology:

- local all-in-one
- this checkout is the HTTP server
- this checkout is only a client of an external remote server

Do not mix setup commands from different modes in one change unless the user is
explicitly migrating between them.

## Quick Decision

Use local all-in-one when one machine owns its own memory and no other machine
needs to share it.

Use HTTP server mode when this checkout or host is supposed to own canonical
memory and expose ContextForge through `/mcp`, `/v0/*`, and `/healthz`.

Use external remote client mode when another ContextForge server owns canonical
memory and this checkout only reads/writes through `CONTEXTFORGE_REMOTE_URL`.

## Local All-In-One

In this mode, the agent, CLI/MCP process, SQLite database, raw evidence,
checkpoints, and durable memories all live on the same machine.

Use this mode for:

- single-machine development
- repo-local experiments
- smoke tests
- private local memory that should not follow the user to other machines

Configuration:

```bash
CONTEXTFORGE_STORAGE_MODE=project-local
```

or:

```bash
CONTEXTFORGE_STORAGE_MODE=local
```

Meaning:

- `project-local` stores data under the checkout's `.contextforge/` directory.
- `local` stores data under the user's home-directory ContextForge store.
- Do not set `CONTEXTFORGE_REMOTE_URL`.
- No HTTP server or bearer token is required.
- Local stdio MCP can run with `contextforge-mcp` or `node src/mcp.js`.
- Distillation and embeddings run in the local process, so provider
  credentials belong in that local process environment.

Useful checks:

```bash
node src/cli.js dbInfo
npm test
```

Safety:

- Treat retrieval as machine-local context unless the user says this store is
  authoritative.
- Do not make cross-machine or deployment claims from local-only state.
- Never commit `.contextforge/`, `.db`, `.db-wal`, `.db-shm`, raw logs, or env
  files.

## This Checkout Is The HTTP Server

In this mode, this host owns canonical ContextForge state and exposes it over
HTTP. Clients may connect through Streamable HTTP MCP at `/mcp` or the JSON API
under `/v0/*`.

Use this mode for:

- a VPS or shared host that should be the memory source of truth
- multi-machine agents that need one canonical repo/shared memory store
- server-side distillation and embedding processing

Server configuration:

```bash
CONTEXTFORGE_REMOTE_HOST=127.0.0.1
CONTEXTFORGE_REMOTE_PORT=8765
CONTEXTFORGE_REMOTE_TOKEN=change-me
CONTEXTFORGE_SERVER_STORAGE_MODE=local
```

Start the server:

```bash
node src/server.js
```

or:

```bash
node src/cli.js serve --host 127.0.0.1 --port 8765
```

Meaning:

- `CONTEXTFORGE_SERVER_STORAGE_MODE` controls the server's own storage backend.
- If `CONTEXTFORGE_SERVER_STORAGE_MODE` is omitted, the server coerces remote
  client-style configuration into a local server store instead of recursively
  calling another remote.
- `/healthz` is the health endpoint.
- `/mcp` is the Streamable HTTP MCP endpoint.
- `/v0/*` is the JSON remote API.
- Binding to a non-loopback host requires `CONTEXTFORGE_REMOTE_TOKEN`.
- Public internet exposure should go through HTTPS reverse proxy when possible.

Useful checks:

```bash
curl -fsS http://127.0.0.1:8765/healthz
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=http://127.0.0.1:8765 \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js dbInfo
```

Safety:

- Server-side provider credentials belong on the server, not in client repos.
- Treat `CONTEXTFORGE_REMOTE_TOKEN` as an administrator credential.
- Back up the server-owned SQLite store before risky migrations or destructive
  retention changes.
- Do not point git at live SQLite or raw runtime data.

## External Remote Client

In this mode, another ContextForge HTTP server owns canonical state. This
checkout is only a client.

Use this mode for:

- developer machines connected to a VPS memory server
- CI or agent runners that should share repo memory
- local stdio MCP processes that delegate reads/writes to a remote server

Client configuration:

```bash
CONTEXTFORGE_STORAGE_MODE=remote
CONTEXTFORGE_REMOTE_URL=https://memory.example.com
CONTEXTFORGE_REMOTE_TOKEN=change-me
```

Meaning:

- The client delegates core calls to `CONTEXTFORGE_REMOTE_URL`.
- The remote server owns reads and writes for `shared`, `repo`, and `local`
  scopes.
- There is no automatic offline cache or fallback write. If the remote is
  unavailable, the operation should fail visibly.
- Distillation runs server-side in remote mode, so distillation and embedding
  provider configuration usually belong on the server.
- `repoPath` and `cwd` are still useful locally because they help resolve the
  right repo scope key before sending the request.

Useful checks:

```bash
curl -fsS https://memory.example.com/healthz
CONTEXTFORGE_STORAGE_MODE=remote \
CONTEXTFORGE_REMOTE_URL=https://memory.example.com \
CONTEXTFORGE_REMOTE_TOKEN=change-me \
node src/cli.js dbInfo
```

Safety:

- Do not start a local HTTP server unless the user is intentionally operating
  the server host.
- Do not infer canonical state from a local `.contextforge/` directory while in
  remote client mode.
- Pass explicit `scopeKey` values such as `github.com/owner/repo` when local
  paths, forks, or runner checkouts may differ across machines.

Downstream `AGENTS.md` snippet:

```text
## ContextForge Memory

This repo uses ContextForge as an external remote memory service.

- Connection mode: external remote client.
- Storage authority: remote canonical ContextForge.
- Agents may be sandboxed and may not be able to inspect the ContextForge
  server env files, service manager, or local database.
- Use the installed `contextforge-memory` skill.
- At task start, call `bootstrap_context` with this repo's canonical scope key:
  `github.com/owner/repo`.
- Use `db_info` or the storage block returned by `bootstrap_context` only to
  inspect the connected ContextForge process. Remote MCP endpoints may report
  the server's own storage as `local`; that does not mean this repo is
  local-only.
- Prefer `connection.mode` when present. `remote-client` means this repo is
  delegating to a remote server; `http-server` means the tool is running on the
  server process itself; `direct-local` means a local ContextForge process is
  answering.
- Do not infer runtime mode from local `.contextforge/` files in this checkout.
```

## Agent Guidance

At task start, agents should identify which mode they are in before making
storage or deployment claims:

1. Inspect declared repo guidance, then `db_info` or `bootstrap_context`
   `connection.mode` when available.
2. Check whether this process is talking to local/project-local storage or a
   remote server. Do not use server `storageMode: local` by itself to conclude
   that a downstream repo is local-only.
3. If operating a server, verify `/healthz` and recent server logs before
   claiming the runtime is healthy.
4. If acting as a remote client, verify the configured remote URL instead of
   local SQLite state.
5. For memory retrieval, still use the normal ContextForge trust model:
   `memory` is reviewed durable state, `checkpoint` is credible recent handoff
   state, and `memory_candidate` is review material.
