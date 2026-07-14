import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { operationByName } from '../src/operations/registry.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-candidate-stale-sla-test-'));
}

function memoryCandidate(key) {
  return {
    key,
    content: `${key} is review material for the stale SLA test.`,
    reason: 'Exercise bounded candidate lifecycle convergence.',
    category: 'runbook',
    confidence: 0.9,
    stability: 0.9,
    sensitivity: 'low',
    promotionRecommendation: 'review',
  };
}

function slaEnv(dataDir) {
  const env = { CONTEXTFORGE_DATA_DIR: dataDir };
  for (const name of [
    'UNAUDITED', 'TRIAGED_NO_AUDIT', 'FAILED_RETRYABLE', 'FAILED_TERMINAL',
    'LEGACY_UNKNOWN', 'APPROVED', 'NEEDS_REVIEW', 'REJECT_RECOMMENDED', 'AUDITED_UNKNOWN',
  ]) {
    env[`CONTEXTFORGE_CANDIDATE_SLA_${name}_MS`] = '60000';
  }
  return env;
}

test('candidate stale SLA inventory is bounded and transitions with queue and anchor fencing', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({ env: slaEnv(dataDir), cwd: process.cwd(), store });
  const scope = { scope: 'repo', scopeType: 'repo', scopeKey: 'stale-sla-repo' };
  const sessionId = 'codex:stale-sla-session';
  const raw = app.appendRaw({ ...scope, sessionId, role: 'assistant', content: 'Create stale SLA candidates.' });
  store.insertCheckpoint({
    ...scope,
    sessionId,
    summaryShort: 'Stale SLA candidates.',
    summaryText: 'Old, recent, audited, and active candidates.',
    provider: 'synthetic_provider',
    coversFrom: raw.createdAt,
    coversTo: raw.createdAt,
    sourceEventCount: 1,
    metadata: {
      sourceRawEventIds: [raw.id],
      memoryCandidates: [
        memoryCandidate('old-unaudited'),
        memoryCandidate('old-needs-review'),
        memoryCandidate('old-race'),
        memoryCandidate('active-audit'),
        memoryCandidate('recent-unaudited'),
      ],
    },
  });
  const candidates = app.listMemoryCandidates({ ...scope, sessionId, status: 'pending' });
  const byKey = new Map(candidates.map((candidate) => [candidate.candidate.key, candidate]));
  const oldAt = new Date(Date.now() - 120000).toISOString();
  store.db.prepare(`
    UPDATE memory_candidate_index SET created_at = ?
    WHERE id IN (?, ?, ?, ?)
  `).run(
    oldAt,
    byKey.get('old-unaudited').id,
    byKey.get('old-needs-review').id,
    byKey.get('old-race').id,
    byKey.get('active-audit').id,
  );
  store.db.prepare(`
    UPDATE memory_candidate_index
    SET audit_state = 'audited', audit_decision = 'needs_review', reviewed_at = ?, review_reason = ?
    WHERE id = ?
  `).run(oldAt, 'Human review is required.', byKey.get('old-needs-review').id);
  store.db.prepare("UPDATE memory_candidate_index SET audit_state = 'queued' WHERE id = ?")
    .run(byKey.get('active-audit').id);

  const inventory = app.listDueCandidateStaleTransitions({ ...scope, limit: 2 });
  assert.equal(inventory.totalDueCount, 3);
  assert.equal(inventory.dueCount, 2);
  assert.equal(inventory.remainingCount, 1);
  assert.ok(inventory.candidates.every((item) => item.ageMs >= item.slaMs));
  assert.throws(() => app.processDueCandidateStaleTransitions(), /explicit canonical scope/);
  const dryRun = app.processDueCandidateStaleTransitions({ ...scope, dryRun: true, limit: 10 });
  assert.equal(dryRun.dueCount, 3);
  assert.equal(dryRun.staled, 0);
  assert.equal(app.listMemoryCandidates({ ...scope, status: 'stale' }).length, 0);

  const originalGet = store.getMemoryCandidate.bind(store);
  let raceReads = 0;
  store.getMemoryCandidate = (options) => {
    const candidate = originalGet(options);
    if (candidate?.id === byKey.get('old-race').id) {
      raceReads += 1;
      if (raceReads === 2) {
        store.db.prepare("UPDATE memory_candidate_index SET audit_state = 'queued' WHERE id = ?").run(candidate.id);
        return candidate;
      }
    }
    return candidate;
  };
  const processed = app.processDueCandidateStaleTransitions({
    ...scope,
    limit: 10,
    actor: 'stale-sla-worker',
    requestId: 'stale-sla-batch-1',
  });
  store.getMemoryCandidate = originalGet;
  assert.deepEqual(
    { totalDueCount: processed.totalDueCount, dueCount: processed.dueCount, staled: processed.staled, skipped: processed.skipped, failed: processed.failed },
    { totalDueCount: 3, dueCount: 3, staled: 2, skipped: 1, failed: 0 },
  );
  assert.equal(processed.results.find((item) => item.candidateId === byKey.get('old-race').id).status, 'skipped');
  assert.equal(app.listMemoryCandidates({ ...scope, status: 'pending' }).some((candidate) => candidate.id === byKey.get('active-audit').id), true);
  assert.equal(app.listMemoryCandidates({ ...scope, status: 'pending' }).some((candidate) => candidate.id === byKey.get('recent-unaudited').id), true);

  const staledAudited = app.listMemoryCandidates({ ...scope, status: 'stale' })
    .find((candidate) => candidate.id === byKey.get('old-needs-review').id);
  assert.equal(staledAudited.auditState, 'audited');
  assert.equal(staledAudited.auditDecision, 'needs_review');
  assert.equal(staledAudited.reviewedAt, oldAt);
  assert.equal(staledAudited.reviewReason, 'Human review is required.');
  const staleEvent = staledAudited.reviewMetadata.lifecycleEvents.at(-1);
  assert.deepEqual(
    { type: staleEvent.type, queue: staleEvent.queue, actor: staleEvent.actor, requestId: staleEvent.requestId },
    { type: 'staled', queue: 'needsReview', actor: 'stale-sla-worker', requestId: 'stale-sla-batch-1' },
  );

  const reopened = app.reopenStaleMemoryCandidate({
    ...scope,
    candidateId: staledAudited.id,
    reason: 'A reviewer resumed the decision.',
    actor: 'reviewer-1',
  });
  assert.equal(reopened.candidate.status, 'pending');
  assert.equal(reopened.candidate.reviewedAt, oldAt);
  assert.equal(reopened.candidate.reviewReason, 'Human review is required.');
  assert.ok(reopened.candidate.reviewMetadata.candidateSlaAnchorAt > oldAt);
  assert.equal(app.reopenStaleMemoryCandidate({
    ...scope,
    candidateId: staledAudited.id,
    reason: 'A reviewer resumed the decision.',
    actor: 'reviewer-1',
  }).deduplicated, true);
  assert.equal(app.listDueCandidateStaleTransitions({ ...scope, limit: 10 }).candidates
    .some((item) => item.candidate.id === staledAudited.id), false);
  app.close();
});

test('candidate stale SLA operations have scoped review and operator contracts', async () => {
  assert.deepEqual(
    ['listDueCandidateStaleTransitions', 'reopenStaleMemoryCandidate'].map((name) => ({
      name,
      capability: operationByName(name).capability,
      scopeMode: operationByName(name).scopeMode,
    })),
    [
      { name: 'listDueCandidateStaleTransitions', capability: 'review', scopeMode: 'scoped' },
      { name: 'reopenStaleMemoryCandidate', capability: 'review', scopeMode: 'scoped' },
    ],
  );
  assert.deepEqual(
    {
      capability: operationByName('processDueCandidateStaleTransitions').capability,
      scopeMode: operationByName('processDueCandidateStaleTransitions').scopeMode,
    },
    { capability: 'operator', scopeMode: 'scoped' },
  );
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: slaEnv(dataDir), cwd: process.cwd() });
  assert.throws(() => app.processDueCandidateStaleTransitions({ scope: 'repo' }), /explicit canonical scope/);
  app.close();
});
