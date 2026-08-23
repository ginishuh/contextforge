import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { operationByName } from '../src/operations/registry.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';
import { makeTempDir } from './helpers/temp.js';

function memoryCandidate(key) {
  return {
    key,
    content: `${key} is a stable reusable rule.`,
    reason: 'Keep this candidate available for later review.',
    category: 'runbook',
    confidence: 0.9,
    stability: 0.9,
    sensitivity: 'low',
    promotionRecommendation: 'review',
  };
}

test('candidate snooze requires a finite epoch and expired wake-up is bounded and idempotent', () => {
  const dataDirPromise = makeTempDir();
  return dataDirPromise.then((dataDir) => {
    const store = new ContextForgeStore({ dataDir });
    const app = createContextForge({
      env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_CANDIDATE_SNOOZE_MAX_MS: '120000' },
      cwd: process.cwd(), store,
    });
    const scope = { scope: 'repo', scopeType: 'repo', scopeKey: 'snooze-repo' };
    const sessionId = 'codex:snooze-session';
    const raw = app.appendRaw({ ...scope, sessionId, role: 'assistant', content: 'Create snooze candidates.' });
    store.insertCheckpoint({
      ...scope, sessionId, summaryShort: 'Snooze candidates.', summaryText: 'Two candidates for snooze transitions.',
      provider: 'synthetic_provider', coversFrom: raw.createdAt, coversTo: raw.createdAt, sourceEventCount: 1,
      metadata: { sourceRawEventIds: [raw.id], memoryCandidates: [memoryCandidate('first'), memoryCandidate('second')] },
    });
    const [first, second] = app.listMemoryCandidates({ ...scope, sessionId, status: 'pending' });

    assert.throws(
      () => app.snoozeMemoryCandidate({
        ...scope, candidateId: first.id, snoozedUntil: new Date(Date.now() - 1000).toISOString(),
        reason: 'Invalid past snooze.', actor: 'reviewer-1',
      }),
      /must be in the future/,
    );
    assert.throws(
      () => app.snoozeMemoryCandidate({
        ...scope, candidateId: first.id, snoozedUntil: new Date(Date.now() + 121000).toISOString(),
        reason: 'Invalid excessive snooze.', actor: 'reviewer-1',
      }),
      /no more than 120000ms/,
    );
    store.db.prepare("UPDATE memory_candidate_index SET audit_state = 'queued' WHERE id = ?").run(second.id);
    assert.throws(
      () => app.snoozeMemoryCandidate({
        ...scope, candidateId: second.id, snoozedUntil: new Date(Date.now() + 60000).toISOString(),
        reason: 'Do not race the active audit.', actor: 'reviewer-1',
      }),
      (error) => error.code === 'CONTEXTFORGE_CANDIDATE_AUDIT_ACTIVE',
    );
    const getMemoryCandidate = store.getMemoryCandidate.bind(store);
    let staleRead = true;
    store.getMemoryCandidate = (options) => {
      const candidate = getMemoryCandidate(options);
      if (staleRead && candidate?.id === second.id) {
        staleRead = false;
        return { ...candidate, auditState: 'unaudited' };
      }
      return candidate;
    };
    assert.throws(
      () => app.snoozeMemoryCandidate({
        ...scope, candidateId: second.id, snoozedUntil: new Date(Date.now() + 60000).toISOString(),
        reason: 'Fence a stale audit-state read.', actor: 'reviewer-1',
      }),
      (error) => error.code === 'CONTEXTFORGE_CANDIDATE_TRANSITION_RACE',
    );
    store.getMemoryCandidate = getMemoryCandidate;

    const future = new Date(Date.now() + 60000).toISOString();
    const snoozed = app.snoozeMemoryCandidate({
      ...scope, candidateId: first.id, snoozedUntil: future, reason: 'Review after the deployment.', actor: 'reviewer-1',
    });
    assert.equal(snoozed.candidate.status, 'snoozed');
    assert.equal(snoozed.candidate.snoozedUntil, future);
    assert.equal(snoozed.candidate.wakeUpStatus, 'pending');
    assert.equal(snoozed.candidate.reviewMetadata.lifecycleEvents[0].type, 'snoozed');
    assert.equal(app.snoozeMemoryCandidate({
      ...scope, candidateId: first.id, snoozedUntil: future,
      reason: 'Review after the deployment.', actor: 'reviewer-1',
    }).deduplicated, true);
    assert.equal(app.listDueCandidateWakeups({ ...scope }).dueCount, 0);
    assert.throws(() => app.processDueCandidateWakeups(), /explicit canonical scope/);

    const expiredAt = new Date(Date.now() - 1000).toISOString();
    store.db.prepare('UPDATE memory_candidate_index SET snoozed_until = ? WHERE id = ?').run(expiredAt, first.id);
    const dryRun = app.processDueCandidateWakeups({ ...scope, dryRun: true, limit: 1 });
    assert.equal(dryRun.dueCount, 1);
    assert.equal(dryRun.woken, 0);
    assert.equal(app.listMemoryCandidates({ ...scope, status: 'snoozed' }).length, 1);

    const processed = app.processDueCandidateWakeups({
      ...scope, limit: 1, actor: 'snooze-worker', reason: 'Snooze SLA expired.',
    });
    assert.deepEqual(
      { limit: processed.limit, dueCount: processed.dueCount, woken: processed.woken, skipped: processed.skipped, failed: processed.failed },
      { limit: 1, dueCount: 1, woken: 1, skipped: 0, failed: 0 },
    );
    const woken = app.listMemoryCandidates({ ...scope, status: 'pending' }).find((candidate) => candidate.id === first.id);
    assert.equal(woken.snoozedUntil, null);
    assert.equal(woken.snoozeReason, null);
    assert.equal(woken.snoozedBy, null);
    assert.equal(woken.wakeUpStatus, null);
    assert.equal(woken.reviewedAt, null);
    assert.equal(woken.reviewReason, null);
    assert.deepEqual(woken.reviewMetadata.lifecycleEvents.map((event) => event.type), ['snoozed', 'woken']);
    assert.equal(woken.reviewMetadata.lifecycleEvents[1].snoozedUntil, expiredAt);
    assert.equal(app.processDueCandidateWakeups({ ...scope }).dueCount, 0);

    const secondFuture = new Date(Date.now() + 120000).toISOString();
    app.snoozeMemoryCandidate({
      ...scope, candidateId: first.id, snoozedUntil: secondFuture, reason: 'Pause again.', actor: 'reviewer-2',
    });
    const reopened = app.wakeMemoryCandidate({
      ...scope, candidateId: first.id, reason: 'Manual review resumed early.', actor: 'reviewer-2',
    });
    assert.equal(reopened.candidate.status, 'pending');
    assert.equal(app.wakeMemoryCandidate({
      ...scope, candidateId: first.id, reason: 'Manual review resumed early.', actor: 'reviewer-2',
    }).deduplicated, true);
    assert.deepEqual(
      reopened.candidate.reviewMetadata.lifecycleEvents.map((event) => event.type),
      ['snoozed', 'woken', 'snoozed', 'woken'],
    );
    app.close();
  });
});

test('candidate snooze operations have scoped review and operator contracts', async () => {
  assert.deepEqual(
    ['snoozeMemoryCandidate', 'wakeMemoryCandidate', 'listDueCandidateWakeups'].map((name) => ({
      name, capability: operationByName(name).capability, scopeMode: operationByName(name).scopeMode,
    })),
    [
      { name: 'snoozeMemoryCandidate', capability: 'review', scopeMode: 'scoped' },
      { name: 'wakeMemoryCandidate', capability: 'review', scopeMode: 'scoped' },
      { name: 'listDueCandidateWakeups', capability: 'review', scopeMode: 'scoped' },
    ],
  );
  assert.deepEqual(
    { capability: operationByName('processDueCandidateWakeups').capability, scopeMode: operationByName('processDueCandidateWakeups').scopeMode },
    { capability: 'operator', scopeMode: 'scoped' },
  );
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  assert.throws(() => app.processDueCandidateWakeups({ scope: 'repo' }), /explicit canonical scope/);
  app.close();
});
