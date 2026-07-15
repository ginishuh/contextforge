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

## Idle audit epochs

Small sessions do not need to reach the active-session batch threshold before
they become auditable. `listDueCandidateAudits` is a provider-free inventory of
sessions that have eligible candidates and have been quiet for the configured
grace period. `processDueCandidateAudits` revalidates each inventory row and
queues a bounded `session` audit job; it does not call the provider itself.
The mutating process call requires one explicit canonical scope; it never
creates a workspace-wide or mixed-scope batch.

Quiet time is measured from the last raw event. A later checkpoint or candidate
creation time does not restart the grace period; checkpoint existence remains a
separate eligibility condition.

Every idle inventory row freezes a source watermark with the raw-event count,
last raw-event id/time, raw fingerprint, latest checkpoint id, and `coversTo`.
The enqueue transaction compares that watermark with current storage. A late
event fails the old selection with
`CONTEXTFORGE_AUDIT_SOURCE_WATERMARK_CHANGED`; the next scan creates a new
epoch. Once queued, the candidate-id set and watermark are immutable job and
audit-attempt provenance. This lets a running audit finish its old epoch while
a resumed session later distills and audits a distinct epoch.

The default inferred-idle grace period is ten minutes and can be changed with
`CONTEXTFORGE_AUTO_PROMOTE_AUDIT_IDLE_CLOSEOUT_MS` or the
`autoPromoteAudit.idleCloseoutMs` runtime setting. An inferred idle signal is
not stored as an adapter terminal signal. Explicit terminal detection remains
adapter-specific and must not be inferred from a quiet period.

For unattended convergence, run `candidateLifecycleWorker` against an explicit
scope or repo registry. Each iteration wakes due snoozes, enqueues bounded idle
audits, applies bounded stale-SLA transitions, and processes audit jobs with a
claim fenced to that same canonical scope. One failed scope does not prevent
other configured scopes from progressing. The one-shot CLI defaults to dry-run;
the packaged systemd installer passes `dryRun=false` explicitly.

The packaged service uses conservative per-scope iteration defaults of one due
session, two candidates from that session, and one audit job. Its generated
`0600` authority environment file is loaded after the token environment file,
forces remote storage mode and the configured URL, and keeps that URL out of the
process command line. The default remote timeout is 300 seconds, covering two
sequential default 120-second provider calls plus bounded overhead. If the
candidate or job limits increase, the timeout must also cover the resulting
worst-case provider wall-clock. See [Operations](operations.md) for installation,
readiness, and worker-ownership details.

## Snooze and wake-up SLA

`snoozeMemoryCandidate` moves one `pending` candidate to `snoozed`. It requires
a finite future `snoozedUntil`, a reason, an actor, and the wake-up target
`pending`. The default maximum is 90 days and can be changed with
`CONTEXTFORGE_CANDIDATE_SNOOZE_MAX_MS`; permanent or over-limit snooze is not
accepted. Candidates with a `queued` or
`running` audit cannot be snoozed because that would race the immutable job
selection.

`listDueCandidateWakeups` is a provider-free, bounded inventory ordered by the
stored snooze deadline. `processDueCandidateWakeups` requires one explicit
canonical scope and reopens expired rows with a compare-and-swap update. A
concurrent reschedule or wake-up is skipped instead of overwriting the newer
epoch. `dryRun` returns the same bounded selection without mutation.

Manual `wakeMemoryCandidate` may reopen a candidate before its deadline. Both
snooze and wake transitions append actor, reason, time, request id, prior
deadline, and status movement to `reviewMetadata.lifecycleEvents`. Wake-up
clears the active snooze columns but keeps this transition history. To extend a
snooze, wake the current epoch and create a new finite snooze rather than
changing its deadline in place.

## Stale review SLA

`listDueCandidateStaleTransitions` is a provider-free, bounded inventory of
`pending` candidates that exceeded their queue-specific review SLA.
`processDueCandidateStaleTransitions` requires one explicit canonical scope and
moves a bounded batch to the reversible `stale` disposition. It never deletes
candidate, checkpoint, or raw evidence.

The SLA anchor is `reviewedAt` after an audit or triage result and `createdAt`
otherwise. `queued` and `running` audits are excluded. Before committing, the
worker fences candidate disposition, audit state, audit decision, and the SLA
anchor, so a concurrent audit or review wins instead of being overwritten.
Dry-run returns the exact selected candidates, queue, age, threshold, policy
version, and remaining count without mutation.

