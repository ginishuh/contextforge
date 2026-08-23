import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';
import { makeTempDir } from './helpers/temp.js';

function approve(store, scope, candidateId) {
  return store.markMemoryCandidateAudited({
    ...scope,
    candidateId,
    audit: {
      approved: true,
      decision: 'approve',
      reason: 'Synthetic reviewed approval.',
      riskCodes: [],
      metadata: { provider: 'synthetic-reviewer', model: 'synthetic-model' },
    },
    metadata: { sourceMode: 'backlog_batch', policyVersion: 'test.v1' },
  });
}

test('audited candidate routing is dry-run by default, idempotent, and closes applied source candidates', async () => {
  const dataDir = await makeTempDir();
  const scope = { scopeType: 'repo', scopeKey: 'audited-routing-repo' };
  const store = new ContextForgeStore({ dataDir });
  store.rememberMemory({ ...scope, key: 'routing.runbook', content: 'Use alpha for the durable workflow.', category: 'runbook' });
  const checkpoint = store.insertCheckpoint({
    ...scope,
    sessionId: 'routing-session',
    summaryShort: 'Routing candidates.',
    summaryText: 'Two refinements and one duplicate need deterministic routing.',
    provider: 'synthetic',
    metadata: {
      memoryCandidates: [
        {
          key: 'routing.runbook', content: 'Use alpha and beta for the durable workflow.', category: 'runbook',
          candidateType: 'runbook', promotionRecommendation: 'promote', suggestedAction: 'refinement',
          confidence: 0.95, stability: 0.95,
        },
        {
          key: 'routing.runbook', content: 'Use alpha and gamma for the durable workflow.', category: 'runbook',
          candidateType: 'runbook', promotionRecommendation: 'promote', suggestedAction: 'refinement',
          confidence: 0.95, stability: 0.95,
        },
        {
          key: 'routing.duplicate', content: 'Use alpha for the durable workflow.', category: 'runbook',
          candidateType: 'runbook', promotionRecommendation: 'promote', confidence: 0.95, stability: 0.95,
        },
        {
          key: 'routing.too-specific', content: 'Keep this only as checkpoint context.', category: 'runbook',
          candidateType: 'runbook', suggestedAction: 'too_specific', promotionRecommendation: 'promote',
          confidence: 0.95, stability: 0.95,
        },
        {
          key: 'routing.runbook', content: 'Replace the prior workflow with the newer delta workflow.', category: 'runbook',
          candidateType: 'runbook', suggestedAction: 'supersedes', promotionRecommendation: 'promote',
          confidence: 0.95, stability: 0.95,
        },
        {
          key: 'routing.runbook', content: 'This conflicts with the current workflow and needs review.', category: 'runbook',
          candidateType: 'runbook', suggestedAction: 'conflict', promotionRecommendation: 'promote',
          confidence: 0.95, stability: 0.95,
        },
      ],
    },
  });
  const indexed = store.listMemoryCandidates({ ...scope, checkpointId: checkpoint.id, status: 'pending', limit: 10 });
  indexed.forEach((candidate) => approve(store, scope, candidate.id));
  store.close();

  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const dryRun = app.routeAuditedMemoryCandidates({ scope: 'repo', scopeKey: scope.scopeKey, limit: 10 });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.counts.refinement, 2);
  assert.equal(dryRun.counts.duplicate, 1);
  assert.equal(dryRun.counts.too_specific, 1);
  assert.equal(dryRun.counts.supersedes, 1);
  assert.equal(dryRun.counts.conflict, 1);
  assert.equal(app.listMemoryUpdateCandidates({ scope: 'repo', scopeKey: scope.scopeKey }).length, 0);

  const applied = app.routeAuditedMemoryCandidates({
    scope: 'repo', scopeKey: scope.scopeKey, limit: 10, dryRun: false,
  });
  assert.equal(applied.policy.mutatesDurableMemory, false);
  for (const result of applied.results) {
    if (result.status !== 'routed') continue;
    const candidate = app.listMemoryCandidates({
      scope: 'repo', scopeKey: scope.scopeKey, status: 'pending', limit: 10,
    }).find((item) => item.id === result.candidateId);
    assert.equal(result.routing.auditAttemptId, candidate.latestAuditAttemptId);
    assert.equal(candidate.reviewMetadata.promotionRouting.auditAttemptId, candidate.latestAuditAttemptId);
  }
  assert.equal(applied.results.find((item) => item.routing.classification === 'duplicate').routing.updateCandidate, null);
  assert.equal(applied.results.find((item) => item.routing.classification === 'too_specific').routing.action, 'keep_as_checkpoint_context');
  const updates = app.listMemoryUpdateCandidates({ scope: 'repo', scopeKey: scope.scopeKey, status: 'pending' });
  assert.equal(updates.length, 4, 'separate source candidates for one target must not overwrite each other');
  const firstCreatedAt = updates[0].createdAt;

  const partial = app.routeAuditedMemoryCandidates({
    scope: 'repo', scopeKey: scope.scopeKey, candidateIds: ['missing-candidate', updates[0].sourceCandidateId],
  });
  assert.deepEqual(partial.results.find((item) => item.candidateId === 'missing-candidate'), {
    candidateId: 'missing-candidate', status: 'skipped', reason: 'candidate_not_found',
  });

  const rerun = app.routeAuditedMemoryCandidates({
    scope: 'repo', scopeKey: scope.scopeKey, candidateIds: [updates[0].sourceCandidateId], dryRun: false,
  });
  assert.equal(rerun.results[0].routing.updateCandidate.candidateId, updates[0].id);
  assert.equal(app.listMemoryUpdateCandidates({ scope: 'repo', scopeKey: scope.scopeKey, status: 'pending' }).length, 4);
  assert.equal(
    app.listMemoryUpdateCandidates({ scope: 'repo', scopeKey: scope.scopeKey, status: 'pending' })
      .find((candidate) => candidate.id === updates[0].id).createdAt,
    firstCreatedAt,
  );

  app.correctMemory({
    scope: 'repo', scopeKey: scope.scopeKey, key: 'routing.runbook',
    content: 'A concurrent reviewer changed the durable workflow.', reason: 'Synthetic target race.',
  });
  assert.throws(
    () => app.applyMemoryUpdateCandidate({
      scope: 'repo', scopeKey: scope.scopeKey, candidateId: updates[0].id, reason: 'Stale refinement.',
    }),
    (error) => error.code === 'CONTEXTFORGE_MEMORY_UPDATE_TARGET_CHANGED',
  );
  app.routeAuditedMemoryCandidates({
    scope: 'repo', scopeKey: scope.scopeKey, candidateIds: [updates[0].sourceCandidateId], dryRun: false,
  });
  const updateResult = app.applyMemoryUpdateCandidate({
    scope: 'repo', scopeKey: scope.scopeKey, candidateId: updates[0].id, reason: 'Reviewed refinement.',
  });
  assert.equal(updateResult.sourceCandidate.status, 'promoted');
  assert.equal(updateResult.sourceCandidate.promotedMemoryId, updateResult.memory.id);
  assert.equal(updateResult.memory.content, updates[0].proposedContent);
  assert.equal(updateResult.sourceCandidate.reviewMetadata.lifecycleEvents.at(-1).type, 'promotion_routing_resolved');
});

