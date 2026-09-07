# Bootstrap, Search, And Resume

Read this reference for startup, resume, compaction recovery, handoff
interpretation, related scopes, and targeted retrieval.

## Consult By Reason

Use relevant results for startup. Use a latest handoff only for continuity
recovery, not routine self-confirmation.

- For `startup`, call `bootstrap_context` with `consultReason: "startup"` and
  use its relevant results.
- For `resume`, `compaction_recovery`, or `agent_switch`, pass that
  `consultReason` and the matching adapter `sessionId`. Compact bootstrap then
  returns only that session's handoff; without it, `handoffStatus` is
  `session_required` and there is no repo-wide latest-handoff fallback.
- During an uninterrupted session, proceed from current conversation context.
- For file, API, error, or domain details, use targeted `search`.
- For runtime, DB, git, GitHub, CI, health, or deployment facts, use live tools
  such as `db_info`, `/healthz`, or the service manager.

If current context conflicts with a handoff, prefer current context or live
verification. Treat handoff state as compressed and stale-prone.

## Startup Bootstrap

1. Call `bootstrap_context` with a task-derived query, `scope: "repo"`, and a
   `repoPath`, `cwd`, or canonical `scopeKey`. MCP defaults to `responseMode:
   "compact"`; each result supplies a detail pointer. Its default `maxChars` is
   6000 and accepts 2000 through 20000.
2. For file, API, error, or domain detail, call targeted `search`, then follow
   the result's detail pointer. Use `get_memory` only when the durable key is
   already known.
3. Use `responseMode: "full"` only for diagnostics or legacy callers. Verify
   mutable repo, PR, CI, runtime, and deployment claims at their live source.
4. Pass `workspaceKey` or `includeShared: true` only when that extra scope is
   relevant to the task.

`bootstrap_context` retrieves context; it does not create a session.

## Full Response Compatibility

Set `responseMode: "full"` for diagnostics or legacy callers. It retains the
expanded `handoff.latestHandoff` and `handoff.latestByAgent` fields,
`relatedScopeKeys`, `memoryMap`, and optional `rawTail`; compact mode does not
use those fields as its everyday retrieval contract.

## Resume And Handoff

For “continue,” prior work, or cross-agent handoff:

1. Call `bootstrap_context` with `consultReason: "resume"` or
   `"compaction_recovery"` and the matching adapter `sessionId`, then use the
   compact handoff and result detail pointers as needed. Without `sessionId`,
   handle `handoffStatus: "session_required"`; do not treat a repo-wide latest
   checkpoint as the current session.
2. Use `sync_resume_context` only when the exact `sessionId` is known and the
   session working state or raw tail is needed.
3. Verify mutable state before acting, and do not propose promotions during
   start or resume sync.

For active-session cross-repo search, pass `workspaceKey`; without it, `search`
keeps ordinary single-scope behavior.
