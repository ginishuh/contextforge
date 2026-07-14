# Closeout, Promotion, And Corrections

Read this reference for ordinary closeout candidate audit, durable promotion,
duplicate/update handling, automatic promotion, or user corrections.

## Closeout Audit

At closeout triggers, audit the current session or checkpoint candidate batch:

1. Pass `auditTrigger` to `distill_checkpoint` when distilling closeout evidence.
2. Keep automatic audit scoped to the current `sessionId` or explicit
   `checkpointId`; never scan the whole scope backlog implicitly.
3. Treat stored audit results as recommendations, not durable writes.
4. Use `audit_memory_candidates` to inspect stored recommendations or audit the
   same closeout batch. It stores append-only audit provenance and usage, but
   must not promote or mutate durable memory.
5. Promote only reviewed, stable, scoped, non-secret facts.
6. Prefer `promote_memory_candidate` by `candidateId`.
7. Prefer a reviewed `memory_update_candidates` proposal for duplicate,
   refinement, supersedes, or conflict assessments.
8. Use `remember` or `promote_memory` for a corrected durable write when the
   candidate key or content is wrong; use `reject_memory_candidate` for wrong
   candidates.

If `suggest_memory_promotions` returns no proposals while candidates exist,
inspect `list_memory_candidates`. The default is
`promotionRecommendation: "promote"`; for
`promotionRecommendation: "review"`, call the suggestion tool with that
recommendation or review candidates manually.

## Duplicates And Automatic Promotion

Use `audit_memory_duplicates` to inspect active durable memories. It is read-only
unless `createUpdateCandidates=true`; even then it creates review proposals, not
direct merges. Those proposals use `merge_duplicate_memories`. Set `scanLimit`
intentionally because comparison is pairwise inside the scanned window.

Use `auto_promote_memory_candidates` only when write-side automatic promotion is
explicitly intended. Include `sessionId` or `checkpointId`; real writes require
server-side enablement and `dryRun: false`. Candidate audit is not the promotion
toggle.

## Promotion Quality

Promote stable API contracts, architecture decisions and rationale, final
outcomes with future impact, repo runbooks/failure modes, reviewed recurring
preferences, and cross-agent lessons.

Do not promote transient branch or CI state, raw logs, secrets or personal data,
facts cheaper to read live, or low-confidence/high-sensitivity candidates.

## Corrections

For a user correction:

1. Call `reconcile_memory` first.
2. Explain the prior basis and assess conflicts.
3. Use `correct_memory`, `deactivate_memory`, or a memory update candidate only
   after the correction is clear and approved when required.
4. Do not edit checkpoints; correct durable memory or reject candidates.
