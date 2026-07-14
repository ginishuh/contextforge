# Sessions And Evidence

Read this reference when choosing a session ID, capturing raw evidence, or using
manual, adapter-ingested, or CLI lifecycle flows.

## Session IDs

Do not create a new `cf_...` session at closeout for an existing Codex or Claude
Code run.

- `codex:<native-session-id>`: Codex rollout evidence and checkpoints.
- `claude_code:<native-session-id>`: Claude Code transcript evidence and
  checkpoints.
- `cf_...`: a manual ContextForge evidence stream created by `begin_session`.

Pass the known `sessionId` consistently to `bootstrap_context`,
`sync_resume_context`, `session_status`, `distill_checkpoint`, and closeout tools.

## Evidence Capture

Use `append_raw` for meaningful user/assistant evidence that needs later
distillation. Do not store raw tool dumps as conversation memory; summarize
verified facts or preserve tool payloads as artifacts.

For a manual evidence stream:

1. Call `begin_session`.
2. Append meaningful evidence with `append_raw`.
3. Check `session_status`.
4. Call `distill_checkpoint` at a meaningful boundary.
5. Review the closeout candidate batch.

For an adapter-ingested stream:

1. Preserve or recover the adapter session ID.
2. Use that ID for status, distillation, and closeout.
3. Do not replace it with a new `cf_...` session.

CLI users may use `agentStart` and `agentCloseout` as agent-neutral wrappers.
`agentStart` may pass `workspaceKey`. `agentCloseout` requires `sessionId` or
`checkpointId`, preserves adapter-prefixed IDs, defaults to `dryRun=true`, does
not scan a broad scope backlog, and does not promote durable memory by itself.
It wraps `sessionStatus`, optional `distillCheckpoint`,
`auditMemoryCandidates`, and `suggestMemoryPromotions`.

The explicit closeout form is
`agentCloseout --agent <adapter> --sessionId <adapter:id>`.