test('approved refinement audit creates a review-only update candidate without durable promotion', async () => {
  const dataDir = await makeTempDir();
  const auditor = async () => ({
    approved: true, decision: 'approve', reason: 'Refinement needs human update review.', riskCodes: [],
    metadata: { provider: 'synthetic-reviewer', model: 'synthetic-model' },
  });
  auditor.metadata = { provider: 'synthetic-reviewer', model: 'synthetic-model' };
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_DISTILL_PROVIDER: 'routing-provider' },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      'routing-provider': async () => ({
        summaryShort: 'Refinement audit.', summaryText: 'An existing runbook needs a reviewed refinement.',
        decisions: [], todos: [], openQuestions: [],
        memoryCandidates: [{
          key: 'audited.refinement', content: 'Use the reviewed second version.', category: 'runbook',
          candidateType: 'runbook', suggestedAction: 'refinement', promotionRecommendation: 'promote',
          confidence: 0.96, stability: 0.96, sensitivity: 'low',
        }],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'automatic-routing-repo', sessionId: 'automatic-routing-session' };
  app.remember({ ...source, key: 'audited.refinement', content: 'Use the first version.', category: 'runbook' });
  app.appendRaw({ ...source, role: 'assistant', content: 'Create a durable refinement candidate.' });
  const checkpoint = await app.distillCheckpoint(source);
  const audit = await app.auditMemoryCandidates({ ...source, checkpointId: checkpoint.id, trigger: 'manual_closeout' });
  assert.equal(audit.proposals[0].recommendedAction, 'review_update_candidate', JSON.stringify(audit.proposals[0]));
  assert.equal(audit.proposals[0].promotionRouting.classification, 'refinement');
  const [update] = app.listMemoryUpdateCandidates({ ...source, status: 'pending' });
  assert.equal(update.sourceCandidateId, audit.proposals[0].candidateId);
  assert.equal(app.getMemory({ ...source, key: 'audited.refinement' }).content, 'Use the first version.');
});