Defaults are 14 days for `triaged_no_audit` and reject recommendations, 90 days
for approved candidates awaiting promotion, and 30 days for unaudited,
retryable or terminal failures, legacy or unknown audit results, and human
review. Each threshold has a `CONTEXTFORGE_CANDIDATE_SLA_*_MS` override. A
stale transition preserves the prior audit decision, review timestamp, and
reason and appends actor, reason, queue, anchor, and policy provenance to
`lifecycleEvents`. `reopenStaleMemoryCandidate` restores the candidate to
`pending` without discarding that history, so stale remains a review
disposition rather than a hard delete.

## Deterministic backlog audit planning

`planMemoryCandidateBacklogAudit` is a provider-free, read-only review
operation. It scans at most 500 pending candidates in one canonical scope and
uses the same deterministic safety warnings and prompt builder as the real
candidate audit path. The plan reports:

- candidates excluded by audit state or deterministic policy;
- exact candidate groups and exact matches to active durable memory;
- weak-evidence candidates old enough for a reversible stale suggestion;
- the high-signal candidate ids selected for the next provider batch;
- actual prompt characters plus estimated input/output tokens;
- estimated USD only when both input and output per-million-token rates are
  supplied by the caller.

The planner never changes candidate state, creates a job, or invokes a
provider. A weak-evidence candidate beyond the stale threshold is excluded
from `plannedCandidateIds`, so stale suggestions and paid provider calls never
overlap. It does not hardcode model pricing. `asOf` can be fixed for a
repeatable age calculation, explicit `candidateIds` are bounded at 500, and
the executable audit batch remains bounded at 10 calls. Exact candidate
grouping selects one stable representative; the other candidates remain
unchanged until a later reviewed disposition step.

## Audited durable-write routing

An approved audit does not imply that a new durable row is safe. The audit
commit immediately repeats same-scope durable-memory assessment. `new` remains
eligible for reviewed promotion, `duplicate` is labeled
`do_not_create_duplicate_memory`, and `refinement`, `supersedes`, or `conflict`
creates an idempotent `memory_update_candidate` for human review. This routing
does not promote or edit durable memory.

Exact duplicates normally leave the paid audit path during deterministic
triage and become `triaged_no_audit`; the duplicate routing branch exists for
legacy approvals, forced re-audits, and previously audited backlog rows. In all
cases the Admin UI requires a stored `promote_as_new_memory` route before it
enables direct promotion. Missing or failed routing never falls back to a
warning override. Persisted routing is bound to `latestAuditAttemptId`; starting
or completing a later audit invalidates the older route even when the candidate
content hash did not change. The promotion backend applies the same gate to
audited candidates, so stale UI state cannot bypass the current audit decision.

`routeAuditedMemoryCandidates` applies the same provider-free contract to an
existing approved backlog. It defaults to `dryRun=true`, accepts at most 100
explicit ids or the oldest bounded approved batch, and refuses candidate
revisions that no longer match the approved audit hash. Separate audited source
candidates never overwrite each other's pending update proposals, even when
they target the same memory.

Applying an update candidate marks its linked source candidate `promoted` and
records the resulting durable memory id. Rejecting the update marks the source
candidate `rejected`; skipping it moves the source candidate to reversible
`stale`. Apply also fences the target memory id; a concurrently corrected target
must be re-routed or explicitly overridden with a reason. The audit attempt and
routing metadata remain available in every case.

## Immutable audit provenance

Every provider result is appended to `memory_candidate_audit_attempts`. The
record binds the result to:

- candidate revision hash;
- source mode, session/checkpoint, job id, and lease attempt;
- the source watermark for an idle/session audit epoch when present;
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

## Operational quality signals

Authenticated operational metrics report candidate creation, audit, promotion,
rejection, and stale throughput over the latest 24 hours; oldest pending age;
closeout-to-audit and audit-to-promotion latency; audit decisions; durable-write
routing classifications; and candidate-to-durable conversion.

Promotion quality is measured only from candidate-linked `promote` events, so a
reviewed refinement applied as a `correct_memory` action is not mislabeled as a
bad new-memory promotion. The snapshot reports corrections and deactivations
within 7 and 30 days, active same-scope exact-content duplicates, transient
category promotions, and bounded provider/model/prompt decision and correction
rates. The 7/30-day rate denominators include only promotions whose complete
observation window has elapsed, so recent promotions do not dilute the result.
Retrieval-use coverage comes from aggregate per-memory counters; raw queries are
never retained.
