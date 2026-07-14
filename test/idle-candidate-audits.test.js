import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contextforge-idle-candidate-audit-test-'));
}

function candidate(key) {
  return {
    key,
    content: `${key} is a stable reusable runbook rule.`,
    reason: 'This rule is reusable across future runs.',
    category: 'runbook',
    candidateType: 'runbook',
    confidence: 0.96,
    stability: 0.96,
    sensitivity: 'low',
    promotionRecommendation: 'promote',
  };
}

function addCheckpoint(store, scope, rawEvent, key) {
  return store.insertCheckpoint({
    ...scope,
    summaryShort: `${key} checkpoint.`,
    summaryText: `One small session produced ${key}.`,
    provider: 'synthetic_provider',
    coversFrom: rawEvent.createdAt,
    coversTo: rawEvent.createdAt,
    sourceEventCount: 1,
    metadata: {
      sourceRawEventIds: [rawEvent.id],
      memoryCandidates: [candidate(key)],
    },
  });
}

test('idle candidate audits fence late events and queue small sessions without the batch threshold', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const auditor = async ({ candidate: indexed }) => ({
    approved: true,
    decision: 'approve',
    reason: `Approved ${indexed.candidate.key}.`,
    riskCodes: [],
    metadata: { provider: 'synthetic_auditor', model: 'synthetic-model' },
  });
  auditor.metadata = {
    provider: 'synthetic_auditor',
    model: 'synthetic-model',
    reasoningEffort: 'low',
    promptVersion: 'synthetic.v1',
  };
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
    store,
    autoPromoteAuditor: auditor,
  });
  const repo = { scope: 'repo', scopeType: 'repo', scopeKey: 'idle-audit-repo' };
  for (const sessionId of ['codex:small-1', 'cursor:small-2']) {
    const rawEvent = app.appendRaw({
      scope: repo.scope,
      scopeKey: repo.scopeKey,
      sessionId,
      role: 'assistant',
      content: `Create one candidate for ${sessionId}.`,
    });
    addCheckpoint(store, { ...repo, sessionId }, rawEvent, `${sessionId}-runbook`);
  }

  const active = app.listDueCandidateAudits({ ...repo, idleMs: 600000 });
  assert.equal(active.dueCount, 0);
  assert.deepEqual(active.skipReasonCounts, { idle_window: 2 });

  const due = app.listDueCandidateAudits({ ...repo, idleMs: 0 });
  assert.equal(due.dueCount, 2);
  assert.ok(due.sessions.every((session) => session.eligibleCandidateCount === 1));
  assert.ok(due.sessions.every((session) => session.sourceSignal === 'inferred_idle'));
  assert.ok(due.sessions.every((session) => session.sourceWatermark.rawEventFingerprint));
  assert.ok(due.sessions.every((session) => session.sourceWatermark.coversTo));
  await assert.rejects(
    app.processDueCandidateAudits({ idleMs: 0 }),
    /requires one explicit canonical scope/,
  );

  const dryRun = await app.processDueCandidateAudits({ ...repo, idleMs: 0, limit: 1, dryRun: true });
  assert.equal(dryRun.enqueued, 0);
  assert.equal(app.listJobs({ ...repo }).length, 0);

  const selected = due.sessions[0];
  app.appendRaw({
    scope: repo.scope,
    scopeKey: repo.scopeKey,
    sessionId: selected.sessionId,
    role: 'user',
    content: 'A late event resumes this session before the idle job is queued.',
  });
  assert.throws(
    () => app.submitAuditJob({
      ...repo,
      sessionId: selected.sessionId,
      trigger: 'idle_closeout',
      _expectedSourceWatermark: selected.sourceWatermark,
    }),
    (error) => error.code === 'CONTEXTFORGE_AUDIT_SOURCE_WATERMARK_CHANGED',
  );

  const queued = await app.processDueCandidateAudits({ ...repo, idleMs: 0, limit: 1 });
  assert.equal(queued.enqueued, 1);
  assert.equal(queued.failed, 0);
  const job = app.getJob({ ...repo, jobId: queued.results[0].jobId });
  assert.equal(job.payload.trigger, 'idle_closeout');
  assert.equal(job.payload.sourceMode, 'session');
  assert.equal(job.payload.sourceWatermark.rawEventCount, 2);
  assert.deepEqual(job.metadata.sourceFingerprint.sourceWatermark, job.payload.sourceWatermark);

  const processed = await app.processJobs({ operation: 'audit_memory_candidates', workerId: 'idle-audit-worker' });
  assert.equal(processed.succeeded, 1);
  const [audited] = app.listMemoryCandidates({
    ...repo,
    sessionId: selected.sessionId,
    status: 'pending',
  });
  assert.equal(audited.auditState, 'audited');
  const [attempt] = app.listMemoryCandidateAuditAttempts({ ...repo, candidateId: audited.id });
  assert.deepEqual(attempt.sourceWatermark, job.payload.sourceWatermark);

  const remaining = await app.processDueCandidateAudits({ ...repo, idleMs: 0, limit: 1 });
  assert.equal(remaining.enqueued, 1);
  await app.processJobs({ operation: 'audit_memory_candidates', workerId: 'idle-audit-worker' });

  const resumedRaw = app.appendRaw({
    scope: repo.scope,
    scopeKey: repo.scopeKey,
    sessionId: selected.sessionId,
    role: 'assistant',
    content: 'The resumed session produces a separate checkpoint epoch.',
  });
  addCheckpoint(store, { ...repo, sessionId: selected.sessionId }, resumedRaw, 'resumed-epoch-runbook');
  const next = await app.processDueCandidateAudits({ ...repo, idleMs: 0, limit: 1 });
  assert.equal(next.enqueued, 1);
  assert.equal(next.results[0].sessionId, selected.sessionId);
  assert.notEqual(next.results[0].jobId, job.id);
  assert.notEqual(next.results[0].sourceWatermark.rawEventFingerprint, job.payload.sourceWatermark.rawEventFingerprint);
  app.close();
});
