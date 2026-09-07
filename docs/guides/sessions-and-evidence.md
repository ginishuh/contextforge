# Sessions And Evidence

Read this reference when choosing a session ID, capturing raw evidence, or using
manual, adapter-ingested, or CLI lifecycle flows.

## Session IDs

Do not create a new `cf_...` session for an existing Codex or Claude Code run.

- `codex:<native-session-id>`: Codex rollout evidence and checkpoints.
- `claude_code:<native-session-id>`: Claude Code transcript evidence and
  checkpoints.
- `cf_...`: a manual ContextForge evidence stream created by `begin_session`.

For stdio MCP, the server binds `CONTEXTFORGE_SESSION_ID` as a complete ID. If
it is absent, it binds `CODEX_THREAD_ID`, `CODEX_SESSION_ID` as `codex:<id>`,
or `CLAUDE_CODE_SESSION_ID` as `claude_code:<id>`. An explicit `sessionId` or
`checkpointId` always wins. If both Codex and Claude source variables are set
without `CONTEXTFORGE_SESSION_ID`, binding fails as ambiguous; it never picks
one by priority. CLI session-specific commands follow the same rule.

For direct HTTP MCP, pass a namespaced `x-contextforge-session-id` per request.
The shared server environment is never used to infer a client session. If no
binding exists, save/resume requires an explicit `sessionId`; do not guess the
latest session.

## Evidence Capture

Use `append_raw` for meaningful user/assistant evidence that needs later
distillation. Do not store raw tool dumps as conversation memory; summarize
verified facts or preserve tool payloads as artifacts.

For a manual evidence stream when raw capture is actually needed:

1. Call `begin_session`.
2. Append meaningful evidence with `append_raw`.
3. Call `distill_checkpoint` at a meaningful boundary if a checkpoint is useful.

For an adapter-ingested stream:

1. Preserve or recover the adapter session ID.
2. Use that ID for resume and distillation.
3. Do not replace it with a new `cf_...` session.

CLI users may use `agentStart` and `agentCloseout` as agent-neutral wrappers.
`agentStart` may pass `workspaceKey`. `agentCloseout` requires `sessionId` or
`checkpointId`, preserves adapter-prefixed IDs, defaults to `dryRun=true`, does
not scan a broad scope backlog, and does not promote durable memory by itself.
It wraps `sessionStatus`, optional `distillCheckpoint`,
`auditMemoryCandidates`, and `suggestMemoryPromotions`.

The explicit closeout form is
`agentCloseout --agent <adapter> --sessionId <adapter:id>`.
