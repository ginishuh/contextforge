# Memory candidate lifecycle

Memory candidates are review material. They do not become durable memory until
an explicit promotion succeeds.

ContextForge stores two independent state dimensions:

- disposition: `pending`, `promoted`, `rejected`, `stale`, or `snoozed`;
- audit state: `unaudited`, `queued`, `running`, `audited`,
  `failed_retryable`, `failed_terminal`, `triaged_no_audit`, or
  `legacy_unknown`.

An audited candidate also carries an audit decision of `approve`,
`needs_review`, or `reject`. An approval is not a durable write.

## Review backlog

`memoryCandidateBacklog` is a scoped, read-only inventory operation protected by
the `review` capability. It never calls an LLM provider. It returns:

- one cursor-paged candidate list;
- an `asOf` timestamp;
- `filteredCandidateCount` and counts by disposition, audit state, audit
  decision, and recommendation using the same filters as the list;
- explicit `approvedAwaitingPromotionCount`, `pendingNeedsReviewCount`, and
  `pendingRejectRecommendedCount` fields;
- latest candidate, audit, and promotion timestamps;
- the oldest pending candidate timestamp.

The first page includes the summary by default. Cursor continuation pages set
`summaryIncluded=false` and return `summary=null` so pagination does not repeat
the scope aggregation. A caller that needs it can pass `includeSummary=true`.
The Admin UI keeps the first-page summary while paging.

The Admin UI uses this operation directly. A repo reviewer can therefore see
pending candidates without first locating a session or checkpoint.

## Durable audit sources

Audit jobs preserve one source mode without implicit conversion:

- `checkpoint`: candidates from exactly one checkpoint;
- `session`: eligible candidates from the adapter session, including earlier
  checkpoints;
- `backlog_batch`: at most ten explicit candidate ids from one canonical scope.

At submission, the job freezes its candidate ids and the requested audit
provider/model/reasoning/prompt/schema metadata. A configuration change before
execution fails the job with `CONTEXTFORGE_AUDIT_CONFIGURATION_DRIFT`; it does
not silently run a different configuration.

Each job candidate has its own queued/running/succeeded/failure/skipped state.
Successful candidates are not called again when another candidate causes a job
retry. Cancellation, lease expiry, and terminal job failure release or settle
candidate audit states so a row does not remain falsely `queued` forever.

## Immutable audit provenance

Every provider result is appended to `memory_candidate_audit_attempts`. The
record binds the result to:

- candidate revision hash;
- source mode, session/checkpoint, job id, and lease attempt;
- provider/model/reasoning/prompt/schema metadata;
- decision, reason, risk codes, usage, and failure metadata;
- start and completion timestamps.

Legacy `review_metadata_json` audits are backfilled conservatively. Ambiguous
reviewed rows become `legacy_unknown` instead of being guessed as approved.

Candidate review metadata remains for compatibility, but it is no longer the
only audit history.

## Promotion safety

Audit approval is bound to a hash of candidate key, content, category, and
tags. Editing any of those fields invalidates the approval. A human override
requires `allowAuditRevisionOverride=true` and a non-empty reason; the original
and proposed hashes are retained in review metadata.

Promotion repeats duplicate/conflict assessment inside the write transaction.
The candidate disposition update uses compare-and-swap against `pending`, so a
concurrent reviewer cannot commit a second promotion after another process has
already changed the candidate.

The durable memory write, candidate disposition, memory event, audit provenance
link, and embedding job enqueue commit in the same transaction.

Ordinary closeout remains session/checkpoint scoped. Scope-wide review is only
available through an explicit `backlog_batch`; there is no implicit scope
fallback.
