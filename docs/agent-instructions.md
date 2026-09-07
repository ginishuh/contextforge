# ContextForge Agent Instructions

Copy the short contract below into a repository's `AGENTS.md` when it uses
ContextForge. Replace the example scope key with the repository's canonical identity.

```text
Use ContextForge MCP for scoped project memory when it is available.

At task start or resume, call `bootstrap_context` with the task and explicit
repo scope: `scope="repo", scopeKey="github.com/example/repo"`.
`repoPath` and `cwd` are filesystem paths. Use `search` for targeted lookup and follow detail pointers only
when relevant. Keep `workspaceKey` explicit; it is the opt-in for cross-repo
retrieval and is never inferred from cwd or process state.

Trust result types by role: `memory` is reviewed durable state, `checkpoint`
is recent handoff context that needs live verification, and
`memory_candidate` is review material. Verify mutable Git, CI, deployment,
and runtime facts from their live source.

`bootstrap_context` does not create a session. Preserve an adapter-bound
session ID for save/resume. If there is no binding, pass the exact `sessionId`;
never guess the latest session or create a manual session for an adapter stream.
```

For the complete guide and links to focused topics, see
[Agent Guide](agent-guide.md). For guidance on keeping a repository's
`AGENTS.md` short, see [AGENTS.md Authoring Guide](agents-md-guide.md).

## Remote Canonical Addition

Add this only when another host owns the canonical store:

```text
Connection mode: external remote client. Storage authority: remote canonical
ContextForge. Inspect `connection.summary` or `connection.accessMode` from
`db_info` or `bootstrap_context`; do not infer server state from local SQLite.
```

## Local Or Project-Local Addition

Add this only when the current machine or checkout intentionally owns the
store:

```text
Treat this ContextForge store as machine-local context unless its authority is
declared. Verify before making cross-machine or deployment claims.
```
