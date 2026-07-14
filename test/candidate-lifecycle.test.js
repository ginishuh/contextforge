import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

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
  assert.equal(secondPage.summaryIncluded, false);
  assert.equal(secondPage.summary, null);
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
  assert.equal(audited.summary.approvedAwaitingPromotionCount, 2);
  assert.equal(audited.summary.filteredCandidateCount, 2);
  assert.ok(audited.page.items.every((candidate) => candidate.auditContentHash));
  assert.ok(
    app.listMemoryCandidateAuditAttempts({
      scope: source.scope,
      scopeKey: source.scopeKey,
      candidateId: audited.page.items[0].id,
    }).every((attempt) => attempt.sourceMode === 'backlog_batch'),
  );

  app.promoteMemoryCandidate({
    scope: source.scope,
    scopeKey: source.scopeKey,
    candidateId: audited.page.items[0].id,
  });
  const pendingAfterPromotion = app.memoryCandidateBacklog({
    scope: source.scope,
    scopeKey: source.scopeKey,
    status: 'pending',
  });
  assert.equal(pendingAfterPromotion.summary.filteredCandidateCount, 1);
  assert.equal(pendingAfterPromotion.summary.byAuditDecision.approve, 1);
  assert.equal(pendingAfterPromotion.summary.approvedAwaitingPromotionCount, 1);

  app.appendRaw({ ...source, role: 'assistant', content: 'Third candidate for configuration drift fencing.' });
  const driftCheckpoint = await app.distillCheckpoint(source);
  const [driftCandidate] = app.listMemoryCandidates({
    ...source,
    checkpointId: driftCheckpoint.id,
    status: 'pending',
  });
  const partialSubmission = app.submitAuditJob({
    scope: source.scope,
    scopeKey: source.scopeKey,
    candidateIds: [audited.page.items[1].id, driftCandidate.id],
    trigger: 'manual_closeout',
    limit: 2,
  });
  assert.deepEqual(partialSubmission.selection.submittedCandidateIds, [driftCandidate.id]);
  assert.deepEqual(partialSubmission.selection.skippedCandidates, [{
    candidateId: audited.page.items[1].id,
    auditState: 'audited',
    reason: 'audit_state_ineligible',
  }]);
  app.cancelJob({ jobId: partialSubmission.jobId, reason: 'Reset the partial-selection test job.' });
  const driftSubmission = app.submitAuditJob({
    scope: source.scope,
    scopeKey: source.scopeKey,
    candidateIds: [driftCandidate.id],
    trigger: 'manual_closeout',
    idempotencyKey: 'configuration-drift-after-partial-selection',
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

test('legacy candidate audit backfill processes more than one bounded batch', async () => {
  const dataDir = await makeTempDir();
  const legacyStore = new ContextForgeStore({ dataDir });
  const reviewedAt = new Date().toISOString();
  const reviewMetadata = JSON.stringify({
    audit: {
      approved: true,
      decision: 'approve',
      reason: 'Legacy audit approval.',
      riskCodes: [],
      metadata: { provider: 'legacy_provider', model: 'legacy-model' },
    },
    auditMetadata: { sourceMode: 'session_pending_batch' },
    auditedAt: reviewedAt,
  });
  const checkpoint = legacyStore.insertCheckpoint({
    scopeType: 'repo',
    scopeKey: 'legacy-backfill-repo',
    sessionId: 'legacy-backfill-session',
    summaryShort: 'Legacy audit backfill checkpoint.',
    summaryText: 'Synthetic legacy candidates cross the bounded backfill batch boundary.',
    provider: 'legacy_provider',
  });
  const insert = legacyStore.db.prepare(`
    INSERT INTO memory_candidate_index (
      id, checkpoint_id, session_id, scope_type, scope_key, candidate_index,
      candidate_key, candidate_content, category, candidate_json,
      reviewed_at, review_metadata_json, created_at
    ) VALUES (?, ?, ?, 'repo', 'legacy-backfill-repo', ?, ?, ?, 'runbook', ?, ?, ?, ?)
  `);
  legacyStore.withTransaction(() => {
    for (let index = 0; index < 251; index += 1) {
      const key = `legacy-backfill-${String(index).padStart(3, '0')}`;
      const content = `Legacy audited candidate ${index}.`;
      insert.run(
        key, checkpoint.id, 'legacy-backfill-session', index, key, content,
        JSON.stringify({ key, content, category: 'runbook', tags: [] }),
        reviewedAt, reviewMetadata, reviewedAt,
      );
    }
  });
  legacyStore.db.prepare("DELETE FROM schema_meta WHERE key = 'memory_candidate_audit_state_backfill_completed_at'").run();
  legacyStore.close();

  const migrated = new ContextForgeStore({ dataDir });
  assert.equal(
    migrated.db.prepare("SELECT COUNT(*) AS count FROM memory_candidate_index WHERE audit_state = 'audited'").get().count,
    251,
  );
  assert.equal(migrated.db.prepare('SELECT COUNT(*) AS count FROM memory_candidate_audit_attempts').get().count, 251);
  assert.equal(
    migrated.db.prepare("SELECT COUNT(*) AS count FROM memory_candidate_audit_attempts WHERE source_mode = 'session'").get().count,
    251,
  );
  migrated.close();
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
