# ContextForge Runtime Modes

Use this guide before changing deployment, MCP registration, or storage
configuration. The first decision is the agent's role in the runtime topology:

- local all-in-one
- this checkout is the HTTP server
- this checkout is only a client of an external remote server

Do not mix setup commands from different modes in one change unless the user is
explicitly migrating between them.

## MCP Surface Selection

The stdio and HTTP MCP transports use the same profile resolver. The default
`agent-core` profile exposes 24 normal agent tools and hides queue workers,
retention, embedding maintenance, usage inspection, and workspace mutations.
Use `review` for candidate review, `operator` for server maintenance,
`workspace-admin` for workspace topology, or `all` for compatibility with the
former full surface plus newly added tools.

`migrate_scope` belongs to both `operator` and `workspace-admin`: it is storage
maintenance as well as workspace lifecycle work. Other workspace mutations are
excluded from `operator`.

Configure the HTTP server with `CONTEXTFORGE_MCP_PROFILE` or an exact
comma-separated `CONTEXTFORGE_MCP_TOOLS` allowlist. Configure direct stdio with
the same environment variables or `node src/mcp.js --profile <name>` /
`--tools <names>`. `node src/cli.js serve` also accepts `--mcpProfile` and
`--mcpTools`. Explicit allowlists override profiles. Unknown values fail during
startup rather than silently exposing a different surface.

Use `node src/mcp.js --describe-surface` to inspect exact enabled/disabled tool
names and context-size measurements before changing a client registration. If
an existing client loses a tool after upgrade, first select the narrow profile
that owns it; use `all` only as a temporary compatibility bridge. The packaged
`contextforge-memory` skill carries detailed workflows, but server startup and
profile selection do not require the skill to exist on the host.

## Quick Decision

Use local all-in-one when one machine owns its own memory and no other machine
needs to share it.

Use HTTP server mode when this checkout or host is supposed to own canonical
memory and expose ContextForge through `/mcp`, `/v0/*`, `/healthz`, `/readyz`,
and authenticated `/metrics`.

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
- On POSIX, ContextForge automatically repairs the data directory to `0700` and
  the SQLite database plus existing rollback-journal/WAL/SHM sidecars to `0600`.
  On Windows, `dbInfo.permissions.reason` is `windows_acl_inherited`; use a
  private parent directory ACL because POSIX mode enforcement is unavailable.
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
- `/healthz` is liveness; `/readyz` is DB/schema/disk/queue readiness.
- `/metrics` is an authenticated Prometheus endpoint.
- `/mcp` is the Streamable HTTP MCP endpoint.
- `/v0/*` is the JSON remote API.
- Binding to a non-loopback host requires `CONTEXTFORGE_REMOTE_TOKEN`.
- Public internet exposure should go through HTTPS reverse proxy when possible.
- The operator UI cookie defaults to `CONTEXTFORGE_ADMIN_COOKIE_SECURE=auto`.
  In this mode, direct HTTP access receives a non-`Secure` cookie. Forwarded
  headers are ignored unless the socket peer matches `CONTEXTFORGE_TRUST_PROXY`.
  Configure a comma-separated proxy IP/CIDR list, or `loopback` for a local
  proxy, before relying on `X-Forwarded-Proto` or `X-Forwarded-For`. The special
  value `true` trusts every direct peer and is safe only when the server cannot
  be reached except through a proxy that overwrites client-supplied forwarded
  headers. If Node terminates TLS directly, set
  `CONTEXTFORGE_ADMIN_COOKIE_SECURE=true` instead.
- Failed admin-login keys expire across the whole in-memory map and are capped
  by `CONTEXTFORGE_ADMIN_LOGIN_MAX_KEYS` (default `10000`). When the cap is full,
  new keys fail closed with HTTP 429 until an entry expires.

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
- Run `node src/cli.js processJobs --workerId <stable-name>` from a supervised
  server-side worker or timer when clients use `submitDistillJob` or
  `submitAuditJob`. Submission only writes a durable queued row; it does not
  execute provider work inside the client request. Worker leases are renewed
  while calls run and expired leases are recovered after crashes. Provider
  execution is at-least-once, so a lost lease can still incur duplicate provider
  cost; lease-owner plus attempt fencing prevents stale workers from committing
  checkpoint or audit writes.
- Queued jobs can be cancelled. Running provider calls are intentionally not
  force-cancelled; stop accepting new work and let the lease/result settle
  before maintenance when graceful cancellation is required.
- `retryFailed` does not reset an exhausted `maxAttempts` budget. Review the
  terminal failure and submit a deliberate new `idempotencyKey` only when a new
  execution is warranted.
- Prefer `CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY` over DB-backed runtime
  secrets. SQLite stores runtime secrets as plaintext; new DB-backed secret
  writes require the explicit
  `CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS=true` opt-in and existing stored
  values remain visible through a warning until cleared.
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
- Workspace profiles are also server-owned in remote mode. Workspace profile
  read/write/resolve calls must hit the remote canonical server; they must not
  silently fall back to local or project-local storage.
- There is no automatic offline cache or fallback write. If the remote is
  unavailable, the operation should fail visibly.
- Distillation runs server-side in remote mode, so distillation and embedding
  provider configuration usually belong on the server.
- `repoPath` and `cwd` are still useful locally because they help resolve the
  right repo scope key before sending the request.

Workspace profiles are independent from runtime mode. A profile only decides
which existing scopes are consulted together; storage mode still decides where
those scopes are authoritative. Remote mode plus workspace profiles is the
recommended topology for users who work across several machines and several
repositories.

When `bootstrap_context` is called with a `workspaceKey`, workspace resolution
and supplemental retrieval must use the same storage authority as the caller.
In remote client mode, the workspace profile, member scopes, routing rules, and
retrieval all go through the remote canonical server. The response keeps
primary-scope results at top level and returns bounded cross-repo results in a
separate `workspace` block.

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
- Use `connection.summary` or `connection.accessMode` from `db_info` or
  `bootstrap_context` when present. `accessMode` is `direct-local`,
  `server-process`, or `remote-client`.
- Treat local `.contextforge/` state as relevant only for local/project-local
  modes.
```

## Agent Guidance

At task start, agents should identify which mode they are in before making
storage or deployment claims:

1. Inspect declared repo guidance, then `db_info` or `bootstrap_context`
   `connection.summary` or `connection.accessMode` when available.
2. Check whether this process is talking to local/project-local storage or a
   remote server.
3. If operating a server, verify `/healthz` and recent server logs before
   claiming the runtime is healthy.
4. If acting as a remote client, verify the configured remote URL instead of
   local SQLite state.
5. For memory retrieval, still use the normal ContextForge trust model:
   `memory` is reviewed durable state, `checkpoint` is credible recent handoff
   state, and `memory_candidate` is review material.
