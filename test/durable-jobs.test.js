import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTempDir, waitForCondition } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { ProviderTimeoutError } from '../src/runtime/provider_execution.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

test('provider concurrency cap is process-global per provider', async () => {
  const dataDir = await makeTempDir();
  const releases = [];
  let active = 0;
  let maxActive = 0;
  let invocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'bounded_provider',
      CONTEXTFORGE_PROVIDER_CONCURRENCY_LIMIT: '1',
    },
    cwd: process.cwd(),
    distillProviders: {
      bounded_provider: async ({ session }) => {
        invocations += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
        return {
          summaryShort: `Bounded ${session.sessionId}`,
          summaryText: `Bounded provider completed ${session.sessionId}.`,
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
        };
      },
    },
  });
  for (const sessionId of ['bounded-a', 'bounded-b']) {
    app.appendRaw({
      scope: 'repo',
      scopeKey: 'bounded-repo',
      sessionId,
      role: 'assistant',
      content: `Raw evidence for ${sessionId}.`,
    });
  }

  const first = app.distillCheckpoint({ scope: 'repo', scopeKey: 'bounded-repo', sessionId: 'bounded-a' });
  const second = app.distillCheckpoint({ scope: 'repo', scopeKey: 'bounded-repo', sessionId: 'bounded-b' });
  await waitForCondition(() => releases.length === 1, 'first provider call did not start');
  await waitForCondition(
    () => app.dbInfo().providerExecution.active.some((entry) => entry.provider === 'bounded_provider' && entry.queued === 1),
    'second provider call was not queued',
  );
  assert.equal(maxActive, 1);
  releases.shift()();
  await waitForCondition(() => releases.length === 1, 'queued provider call did not start');
  releases.shift()();
  await Promise.all([first, second]);

  assert.equal(invocations, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(app.dbInfo().providerExecution.active, []);
});

test('concurrent duplicate distillCheckpoint calls share one run and checkpoint', async () => {
  const dataDir = await makeTempDir();
  let release;
  let invocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'deduplicated_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      deduplicated_provider: async () => {
        invocations += 1;
        await new Promise((resolve) => {
          release = resolve;
        });
        return {
          summaryShort: 'Deduplicated checkpoint.',
          summaryText: 'Concurrent retries share one provider execution and write.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'deduplicated-repo',
    sessionId: 'deduplicated-session',
    role: 'assistant',
    content: 'One raw event must produce one checkpoint.',
  });

  const options = { scope: 'repo', scopeKey: 'deduplicated-repo', sessionId: 'deduplicated-session' };
  const first = app.distillCheckpoint(options);
  const retry = app.distillCheckpoint(options);
  await waitForCondition(() => typeof release === 'function', 'deduplicated provider call did not start');
  assert.equal(invocations, 1);
  release();
  const [firstResult, retryResult] = await Promise.all([first, retry]);

  assert.equal(firstResult.id, retryResult.id);
  assert.equal(invocations, 1);
  assert.equal(app.listCheckpoints(options).length, 1);
  assert.equal(app.listDistillRuns(options).length, 1);
});

test('durable distill jobs deduplicate submission and persist result provenance', async () => {
  const dataDir = await makeTempDir();
  let invocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'durable_job_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      durable_job_provider: async () => {
        invocations += 1;
        return {
          summaryShort: 'Durable job checkpoint.',
          summaryText: 'The queued operation survived outside the submitting request.',
          decisions: ['Queue provider work before execution.'],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          metadata: {
            provider: 'durable_job_provider',
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          },
        };
      },
    },
  });
  const source = { scope: 'repo', scopeKey: 'durable-job-repo', sessionId: 'durable-job-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Queue this evidence for durable distillation.' });

  const first = app.submitDistillJob({ ...source, apiKey: 'must-not-persist' });
  const duplicate = app.submitDistillJob(source);
  assert.equal(first.status, 'queued');
  assert.equal(first.jobId, duplicate.jobId);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(JSON.stringify(first.job).includes('must-not-persist'), false);
  assert.equal(invocations, 0);
  assert.equal(app.dbInfo().tables.operationJobs, 1);

  const batch = await app.processJobs({ workerId: 'test-worker', limit: 1, leaseMs: 1000 });
  assert.equal(batch.claimed, 1);
  assert.equal(batch.succeeded, 1);
  assert.equal(invocations, 1);
  const completed = app.getJob({ jobId: first.jobId });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.attempts, 1);
  assert.equal(completed.result.summaryShort, 'Durable job checkpoint.');

  const [checkpoint] = app.listCheckpoints(source);
  assert.equal(completed.checkpointId, checkpoint.id);
  assert.equal(checkpoint.metadata.operationJobId, first.jobId);
  const [run] = app.listDistillRuns(source);
  assert.equal(run.jobId, first.jobId);
  const usage = app.listLlmUsageEvents({ ...source, jobId: first.jobId });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].jobId, first.jobId);

  const recoveredResult = await app.distillCheckpoint({ ...source, jobId: first.jobId });
  assert.equal(recoveredResult.id, checkpoint.id);
  assert.equal(invocations, 1);
});

