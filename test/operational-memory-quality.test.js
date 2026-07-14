import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { startContextForgeServer } from '../src/server.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-operational-quality-test-'));
}

test('readiness degrades only after queued work outlives the operation worker grace period', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_READINESS_WORKER_STALE_AFTER_MS: '1000',
    },
    cwd: process.cwd(),
    store,
  });
  const scope = { scope: 'repo', scopeKey: 'worker-freshness-repo', sessionId: 'worker-freshness-session' };
  app.appendRaw({ ...scope, role: 'assistant', content: 'Queue one worker freshness fixture.' });
  const submission = app.submitDistillJob(scope);

  assert.equal(app.readiness().checks.operationWorker.ok, true, 'new work receives a bounded startup grace period');
  store.db.prepare("UPDATE operation_jobs SET created_at = datetime('now', '-10 seconds') WHERE id = ?")
    .run(submission.job.id);
  const auditJob = store.enqueueOperationJob({
    operation: 'audit_memory_candidates',
    scopeType: 'repo',
    scopeKey: 'worker-freshness-repo',
    idempotencyKey: 'worker-freshness-audit',
  }).job;
  store.db.prepare("UPDATE operation_jobs SET created_at = datetime('now', '-10 seconds') WHERE id = ?")
    .run(auditJob.id);
  const stale = app.readiness();
  assert.equal(stale.ready, false);
  assert.equal(stale.checks.operationWorker.reason, 'operation_worker_stale');
  assert.equal(stale.checks.operationWorker.required, true);

  store.claimOperationJobs({
    workerId: 'fresh-distill-worker', leaseMs: 60000, operations: ['distill_checkpoint'],
  });
  const partiallyRecovered = app.readiness();
  assert.equal(partiallyRecovered.checks.operationWorker.ok, false);
  assert.deepEqual(partiallyRecovered.checks.operationWorker.staleOperations, ['audit_memory_candidates']);

  store.claimOperationJobs({
    workerId: 'fresh-audit-worker', leaseMs: 60000, operations: ['audit_memory_candidates'],
  });
  const recovered = app.readiness();
  assert.equal(recovered.checks.operationWorker.ok, true);
  assert.equal(recovered.checks.operationWorker.activeLeases, 2);
  app.close();
});

test('operational metrics track promotion quality, audit variants, duplicates, transient promotions, and retrieval use', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd(), store });
  const scope = { scope: 'repo', scopeType: 'repo', scopeKey: 'quality-repo' };
  const checkpoint = store.insertCheckpoint({
    ...scope,
    sessionId: 'quality-session',
    summaryShort: 'Quality metrics.',
    summaryText: 'Create reviewed synthetic candidates for quality metrics.',
    provider: 'synthetic-provider',
    sourceEventCount: 0,
    metadata: {
      memoryCandidates: [
        {
          key: 'quality.runbook', content: 'Use the first durable workflow.', category: 'runbook',
          candidateType: 'runbook', promotionRecommendation: 'promote', confidence: 0.95, stability: 0.95,
        },
        {
          key: 'quality.transient', content: 'PR #999 passed once.', category: 'project-status',
          candidateType: 'project-status', promotionRecommendation: 'promote', confidence: 0.95, stability: 0.95,
        },
      ],
    },
  });
  const candidates = app.listMemoryCandidates({ ...scope, checkpointId: checkpoint.id, status: 'pending' });
  for (const candidate of candidates) {
    store.markMemoryCandidateAudited({
      ...scope,
      candidateId: candidate.id,
      audit: {
        approved: true,
        decision: 'approve',
        reason: 'Synthetic quality approval.',
        riskCodes: [],
        metadata: { provider: 'synthetic-auditor', model: 'quality-model', promptVersion: 'quality.v1' },
      },
      reason: 'Synthetic quality approval.',
      metadata: { sourceMode: 'checkpoint', checkpointId: checkpoint.id },
    });
  }
  const runbook = candidates.find((candidate) => candidate.candidate.key === 'quality.runbook');
  const transient = candidates.find((candidate) => candidate.candidate.key === 'quality.transient');
  app.promoteMemoryCandidate({ ...scope, candidateId: runbook.id });
  app.promoteMemoryCandidate({
    ...scope,
    candidateId: transient.id,
    allowWarnings: true,
    reason: 'Synthetic unsafe promotion for metric coverage.',
  });
  app.correctMemory({ ...scope, key: 'quality.runbook', content: 'Use the corrected durable workflow.' });
  app.remember({ ...scope, key: 'quality.duplicate-a', content: 'Synthetic duplicate content.' });
  app.remember({ ...scope, key: 'quality.duplicate-b', content: 'Synthetic duplicate content.' });
  const results = await app.search({ ...scope, query: 'corrected durable workflow' });
  assert.equal(results.some((result) => result.type === 'memory' && result.memory.key === 'quality.runbook'), true);

  const quality = app.operationalMetrics().memoryLifecycle;
  assert.equal(quality.candidates.total, 2);
  assert.equal(quality.candidates.byStatus.promoted, 2);
  assert.equal(quality.candidates.conversionRate, 1);
  assert.equal(quality.promotionQuality.linkedPromotions, 2);
  assert.equal(quality.promotionQuality.correctedWithin7d, 1);
  assert.equal(quality.promotionQuality.transientPromotions, 1);
  assert.equal(quality.promotionQuality.duplicateActiveMemoryCount, 1);
  assert.ok(quality.retrievalUsage.retrievedActiveMemoryCount >= 1);
  assert.equal(quality.auditVariants[0].provider, 'synthetic-auditor');
  assert.equal(quality.auditVariants[0].approvalRate, 1);
  assert.equal(quality.auditVariants[0].correctionRate, 0.5);

  store.db.pragma('query_only = ON');
  const readOnlyResults = await app.search({ ...scope, query: 'corrected durable workflow' });
  assert.equal(readOnlyResults.some((result) => result.type === 'memory'), true);
  store.db.pragma('query_only = OFF');
  app.close();
});

test('Prometheus metrics expose bounded worker freshness and memory quality gauges', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_REMOTE_TOKEN: 'quality-token' },
  });
  try {
    const response = await fetch(`${remote.url}/metrics`, {
      headers: { authorization: 'Bearer quality-token' },
    });
    assert.equal(response.status, 200);
    const metrics = await response.text();
    assert.match(metrics, /contextforge_operation_worker_active_leases/);
    assert.match(metrics, /contextforge_memory_duplicate_active_rate/);
    assert.match(metrics, /contextforge_memory_retrieved_active_rate/);
  } finally {
    await remote.close();
  }
});
