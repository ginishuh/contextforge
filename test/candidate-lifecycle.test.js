import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextForge } from '../src/core.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-candidate-lifecycle-test-'));
}

test('candidate backlog is read-only, paged, and submits an explicit bounded backlog batch', async () => {
  const dataDir = await makeTempDir();
  let distillCount = 0;
  let auditInvocations = 0;
  const auditor = async ({ candidate }) => {
    auditInvocations += 1;
    return {
      approved: true,
      decision: 'approve',
      reason: `Approved ${candidate.candidate.key}.`,
      riskCodes: [],
      metadata: { provider: 'synthetic_auditor', model: 'synthetic-model' },
    };
  };
  auditor.metadata = {
    provider: 'synthetic_auditor',
    model: 'synthetic-model',
    reasoningEffort: 'low',
    promptVersion: 'synthetic.v1',
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'backlog_source_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      backlog_source_provider: async () => {
        distillCount += 1;
        return {
          summaryShort: `Backlog checkpoint ${distillCount}.`,
          summaryText: 'A synthetic candidate enters the review backlog.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [
            {
              key: `backlog-runbook-${distillCount}`,
              content: `Review backlog candidate ${distillCount} through a bounded durable job.`,
              category: 'runbook',
              candidateType: 'runbook',
              confidence: 0.96,
              stability: 0.96,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
          ],
        };
      },
    },
  });
  const source = { scope: 'repo', scopeKey: 'backlog-review-repo', sessionId: 'backlog-review-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'First backlog checkpoint.' });
  await app.distillCheckpoint(source);
  app.appendRaw({ ...source, role: 'assistant', content: 'Second backlog checkpoint.' });
  await app.distillCheckpoint(source);

  const firstPage = app.memoryCandidateBacklog({
    scope: source.scope,
    scopeKey: source.scopeKey,
    status: 'pending',
    limit: 1,
  });
  assert.equal(firstPage.summary.pendingCandidateCount, 2);
  assert.equal(firstPage.summary.byAuditState.unaudited, 2);
  assert.equal(firstPage.page.items.length, 1);
  assert.equal(firstPage.page.page.hasMore, true);
  const secondPage = app.memoryCandidateBacklog({
    scope: source.scope,
    scopeKey: source.scopeKey,
    status: 'pending',
    limit: 1,
    cursor: firstPage.page.page.nextCursor,
  });
  assert.equal(secondPage.page.items.length, 1);
  assert.notEqual(secondPage.page.items[0].id, firstPage.page.items[0].id);
  assert.equal(auditInvocations, 0);

  const candidateIds = [firstPage.page.items[0].id, secondPage.page.items[0].id];
  const submitted = app.submitAuditJob({
    scope: source.scope,
    scopeKey: source.scopeKey,
    candidateIds,
    trigger: 'manual_closeout',
    limit: 2,
  });
  assert.equal(submitted.job.payload.sourceMode, 'backlog_batch');
  assert.deepEqual(new Set(submitted.job.payload.candidateIds), new Set(candidateIds));
  assert.equal(submitted.job.metadata.requestedAuditConfiguration.model, 'synthetic-model');
  assert.ok(
    app.memoryCandidateBacklog({
      scope: source.scope,
      scopeKey: source.scopeKey,
      auditState: 'queued',
    }).page.items.every((candidate) => candidate.auditState === 'queued'),
  );

  const processed = await app.processJobs({ workerId: 'backlog-review-worker', operation: 'audit_memory_candidates' });
  assert.equal(processed.succeeded, 1);
  assert.equal(auditInvocations, 2);
  const audited = app.memoryCandidateBacklog({
    scope: source.scope,
    scopeKey: source.scopeKey,
    auditState: 'audited',
  });
  assert.equal(audited.page.items.length, 2);
  assert.equal(audited.summary.byAuditDecision.approve, 2);
  assert.ok(audited.page.items.every((candidate) => candidate.auditContentHash));

  app.appendRaw({ ...source, role: 'assistant', content: 'Third candidate for configuration drift fencing.' });
  const driftCheckpoint = await app.distillCheckpoint(source);
  const [driftCandidate] = app.listMemoryCandidates({
    ...source,
    checkpointId: driftCheckpoint.id,
    status: 'pending',
  });
  const driftSubmission = app.submitAuditJob({
    scope: source.scope,
    scopeKey: source.scopeKey,
    candidateIds: [driftCandidate.id],
    trigger: 'manual_closeout',
  });
  auditor.metadata.model = 'changed-after-submit';
  const driftResult = await app.processJobs({
    workerId: 'backlog-drift-worker',
    operation: 'audit_memory_candidates',
  });
  assert.equal(driftResult.failed, 1);
  assert.equal(auditInvocations, 2);
  const failedJob = app.getJob({ jobId: driftSubmission.jobId });
  assert.equal(failedJob.error.code, 'CONTEXTFORGE_AUDIT_CONFIGURATION_DRIFT');
  assert.equal(failedJob.candidates[0].status, 'failed_terminal');
  const [failedCandidate] = app.listMemoryCandidates({
    ...source,
    checkpointId: driftCheckpoint.id,
    status: 'pending',
  });
  assert.equal(failedCandidate.auditState, 'failed_terminal');
});

test('promotion invalidates audit approval when the reviewed candidate revision changes', async () => {
  const dataDir = await makeTempDir();
  const auditor = async () => ({
    approved: true,
    decision: 'approve',
    reason: 'Synthetic audit approved the original revision.',
    riskCodes: [],
    metadata: { provider: 'revision_auditor', model: 'revision-model' },
  });
  auditor.metadata = { provider: 'revision_auditor', model: 'revision-model' };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'revision_source_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      revision_source_provider: async () => ({
        summaryShort: 'Revision checkpoint.',
        summaryText: 'One candidate is audited before promotion.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'revision-bound-runbook',
            content: 'Promote only the candidate revision that was actually audited.',
            category: 'runbook',
            candidateType: 'runbook',
            tags: ['audit'],
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'revision-bound-repo', sessionId: 'revision-bound-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Create an audited revision.' });
  const checkpoint = await app.distillCheckpoint(source);
  await app.auditMemoryCandidates({ ...source, checkpointId: checkpoint.id, trigger: 'manual_closeout' });
  const [candidate] = app.listMemoryCandidates({ ...source, status: 'pending' });
  assert.equal(candidate.auditDecision, 'approve');
  assert.ok(candidate.auditContentHash);

  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: source.scope,
        scopeKey: source.scopeKey,
        candidateId: candidate.id,
        content: `${candidate.candidate.content} Edited after audit.`,
        allowWarnings: true,
      }),
    (error) => error.code === 'CONTEXTFORGE_CANDIDATE_AUDIT_REVISION_MISMATCH',
  );
  assert.equal(app.getMemory({ ...source, key: candidate.candidate.key }), null);

  const promoted = app.promoteMemoryCandidate({
    scope: source.scope,
    scopeKey: source.scopeKey,
    candidateId: candidate.id,
  });
  assert.equal(promoted.key, candidate.candidate.key);
  const [reviewed] = app.listMemoryCandidates({ ...source, status: 'promoted' });
  assert.equal(reviewed.reviewMetadata.audit.decision, 'approve');
  assert.equal(reviewed.reviewMetadata.latestAuditAttemptId, reviewed.latestAuditAttemptId);
});