test('durable jobs retry retryable provider failures only up to maxAttempts', async () => {
  const dataDir = await makeTempDir();
  let invocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'retryable_job_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      retryable_job_provider: async () => {
        invocations += 1;
        throw new ProviderTimeoutError('retryable_job_provider', 10);
      },
    },
  });
  const source = { scope: 'repo', scopeKey: 'retryable-job-repo', sessionId: 'retryable-job-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Keep raw evidence while retries fail.' });
  const submitted = app.submitDistillJob({ ...source, maxAttempts: 2 });

  const first = await app.processJobs({ workerId: 'retry-worker-1', leaseMs: 1000 });
  assert.equal(first.failed, 1);
  assert.equal(first.requeued, 1);
  assert.equal(first.jobs[0].status, 'queued');
  assert.equal(first.jobs[0].error.retryable, true);
  const second = await app.processJobs({ workerId: 'retry-worker-2', leaseMs: 1000 });
  assert.equal(second.failed, 1);
  assert.equal(second.requeued, 0);
  assert.equal(second.jobs[0].status, 'failed');
  assert.equal(second.jobs[0].attempts, 2);
  assert.equal(invocations, 2);
  assert.equal((await app.processJobs({ workerId: 'retry-worker-3' })).claimed, 0);
  assert.equal(app.getJob({ jobId: submitted.jobId }).status, 'failed');
  assert.equal(app.listRawEvents(source).length, 1);
});

test('operation job leases recover after crashes and queued cancellation is explicit', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const base = {
    operation: 'distill_checkpoint',
    scopeType: 'repo',
    scopeKey: 'lease-recovery-repo',
    sessionId: 'lease-recovery-session',
    payload: { sessionId: 'lease-recovery-session' },
    maxAttempts: 2,
  };
  const leased = store.enqueueOperationJob({ ...base, idempotencyKey: 'lease-recovery' }).job;
  const claimed = store.claimOperationJobs({
    workerId: 'crashed-worker',
    leaseMs: 50,
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(claimed[0].id, leased.id);
  const recovered = store.claimOperationJobs({
    workerId: 'replacement-worker',
    leaseMs: 50,
    now: new Date('2026-01-01T00:00:00.100Z'),
  });
  assert.equal(recovered[0].id, leased.id);
  assert.equal(recovered[0].attempts, 2);
  store.recoverExpiredOperationJobs({ now: '2026-01-01T00:00:00.200Z' });
  const exhausted = store.getOperationJob({ jobId: leased.id });
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.error.code, 'CONTEXTFORGE_JOB_LEASE_EXPIRED');

  const queued = store.enqueueOperationJob({ ...base, idempotencyKey: 'cancel-queued' }).job;
  const cancelled = store.cancelOperationJob({ jobId: queued.id, reason: 'Synthetic cancellation.' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.job.status, 'cancelled');
  const running = store.enqueueOperationJob({ ...base, idempotencyKey: 'cancel-running' }).job;
  store.claimOperationJobs({ workerId: 'active-worker', leaseMs: 1000 });
  const notInterrupted = store.cancelOperationJob({ jobId: running.id });
  assert.equal(notInterrupted.cancelled, false);
  assert.equal(notInterrupted.reason, 'running_not_interruptible');
  store.close();
});

test('operation job attempt fencing rejects stale completion with a reused workerId', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const queued = store.enqueueOperationJob({
    operation: 'distill_checkpoint',
    scopeType: 'repo',
    scopeKey: 'same-worker-fence-repo',
    sessionId: 'same-worker-fence-session',
    idempotencyKey: 'same-worker-fence',
    payload: { sessionId: 'same-worker-fence-session' },
    maxAttempts: 2,
  }).job;
  const startedAt = new Date();
  const [first] = store.claimOperationJobs({
    workerId: 'stable-worker-id',
    leaseMs: 50,
    now: startedAt,
  });
  const [replacement] = store.claimOperationJobs({
    workerId: 'stable-worker-id',
    leaseMs: 60000,
    now: new Date(startedAt.getTime() + 100),
  });
  assert.equal(first.attempts, 1);
  assert.equal(replacement.attempts, 2);
  const replacementExpiry = replacement.leaseExpiresAt;

  const staleHeartbeat = store.extendOperationJobLease({
    jobId: queued.id,
    workerId: 'stable-worker-id',
    attempt: 1,
    leaseMs: 60000,
  });
  assert.equal(staleHeartbeat, null);
  assert.equal(store.getOperationJob({ jobId: queued.id }).leaseExpiresAt, replacementExpiry);
  assert.throws(() =>
    store.completeOperationJob({
      jobId: queued.id,
      workerId: 'stable-worker-id',
      attempt: 1,
      result: { stale: true },
    }),
  );
  const completed = store.completeOperationJob({
    jobId: queued.id,
    workerId: 'stable-worker-id',
    attempt: 2,
    result: { stale: false },
  });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.result, { stale: false });
  store.close();
});

