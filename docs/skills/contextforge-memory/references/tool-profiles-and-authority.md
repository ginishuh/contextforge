# Tool Profiles And Storage Authority

Read this reference when an MCP tool appears missing, when selecting a narrower
server surface, or when deciding scope and storage authority.

## MCP Tool Profiles

Treat a missing MCP tool as a possible profile choice, not proof that the core
or remote API lacks the operation.

- `agent-core` (default): bootstrap, scoped retrieval, manual evidence,
  checkpointing, durable distill submission/status, and ordinary closeout.
- `review`: `agent-core` plus candidate backlog planning, audit inventory and
  submission, snooze/wake/stale review actions, duplicate/update review,
  correction, promotion, and deactivation.
- `operator`: runtime operations except workspace mutations; use for job
  workers, due distills/consolidations, mutating candidate lifecycle stages,
  retention, embeddings, usage, and `migrate_scope`.
- `workspace-admin`: workspace profiles/members/routing and scope migration.
- `all`: compatibility surface that exposes every tool.

Inspect the selected surface with `node src/mcp.js --describe-surface`. Configure
`CONTEXTFORGE_MCP_PROFILE` on stdio or HTTP server processes, or use
`CONTEXTFORGE_MCP_TOOLS` for an exact allowlist. Do not broaden a normal agent
registration for one maintenance task; prefer a separate operator/admin
registration when the client supports it.

## Scope Choice

Set scope intentionally:

- `repo`: project-specific memory. Prefer a canonical `scopeKey` such as
  `github.com/owner/repo`; pass `repoPath` or `cwd` when the MCP process cwd is
  not the checkout.
- `shared`: cross-repo or user-wide conventions. Include only when relevant.
- `local`: machine-specific context. Opt in only when appropriate.

Workspace profiles are retrieval topology; storage modes are authority.
Workspace selection is explicit per call. Pass `workspaceKey` only when
cross-repo retrieval is intended.

## Authority Check

Before relying on results, inspect `connection.summary`,
`connection.accessMode`, and top-level `storageMode` from `bootstrap_context` or
`db_info`.

- `remote-client` access means server-backed canonical memory for the configured
  scope.
- `direct-local` with `local` or `project-local` storage is checkout- or
  machine-local unless repo instructions say otherwise.
- Use the workspace reference for detailed connection fields, remote workspace
  rules, aliases, and scope migration.
