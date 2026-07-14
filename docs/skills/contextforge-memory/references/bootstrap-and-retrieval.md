# Bootstrap, Search, And Resume

Read this reference for startup, resume, compaction recovery, handoff
interpretation, related scopes, and targeted retrieval.

## Consult By Reason

Use the latest handoff for continuity recovery, not routine self-confirmation.

- For `startup`, `resume`, `compaction_recovery`, or `agent_switch`, call
  `bootstrap_context` with that `consultReason` and read the latest handoff.
- During an uninterrupted session, proceed from current conversation context.
- For file, API, error, or domain details, use targeted `search`.
- For runtime, DB, git, GitHub, CI, health, or deployment facts, use live tools
  such as `db_info`, `/healthz`, or the service manager.

If current context conflicts with a handoff, prefer current context or live
verification. Treat handoff state as compressed and stale-prone.

## Startup Bootstrap

1. Call `bootstrap_context` with a task-derived query, `scope: "repo"`, and
   `repoPath`, `cwd`, or explicit canonical `scopeKey`.
2. Read `handoff.latestHandoff` first. It is selected independently of semantic
   search ranking.
3. Inspect `handoff.latestHandoff.structured`, especially `structured.liveState`,
   `warnings`, `staleReasons`, and `verifyHints`. Verify mutable repo, PR, commit,
   CI, worktree, runtime, and deployment fields.
4. Read `handoff.latestCheckpoints` for recent decisions, work status, todos, and
   next actions.
5. Read `handoff.latestConsolidation.thread` or
   `handoff.latestConsolidation.repo` only when broader period context is useful;
   consolidation is not durable memory.
6. Inspect `memoryLifecycle`, including `latestCandidateAt`, `latestPromotedAt`,
   pending counts, and recent candidate/promotion counts.
7. Pass `relatedScopeKeys` only for known parent, suite, or subrepo handoffs;
   `latestCheckpointLimit` applies per scope.
8. Pass `workspaceKey` only when configured cross-repo context is relevant; its
   bounded supplemental results appear in `workspace.results`.
9. Set `includeShared: true` only for relevant cross-repo or user-wide policy,
   credentials location, deployment, or recurring preferences.
10. Use targeted `search` when more detail is needed and `get_memory` only for a
    known durable key.

`bootstrap_context` retrieves context; it does not create a session.

## Resume And Handoff

For “continue,” prior work, or cross-agent handoff:

1. Call `bootstrap_context` with `consultReason: "resume"` or
   `"compaction_recovery"`.
2. Prefer `handoff.latestHandoff`, then read other recent checkpoints if needed.
3. Use `handoff.latestConsolidation` only when the ordinary latest checkpoint
   slice is thin.
4. Run structured verification hints before editing or reporting live state.
5. Use `sync_resume_context` only when the exact `sessionId` is known and the
   session working state or raw tail is needed.
6. Prefer checkpoints over durable memory for fast-moving work status; treat
   candidates as review material only.
7. Do not propose memory promotions during start or resume sync.

For active-session cross-repo search, pass `workspaceKey`; without it, `search`
keeps ordinary single-scope behavior.