test('operation job workers renew leases while provider work is still running', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'heartbeat_job_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      heartbeat_job_provider: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        return {
          summaryShort: 'Heartbeat checkpoint.',
          summaryText: 'The worker renewed its lease during provider execution.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
        };
      },
    },
  });
  const source = { scope: 'repo', scopeKey: 'heartbeat-job-repo', sessionId: 'heartbeat-job-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Keep the job lease alive.' });
  app.submitDistillJob(source);

  const firstWorker = app.processJobs({ workerId: 'heartbeat-worker', leaseMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 1250));
  const competingWorker = await app.processJobs({ workerId: 'competing-worker', leaseMs: 1000 });
  assert.equal(competingWorker.claimed, 0);
  const completed = await firstWorker;
  assert.equal(completed.succeeded, 1);
});

test('lost operation job leases fence stale checkpoint side effects', async () => {
  const dataDir = await makeTempDir();
  let invocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'fenced_job_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      fenced_job_provider: async () => {
        invocations += 1;
        return {
          summaryShort: 'Fenced checkpoint.',
          summaryText: 'Only the current lease owner may commit this checkpoint.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
        };
      },
    },
  });
  const source = { scope: 'repo', scopeKey: 'fenced-job-repo', sessionId: 'fenced-job-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Fence stale worker side effects.' });
  const submitted = app.submitDistillJob(source);
  const store = new ContextForgeStore({ dataDir });
  const startedAt = new Date();
  const [staleClaim] = store.claimOperationJobs({
    workerId: 'stale-worker',
    leaseMs: 50,
    now: startedAt,
  });
  const [replacementClaim] = store.claimOperationJobs({
    workerId: 'replacement-worker',
    leaseMs: 60000,
    now: new Date(startedAt.getTime() + 100),
  });
  store.close();
  assert.equal(staleClaim.attempts, 1);
  assert.equal(replacementClaim.attempts, 2);

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        ...source,
        jobId: submitted.jobId,
        _jobLeaseOwner: 'stale-worker',
        _jobLeaseAttempt: 1,
      }),
    (error) => error.code === 'CONTEXTFORGE_JOB_LEASE_LOST',
  );
  assert.equal(app.listCheckpoints(source).length, 0);
  assert.equal(app.getWorkingSummary(source), null);

  const checkpoint = await app.distillCheckpoint({
    ...source,
    jobId: submitted.jobId,
    _jobLeaseOwner: 'replacement-worker',
    _jobLeaseAttempt: 2,
  });
  assert.equal(checkpoint.summaryShort, 'Fenced checkpoint.');
  assert.equal(app.listCheckpoints(source).length, 1);
  assert.equal(invocations, 2);
});

