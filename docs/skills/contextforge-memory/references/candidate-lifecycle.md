# Candidate Backlog And Lifecycle Operations

Read this reference only when the task explicitly calls for scope-wide backlog
review, audited candidate routing, lifecycle dispositions, or worker operation.
Ordinary closeout remains session/checkpoint scoped.

Candidate v2 fields such as `durabilityReason`, `riskReason`, `evidenceRefs`, and
`suggestedAction` are provider recommendations, not approval. An audited
`approve` decision is not itself a durable write. Candidate
disposition, audit state, and durable promotion remain separate lifecycle state.

## Scope-Wide Candidate Review

Never broaden an empty closeout proposal into an implicit scope scan.

1. In MCP, use `list_memory_candidates` without `sessionId` or `checkpointId`
   for a bounded scope page. The specialized `memoryCandidateBacklog` aggregate
   is available through the Admin UI and HTTP/core surfaces; it is
   provider-free and adds same-filter lifecycle counts and freshness timestamps.
2. Use `plan_memory_candidate_backlog_audit` before paid backlog work. It is
   provider-free, scans at most 500 pending candidates, separates deterministic
   exclusions and exact matches, and selects at most ten candidates for the next
   executable provider batch. Pricing is reported only from caller-supplied
   rates.
3. To run the selected provider audit durably, call `submit_audit_job` with one
   explicit canonical scope, a closeout `trigger`, and at most ten
   `candidateIds`. An operator must run `process_jobs`; submission alone does
   not execute the provider.
4. Audit attempts are append-only provenance bound to candidate revision,
   source mode/watermark, provider policy, and lease attempt. Editing candidate
   key/content/category/tags invalidates the approved revision rather than
   silently preserving approval.
5. After approval, call `route_audited_memory_candidates` in its default
   `dryRun=true` mode first. `new` can proceed to reviewed promotion; `duplicate`
   must not create another durable row; `refinement`, `supersedes`, and
   `conflict` become review-only memory update candidates. Routing does not
   promote or edit durable memory.
6. Use `snooze_memory_candidate` only with a finite future deadline, actor, and
   reason. The default maximum is 90 days, and queued/running audits cannot be
   snoozed. Use `wake_memory_candidate` for an early reopen; do not extend a
   snooze by rewriting its active deadline.
7. Treat `stale` as a reversible review disposition, not deletion. Use
   `reopen_stale_memory_candidate` when review resumes. Candidate, checkpoint,
   raw evidence, audit decisions, and lifecycle provenance remain available.

## Unattended Candidate Lifecycle

The `review` profile exposes provider-free inventory calls
`list_due_candidate_audits`, `list_due_candidate_wakeups`, and
`list_due_candidate_stale_transitions`. Their mutating `process_*` counterparts
are operator-profile work and require one explicit canonical scope. Run them in
dry-run first when operating manually.

- Idle audit eligibility uses quiet time since the last raw event, not candidate
  or checkpoint creation time. The default grace is ten minutes. Enqueue
  revalidates a frozen raw/checkpoint watermark, so late evidence becomes a new
  audit epoch instead of changing an existing job source.
- Wake-up processing uses the stored finite snooze deadline and compare-and-swap
  guards. Stale processing excludes queued/running audits and defaults to 14
  days for deterministic triage/reject queues, 90 days for approved candidates
  awaiting promotion, and 30 days for the other review queues.
- For continuous convergence, run the CLI-only `candidateLifecycleWorker`
  against an explicit scope or repo registry, or install
  `scripts/install-candidate-lifecycle-worker-service.sh`. The one-shot CLI
  defaults to dry-run; the packaged service opts into mutation, uses per-scope
  limits of one due session, two candidates, and one audit job, and sets a
  300-second remote timeout for the bounded provider wall-clock.
- The packaged service loads a generated `0600` authority environment file
  after the token file to force remote storage mode and the configured URL while
  keeping the URL out of the command line. If limits increase, scale the remote
  timeout for the worst-case provider-call count and concurrency.
- Keep registry scope ownership and token authorization explicit. Watch
  `/readyz` operation-worker freshness and operational metrics; one worker's
  scope fence must not be mistaken for ownership of jobs outside its registry.
