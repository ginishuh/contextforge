# Distillation And Durable Jobs

Read this reference for checkpoint timing, provider jobs, retry/cancellation
semantics, cost tracking, or checkpoint consolidation.

## Distillation

Call `session_status` before expensive distillation. It reports raw counts,
latest checkpoint, candidate counts, thresholds, and whether distillation is
currently useful.

Call `distill_checkpoint` at meaningful boundaries:

- after a feature is implemented and tested;
- after a PR, issue, or incident reaches a stable state;
- before switching agents or machines;
- before ending a long session.

Retain the returned `checkpointId`, `memoryCandidateCount`, and `distill_usage`
when cost matters. Distillation failure must not erase raw evidence.

Treat checkpoint `structured` output as recent handoff state, not durable truth.
Do not promote structured live state unless it is stable, reviewed, and no
cheaper live source exists.

## Durable Provider Jobs

Use durable jobs when provider work must survive a client disconnect or server
restart:

1. Submit with `submit_distill_job` or `submit_audit_job` and retain `jobId`.
2. Poll with `get_job`; use `list_jobs` for bounded operator inspection.
3. Run `process_jobs` from a server-side operator. Submission alone does not
   execute the provider.
4. Let duplicate source-window/policy submissions reuse a job. Use a deliberate
   `idempotencyKey` only for a genuinely distinct run.
5. Treat `cancel_job` as guaranteed only for queued jobs. A running call returns
   `running_not_interruptible` and is not force-killed.
6. Remember that candidate audit jobs call the provider once per candidate; the
   durable queue is not a true provider batch contract.
7. Treat execution as at-least-once. Lease fencing blocks stale commits, but a
   lost lease may already have incurred cost. After `maxAttempts`, review the
   failure before changing `idempotencyKey`; `retryFailed` does not reset budget.

## Checkpoint Consolidation

Use consolidation when many short checkpoints make bootstrap too thin.

- Use `list_due_consolidations` for read-only planning.
- Run `process_consolidations` with `dryRun: true` first for unattended flows.
- Use `target: "thread"` with `sessionId`, or `target: "repo"` for the repo scope.
- Use `windowKind: "daily"` with `day`, or `windowKind: "custom"` with explicit
  `coversFrom` and `coversTo`.
- Consolidation reads existing `source: "distill"` checkpoints, not raw
  evidence. It creates a time-window checkpoint summary, not durable memory,
  and should produce only a few reinforced durable-fact candidates.
