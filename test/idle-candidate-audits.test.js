import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextForge } from '../src/core.js';
import { processIdleCandidateAudits } from '../src/memory/idle_candidate_audits.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';
import { makeTempDir } from './helpers/temp.js';

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

  const oldRawAt = new Date(Date.now() - 60000).toISOString();
  store.db.prepare('UPDATE raw_events SET created_at = ? WHERE session_id = ?').run(oldRawAt, 'codex:small-1');
  const rawIdle = app.listDueCandidateAudits({ ...repo, idleMs: 30000 });
  assert.equal(rawIdle.dueCount, 1);
  assert.equal(rawIdle.sessions[0].sessionId, 'codex:small-1');
  assert.equal(rawIdle.sessions[0].lastRawEventAt, oldRawAt);
  assert.ok(Date.parse(rawIdle.sessions[0].latestCheckpointAt) > Date.parse(oldRawAt));

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
  const distillJob = app.submitDistillJob({ ...repo, sessionId: selected.sessionId });
  assert.deepEqual(Object.keys(distillJob.job.metadata.sourceFingerprint).sort(), [
    'lastRawEventId',
    'latestCheckpointId',
    'rawEventCount',
  ]);

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

test('idle candidate audit batch counters classify every due session exactly once', async () => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    scopeType: 'repo',
    scopeKey: 'counter-repo',
    sessionId: `counter-session-${index + 1}`,
    eligibleCandidateCount: 1,
    sourceWatermark: { version: 'candidate-audit-source.v1', rawEventFingerprint: `fingerprint-${index + 1}` },
  }));
  const submissions = [
    { deduplicated: false, requeued: false, status: 'queued' },
    { deduplicated: true, requeued: true, status: 'queued' },
    { deduplicated: true, requeued: false, status: 'queued' },
    { deduplicated: true, requeued: false, status: 'succeeded' },
  ];
  const app = {
    listDueCandidateAudits: () => ({
      asOf: new Date().toISOString(), scanLimit: 50, idleMs: 0, batchLimit: 5,
      scanned: sessions.length, dueCount: sessions.length, skippedCount: 0,
      skipReasonCounts: {}, sessions,
    }),
    submitAuditJob: () => {
      const submission = submissions.shift();
      if (!submission) {
        const error = new Error('The source was drained by another worker.');
        error.code = 'CONTEXTFORGE_NO_ELIGIBLE_CANDIDATES';
        throw error;
      }
      return {
        ...submission,
        jobId: `job-${submissions.length}`,
        selection: { submittedCandidateIds: ['candidate-1'] },
      };
    },
  };
  const result = await processIdleCandidateAudits({ app, options: { scope: 'repo', scopeKey: 'counter-repo' } });
  assert.deepEqual(
    {
      enqueued: result.enqueued,
      requeued: result.requeued,
      deduplicated: result.deduplicated,
      blocked: result.blocked,
      drained: result.drained,
      staleEpochs: result.staleEpochs,
      failed: result.failed,
    },
    { enqueued: 1, requeued: 1, deduplicated: 1, blocked: 1, drained: 1, staleEpochs: 0, failed: 0 },
  );
  assert.equal(
    result.enqueued + result.requeued + result.deduplicated + result.blocked +
      result.drained + result.staleEpochs + result.failed,
    result.dueCount,
  );
  assert.deepEqual(result.results.map((item) => item.status), [
    'queued', 'requeued', 'deduplicated', 'blocked_succeeded', 'drained',
  ]);
});