test('promotion rejects a stale route while a forced re-audit is queued and after rejection', async () => {
  const dataDir = await makeTempDir();
  let auditDecision = 'approve';
  const auditor = async () => ({
    approved: auditDecision === 'approve',
    decision: auditDecision,
    reason: `Synthetic ${auditDecision} decision.`,
    riskCodes: [],
    metadata: { provider: 'synthetic-reviewer', model: 'synthetic-model' },
  });
  auditor.metadata = { provider: 'synthetic-reviewer', model: 'synthetic-model' };
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_DISTILL_PROVIDER: 'stale-route-provider' },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      'stale-route-provider': async () => ({
        summaryShort: 'Stale route.', summaryText: 'A forced re-audit must invalidate the prior route.',
        decisions: [], todos: [], openQuestions: [],
        memoryCandidates: [{
          key: 'routing.stale', content: 'Use the reviewed durable route.', category: 'runbook',
          candidateType: 'runbook', promotionRecommendation: 'promote', confidence: 0.96, stability: 0.96,
          sensitivity: 'low',
        }],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'stale-routing-repo', sessionId: 'stale-routing-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Create a candidate for forced re-audit.' });
  const checkpoint = await app.distillCheckpoint(source);
  await app.auditMemoryCandidates({ ...source, checkpointId: checkpoint.id, trigger: 'manual_closeout' });
  const [approved] = app.listMemoryCandidates({ ...source, status: 'pending' });
  assert.equal(approved.reviewMetadata.promotionRouting.action, 'promote_as_new_memory');
  assert.equal(approved.reviewMetadata.promotionRouting.auditAttemptId, approved.latestAuditAttemptId);

  auditDecision = 'reject';
  app.submitAuditJob({
    scope: source.scope, scopeKey: source.scopeKey, candidateIds: [approved.id],
    trigger: 'manual_closeout', limit: 1, force: true,
  });
  const [queued] = app.listMemoryCandidates({ ...source, status: 'pending' });
  assert.equal(queued.auditState, 'queued');
  assert.throws(
    () => app.promoteMemoryCandidate({ ...source, candidateId: queued.id }),
    (error) => error.code === 'CONTEXTFORGE_CANDIDATE_PROMOTION_ROUTING_REQUIRED',
  );

  await app.processJobs({ workerId: 'stale-route-review-worker', operation: 'audit_memory_candidates' });
  const [rejected] = app.listMemoryCandidates({ ...source, status: 'pending' });
  assert.equal(rejected.auditState, 'audited');
  assert.equal(rejected.auditDecision, 'reject');
  assert.notEqual(rejected.latestAuditAttemptId, approved.latestAuditAttemptId);
  assert.equal(rejected.reviewMetadata.promotionRouting.auditAttemptId, approved.latestAuditAttemptId);
  assert.throws(
    () => app.promoteMemoryCandidate({ ...source, candidateId: rejected.id }),
    (error) => error.code === 'CONTEXTFORGE_CANDIDATE_PROMOTION_ROUTING_REQUIRED',
  );
});

test('routing persistence failure does not erase a successful immutable audit', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const originalCreate = store.createMemoryUpdateCandidate.bind(store);
  store.createMemoryUpdateCandidate = () => { throw new Error('synthetic routing write failure'); };
  const auditor = async () => ({
    approved: true, decision: 'approve', reason: 'Audit succeeded before routing.', riskCodes: [],
    metadata: { provider: 'synthetic-reviewer', model: 'synthetic-model' },
  });
  auditor.metadata = { provider: 'synthetic-reviewer', model: 'synthetic-model' };
  const app = createContextForge({
    store, env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_DISTILL_PROVIDER: 'failure-provider' },
    cwd: process.cwd(), autoPromoteAuditor: auditor,
    distillProviders: {
      'failure-provider': async () => ({
        summaryShort: 'Routing failure.', summaryText: 'Audit must survive a later routing failure.',
        decisions: [], todos: [], openQuestions: [],
        memoryCandidates: [{
          key: 'routing.failure', content: 'Use the revised durable rule.', category: 'runbook',
          candidateType: 'runbook', suggestedAction: 'refinement', promotionRecommendation: 'promote',
          confidence: 0.95, stability: 0.95, sensitivity: 'low',
        }],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'routing-failure-repo', sessionId: 'routing-failure-session' };
  app.remember({ ...source, key: 'routing.failure', content: 'Use the original durable rule.', category: 'runbook' });
  app.appendRaw({ ...source, role: 'assistant', content: 'Create the refinement.' });
  const checkpoint = await app.distillCheckpoint(source);
  const result = await app.auditMemoryCandidates({ ...source, checkpointId: checkpoint.id, trigger: 'manual_closeout' });
  assert.match(result.proposals[0].promotionRoutingError?.message || JSON.stringify(result.proposals[0]), /synthetic routing write failure/);
  assert.equal(result.proposals[0].recommendedAction, 'route_before_promote');
  const [candidate] = app.listMemoryCandidates({ ...source, checkpointId: checkpoint.id, status: 'pending' });
  assert.equal(candidate.auditState, 'audited');
  assert.equal(candidate.auditDecision, 'approve');
  assert.equal(app.listMemoryCandidateAuditAttempts({ ...source, candidateId: candidate.id }).length, 1);
  store.createMemoryUpdateCandidate = originalCreate;
});
