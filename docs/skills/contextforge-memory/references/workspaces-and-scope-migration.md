# Workspaces, Scope Migration, And Storage Authority

Read this reference when configuring multi-repo retrieval, diagnosing storage
authority, or renaming or transferring a repository scope.

## Contents

- [Workspace Routing](#workspace-routing)
- [Repository Aliases And Scope Migration](#repository-aliases-and-scope-migration)
- [Connection Diagnostics](#connection-diagnostics)

## Workspace Routing

Workspace profiles are retrieval topology, not storage authority. Storage modes
answer where memory is authoritative; workspace profiles answer which existing
scopes are consulted together. They are independent.

Workspace selection is explicit per call. ContextForge does not infer a
workspace from the current repo scope or workspace membership, and creating a
profile does not activate federation by itself. There is no process-global
default workspace. The caller must pass the intended `workspaceKey` to relevant
MCP calls such as `resolve_workspace`, `bootstrap_context`, and `search`. Core
callers use `resolveWorkspace`; the corresponding CLI command is
`workspaceResolve`. `bootstrapContext`, `search`, and `agentStart` also accept
the option on their core/CLI surfaces. For repeated use, record it in repo-local
agent instructions or an adapter/wrapper configuration. Without `workspaceKey`,
retrieval keeps its ordinary single-repo behavior.

For multi-repo products, call `resolve_workspace` when a workspace profile is
configured and the task may involve cross-repo contracts, frontend consumers,
E2E, release gates, or shared API/domain decisions. Read the scope plan before
using cross-repo context. Treat `includedBecause`, matched rules, and warnings
as part of the retrieval explanation. During startup/resume, callers may pass
`workspaceKey` to `bootstrap_context` to receive a separate `workspace` block
with bounded supplemental member-scope results. Top-level `includeShared=true`
adds shared memory to the primary bootstrap view only; workspace shared results
require a workspace routing rule with `includeShared`.

In remote mode, workspace profile reads/writes/resolve calls must hit the
remote canonical server. There is no silent local/project-local fallback.
Workspace profiles should store canonical scope identity only, not local
`repoPath`, tokens, raw transcripts, or machine-private paths.

Treat `includeByDefault` as scope-plan inclusion only. It does not justify
unbounded retrieval from that scope; workspace retrieval must still obey
per-scope and total result limits. Workspace profile deactivation is soft
delete: the profile becomes inactive and can be reactivated by upserting the
same key.

## Repository Aliases And Scope Migration

For renamed or transferred repositories, treat the new repository identity as
the canonical `scopeKey`. ContextForge may be configured with
`CONTEXTFORGE_SCOPE_ALIASES` so future reads and writes using an old repo key
canonicalize to the new key. Before assuming data is missing, check `db_info`
for loaded `scopeAliases`.

When scope aliases are enabled, old-scope rows that have not been migrated may
be hidden from normal scoped reads because read/write calls canonicalize to the
new key. Use `migrate_scope` for explicit migration rather than trying to read
both old and new scopes as a union.

`migrate_scope` rules:

- Run it as a dry-run first. `dryRun` defaults to `true`.
- Pass `fromScope`/`fromScopeKey` as the raw stored old scope. The `from` scope
  is not alias-canonicalized, so it can find rows written before the alias was
  configured.
- Pass `toScope`/`toScopeKey` as the intended canonical target. The `to` scope
  is alias-canonicalized.
- Inspect `conflicts`, `blocked`, and `blockedReason` before running with
  `dryRun: false`.
- `hasRows: false` or `empty: true` means there is nothing to migrate.
- `totalRows` counts logical rows to move. `derivedRows.memory_fts` and
  `rebuilt.memory_fts` describe the derived FTS index, not additional durable
  memory rows.

## Connection Diagnostics

Before relying on results, check connection metadata and storage authority from
`bootstrap_context` or `db_info`:

- `connection.summary`: quickest human-readable access/process summary.
- `connection.accessMode`: `direct-local`, `server-process`, or `remote-client`.
- `connection.accessPath`: concrete path such as `direct-local`, `http-api`, or
  `http-mcp`.
- `connection.serverRole`: server process role behind a remote call, when
  present.
- `connection.mode: "remote-client"`: this agent reaches ContextForge through
  HTTP or a remote wrapper.
- `connection.mode: "http-server"`: the tool is running inside the ContextForge
  HTTP server process.
- `connection.mode: "direct-local"`: the tool is a local ContextForge process.
- top-level `storageMode`: storage used by the responding ContextForge process.
- `connection.server`: server process details behind a remote call, when
  present.
- `remote-client` access means server-backed canonical memory for the configured
  scope.
- `direct-local` with `local` or `project-local` storage is local context unless
  repo instructions say otherwise.