test('durable distill jobs do not swallow lease loss during embedded closeout audit', async () => {
  const dataDir = await makeTempDir();
  let submittedJobId;
  let auditInvocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'embedded_audit_lease_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditInvocations += 1;
      if (auditInvocations === 1) {
        const takeoverStore = new ContextForgeStore({ dataDir });
        const takeoverAt = new Date(Date.now() + 600000);
        const [recovered] = takeoverStore.recoverExpiredOperationJobs({ now: takeoverAt.toISOString() });
        takeoverStore.close();
        assert.equal(recovered.id, submittedJobId);
        assert.equal(recovered.status, 'queued');
      }
      return {
        approved: true,
        decision: 'approve',
        reason: 'This stale audit result must be discarded.',
        riskCodes: [],
        metadata: { provider: 'embedded_audit_provider' },
      };
    },
    distillProviders: {
      embedded_audit_lease_provider: async () => ({
        summaryShort: 'Embedded audit lease checkpoint.',
        summaryText: 'The audit loses its job lease after checkpoint commit.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'embedded-audit-lease',
            content: 'Lease loss must escape embedded closeout audit.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'embedded-audit-lease-repo', sessionId: 'embedded-audit-lease-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Create a closeout candidate before lease takeover.' });
  const submitted = app.submitDistillJob({ ...source, auditTrigger: 'manual_closeout', maxAttempts: 2 });
  submittedJobId = submitted.jobId;
  const processed = await app.processJobs({ workerId: 'stable-closeout-worker', leaseMs: 1000 });
  assert.equal(processed.failed, 1);
  assert.equal(processed.succeeded, 0);
  assert.equal(processed.jobs[0].status, 'queued');
  assert.equal(processed.jobs[0].attempts, 1);
  let [candidate] = app.listMemoryCandidates({ ...source, status: 'pending' });
  assert.equal(candidate.reviewedAt, null);
  assert.equal(candidate.auditState, 'failed_retryable');
  const [retryableJobCandidate] = app.getJob({ jobId: submittedJobId }).candidates;
  assert.equal(retryableJobCandidate.status, 'failed_retryable');
  const replacement = await app.processJobs({ workerId: 'stable-closeout-worker', leaseMs: 1000 });
  assert.equal(replacement.succeeded, 1);
  assert.equal(replacement.jobs[0].status, 'succeeded');
  assert.equal(replacement.jobs[0].attempts, 2);
  assert.equal(replacement.jobs[0].result.checkpointId != null, true);
  [candidate] = app.listMemoryCandidates({ ...source, status: 'pending' });
  assert.ok(candidate.reviewedAt);
  assert.equal(candidate.auditState, 'audited');
  const [completedJobCandidate] = app.getJob({ jobId: submittedJobId }).candidates;
  assert.deepEqual({ status: completedJobCandidate.status, attempt: completedJobCandidate.attempt }, { status: 'succeeded', attempt: 2 });
  assert.equal(auditInvocations, 2);
  const [recoveredRun] = app.listDistillRuns(source);
  assert.equal(recoveredRun.status, 'succeeded');
  assert.equal(recoveredRun.outputMetadata.candidateAuditRecovered, true);
});

test('durable distill jobs retry embedded closeout audit provider failures', async () => {
  const dataDir = await makeTempDir();
  let auditInvocations = 0;
  let distillInvocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'embedded_audit_retry_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '6',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditInvocations += 1;
      if (auditInvocations <= 5) throw new ProviderTimeoutError('embedded_audit_provider', 10);
      return {
        approved: true,
        decision: 'approve',
        reason: 'Embedded audit retry succeeded.',
        riskCodes: [],
        metadata: { provider: 'embedded_audit_provider' },
      };
    },
    distillProviders: {
      embedded_audit_retry_provider: async () => {
        distillInvocations += 1;
        return {
          summaryShort: `Embedded audit retry checkpoint ${distillInvocations}.`,
          summaryText: 'The job checkpoint remains unique while an older checkpoint candidate audit retries.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates:
            distillInvocations === 1
              ? Array.from({ length: 5 }, (_, index) => ({
                    key: `embedded-audit-retry-${index + 1}`,
                    content: `Retry older checkpoint candidate ${index + 1} without redistilling the job checkpoint.`,
                    category: 'runbook',
                    candidateType: 'runbook',
                    confidence: 0.96,
                    stability: 0.96,
                    sensitivity: 'low',
                    promotionRecommendation: 'promote',
                  }))
              : [],
        };
      },
    },
  });
  const source = { scope: 'repo', scopeKey: 'embedded-audit-retry-repo', sessionId: 'embedded-audit-retry-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Create an older checkpoint candidate.' });
  await app.distillCheckpoint(source);
  app.appendRaw({ ...source, role: 'assistant', content: 'Create the job checkpoint before auditing the older candidate.' });
  const submitted = app.submitDistillJob({ ...source, auditTrigger: 'manual_closeout', maxAttempts: 2 });

  const first = await app.processJobs({ workerId: 'embedded-retry-worker-1', leaseMs: 1000 });
  assert.equal(first.failed, 1);
  assert.equal(first.requeued, 1);
  assert.equal(first.jobs[0].status, 'queued');
  assert.equal(first.jobs[0].result.candidateAudit.needsRetry, true);
  assert.equal(first.jobs[0].result.candidateAudit.retryableFailureCount, 5);
  assert.equal(app.listCheckpoints(source).length, 2);
  const retryableCandidates = app.getJob({ jobId: submitted.jobId }).candidates;
  assert.equal(retryableCandidates.length, 5);
  assert.ok(retryableCandidates.every((candidate) => candidate.status === 'failed_retryable'));

  const second = await app.processJobs({ workerId: 'embedded-retry-worker-2', leaseMs: 1000 });
  assert.equal(second.succeeded, 1);
  assert.equal(second.jobs[0].status, 'succeeded');
  assert.equal(second.jobs[0].attempts, 2);
  assert.equal(second.jobs[0].result.candidateAudit.needsRetry, false);
  const checkpoints = app.listCheckpoints(source);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints.filter((checkpoint) => checkpoint.metadata.operationJobId).length, 1);
  const candidates = app.listMemoryCandidates({ ...source, status: 'pending' });
  assert.equal(candidates.length, 5);
  assert.ok(candidates.every((candidate) => candidate.reviewMetadata.audit.decision === 'approve'));
  const completedCandidates = app.getJob({ jobId: submitted.jobId }).candidates;
  assert.ok(completedCandidates.every((candidate) => candidate.status === 'succeeded' && candidate.attempt === 2));
  assert.equal(auditInvocations, 10);
  assert.equal(distillInvocations, 2);
});

test('durable audit jobs persist job provenance without promoting memory', async () => {
  const dataDir = await makeTempDir();
  let auditInvocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_job_source_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditInvocations += 1;
      if (auditInvocations === 1) {
        throw new ProviderTimeoutError('audit_job_provider', 10);
      }
      return {
        approved: true,
        decision: 'approve',
        reason: 'Synthetic durable audit approval.',
        riskCodes: [],
        metadata: {
          provider: 'audit_job_provider',
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        },
      };
    },
    distillProviders: {
      audit_job_source_provider: async () => ({
        summaryShort: 'Audit job source.',
        summaryText: 'A candidate waits for the durable audit worker.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'durable-audit-runbook',
            content: 'Submit audit provider work through a durable job.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'durable-audit-repo', sessionId: 'durable-audit-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Create one audit candidate.' });
  await app.distillCheckpoint(source);
  app.appendRaw({ ...source, role: 'assistant', content: 'Create the latest closeout checkpoint.' });
  const checkpoint = await app.distillCheckpoint(source);
  const submitted = app.submitAuditJob({
    ...source,
    trigger: 'manual_closeout',
    maxAttempts: 2,
  });
  assert.equal(submitted.job.checkpointId, null);
  assert.equal(submitted.job.payload.sourceMode, 'session');
  assert.equal(submitted.job.metadata.sourceFingerprint.candidateIds.length, 2);
  assert.equal(auditInvocations, 0);
  const firstAttempt = await app.processJobs({ workerId: 'audit-worker-1', operation: 'audit_memory_candidates' });
  assert.equal(firstAttempt.failed, 1);
  assert.equal(firstAttempt.requeued, 1);
  assert.equal(firstAttempt.jobs[0].status, 'queued');
  assert.equal(firstAttempt.jobs[0].result.audit.needsRetry, true);
  const processed = await app.processJobs({ workerId: 'audit-worker-2', operation: 'audit_memory_candidates' });
  assert.equal(processed.succeeded, 1);
  assert.equal(auditInvocations, 3);
  const [candidate] = app.listMemoryCandidates({ ...source, checkpointId: checkpoint.id, status: 'pending' });
  assert.equal(candidate.reviewMetadata.auditMetadata.operationJobId, submitted.jobId);
  assert.equal(candidate.auditState, 'audited');
  assert.equal(candidate.auditDecision, 'approve');
  assert.equal(app.getMemory({ ...source, key: 'durable-audit-runbook' }), null);
  const usage = app.listLlmUsageEvents({ ...source, jobId: submitted.jobId });
  assert.equal(usage.length, 2);
  assert.ok(usage.every((event) => event.operation === 'candidate_audit'));
  const attempts = app.listMemoryCandidateAuditAttempts({ ...source, candidateId: candidate.id });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].operationJobId, submitted.jobId);
  assert.equal(attempts[0].state, 'audited');
  assert.equal(attempts[1].state, 'failed_retryable');
});
