import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { createCodexSdkPythonAutoPromoteAuditor } from '../src/audit/codex_sdk_python.js';
import { createContextForge } from '../src/core.js';

test('distillCheckpoint automatically audits session candidate batches', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'batch_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.id);
      return {
        approved: true,
        decision: 'approve',
        reason: `Audited ${candidate.candidate.key} in a batch.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
          reasoningEffort: 'low',
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            total_tokens: 25,
          },
        },
      };
    },
    distillProviders: {
      batch_audit_provider: async () => ({
        summaryShort: 'Batch audit checkpoint.',
        summaryText: 'The checkpoint produced enough candidates for automatic batched audit.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'batch-audit-runbook',
            content: 'Run automatic candidate audits in batches.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'batch-audit-contract',
            content: 'Automatic promotion writes require audit approval.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    role: 'assistant',
    content: 'Create enough candidates for batch audit.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
  });

  assert.equal(checkpoint.candidateAudit.executed, true);
  assert.equal(checkpoint.candidateAudit.reason, 'batch_threshold');
  assert.equal(checkpoint.candidateAudit.audited, 2);
  assert.equal(checkpoint.candidateAudit.promoted, 0);
  assert.equal(auditInvocations.length, 2);
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    status: 'pending',
  });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.reviewMetadata.audit?.metadata?.model === 'gpt-5.5'));
  assert.ok(candidates.every((candidate) => candidate.reviewMetadata.auditMetadata?.sourceMode === 'checkpoint'));
  const attempts = app.listMemoryCandidateAuditAttempts({ scope: 'repo', scopeKey: 'batch-audit-repo', candidateId: candidates[0].id });
  assert.ok(attempts.every((attempt) => attempt.sourceMode === 'checkpoint'));
  const usageEvents = app.listLlmUsageEvents({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    operation: 'candidate_audit',
    order: 'asc',
  });
  assert.equal(usageEvents.length, 2);
  assert.ok(usageEvents.every((event) => event.distillRunId === checkpoint.distillRunId));
  assert.deepEqual(
    usageEvents.map((event) => event.candidateId).sort(),
    candidates.map((candidate) => candidate.id).sort(),
  );
  assert.deepEqual(
    usageEvents.map((event) => event.totalTokens),
    [25, 25],
  );

  const storedAudit = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    trigger: 'manual_closeout',
    limit: 2,
  });
  assert.equal(storedAudit.proposals.length, 2);
  assert.equal(storedAudit.proposals[0].audit.metadata.model, 'gpt-5.5');
  assert.equal(auditInvocations.length, 2);
});

test('distillCheckpoint automatically audits review-worthy non-promote candidate batches', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'review_batch_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Audited review candidate ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      review_batch_audit_provider: async () => ({
        summaryShort: 'Review batch audit checkpoint.',
        summaryText: 'The checkpoint produced review-worthy candidates for batched audit.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'review-batch-policy',
            content: 'Agents must verify mutable live state before relying on checkpoint liveState values.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.82,
            stability: 0.82,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-batch-architecture',
            content: 'Structured checkpoint handoff should be exposed separately from ordinary search results.',
            category: 'architecture',
            candidateType: 'decision',
            confidence: 0.81,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'review-batch-audit-repo',
    sessionId: 'review-batch-audit-session',
    role: 'assistant',
    content: 'Create enough review candidates for batch audit.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'review-batch-audit-repo',
    sessionId: 'review-batch-audit-session',
  });

  assert.equal(checkpoint.candidateAudit.executed, true);
  assert.equal(checkpoint.candidateAudit.reason, 'batch_threshold');
  assert.equal(checkpoint.candidateAudit.audited, 2);
  assert.deepEqual(auditInvocations.sort(), ['review-batch-architecture', 'review-batch-policy']);
});

test('distillCheckpoint audits new candidates even when audited pending candidates fill the first window', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  let distillCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'batch_window_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: true,
        decision: 'approve',
        reason: `Audited ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      batch_window_provider: async () => {
        distillCount += 1;
        return {
          summaryShort: `Batch audit checkpoint ${distillCount}.`,
          summaryText: 'The checkpoint produced enough candidates for automatic batched audit.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [
            {
              key: `batch-window-${distillCount}-a`,
              content: `Batch audit candidate A ${distillCount}.`,
              category: 'runbook',
              candidateType: 'runbook',
              confidence: 0.96,
              stability: 0.96,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
            {
              key: `batch-window-${distillCount}-b`,
              content: `Batch audit candidate B ${distillCount}.`,
              category: 'api-contract',
              candidateType: 'api-contract',
              confidence: 0.95,
              stability: 0.95,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
          ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
    role: 'assistant',
    content: 'First audit batch.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
  });
  assert.equal(first.candidateAudit.audited, 2);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
    role: 'assistant',
    content: 'Second audit batch should not be blocked by the first audited pending batch.',
  });
  const second = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
  });

  assert.equal(second.candidateAudit.executed, true);
  assert.equal(second.candidateAudit.audited, 2);
  assert.deepEqual(auditInvocations, [
    'batch-window-1-a',
    'batch-window-1-b',
    'batch-window-2-a',
    'batch-window-2-b',
  ]);
});

test('distillCheckpoint waits below audit threshold but closeout trigger forces audit', async () => {
  const dataDir = await makeTempDir();
  let auditCount = 0;
  let distillCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'closeout_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '5',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditCount += 1;
      return {
        approved: false,
        decision: 'needs_review',
        reason: 'Closeout audit should run even below the batch threshold.',
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      closeout_audit_provider: async () => {
        distillCount += 1;
        return {
          summaryShort: 'Closeout audit checkpoint.',
          summaryText: 'The checkpoint produced one candidate.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [
            {
              key: `closeout-audit-${distillCount}`,
              content: `Closeout audits force candidate review ${distillCount}.`,
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    role: 'assistant',
    content: 'First candidate should wait below threshold.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
  });
  assert.equal(first.candidateAudit.executed, false);
  assert.equal(first.candidateAudit.reason, 'below_batch_threshold');
  assert.equal(auditCount, 0);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    role: 'assistant',
    content: 'Closeout should force audit.',
  });
  const second = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    auditTrigger: 'manual_closeout',
  });
  assert.equal(second.candidateAudit.executed, true);
  assert.equal(second.candidateAudit.reason, 'closeout_trigger');
  assert.equal(second.candidateAudit.audited, 2);
  assert.equal(auditCount, 2);
});

test('auditMemoryCandidates keeps recommendations conservative when audit is disabled', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_disabled_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED: 'false',
    },
    cwd: process.cwd(),
    distillProviders: {
      audit_disabled_provider: async () => ({
        summaryShort: 'Audit disabled checkpoint.',
        summaryText: 'Closeout produced a candidate while the audit provider is disabled.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-disabled-runbook',
            content: 'Read-only audit suggestions should not recommend promotion when audit is disabled.',
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    role: 'assistant',
    content: 'Audit disabled read-only candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    auditTrigger: 'manual_closeout',
  });
  assert.equal(checkpoint.candidateAudit.executed, false);
  assert.equal(checkpoint.candidateAudit.reason, 'audit_disabled');

  const pendingBeforeAudit = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    status: 'pending',
  });
  assert.equal(pendingBeforeAudit.length, 1);
  assert.equal(pendingBeforeAudit[0].reviewMetadata.audit, undefined);

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    trigger: 'manual_closeout',
  });

  assert.equal(result.policy.audit.enabled, false);
  assert.equal(result.policy.audit.executed, false);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'audit_disabled');
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'audit_disabled'));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-disabled-repo', key: 'audit-disabled-runbook' }), null);
  const pendingAfterAudit = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    status: 'pending',
  });
  assert.equal(pendingAfterAudit[0].reviewMetadata.audit, undefined);
});

test('autoPromoteMemoryCandidates returns stable empty arrays and preference input warnings', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_empty_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      auto_empty_provider: async () => ({
        summaryShort: 'No candidates.',
        summaryText: 'Closeout produced no memory candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
    role: 'assistant',
    content: 'No candidates here.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
    trigger: 'manual_closeout',
    allowedCategories: ['preference'],
  });
  assert.equal(result.kind, 'auto_memory_promotion_result');

  assert.deepEqual(result.wouldPromote, []);
  assert.deepEqual(result.promoted, []);
  assert.deepEqual(result.policy.allowedCategories, []);
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'preference_input_stripped'));
});

test('autoPromoteMemoryCandidates promotes only strict safe candidates when enabled', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('safe-api-contract') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_enabled_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
    autoPromoteAuditor: async () => ({
      approved: true,
      decision: 'approve',
      reason: 'Test auditor approved strict safe candidate.',
      riskCodes: [],
      metadata: {
        provider: 'codex_exec',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
      },
    }),
    distillProviders: {
      auto_enabled_provider: async () => ({
        summaryShort: 'Auto enabled checkpoint.',
        summaryText: 'Closeout produced mixed automatic promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'safe-api-contract',
            content: 'The API contract requires idempotent delete retries.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'safe-runbook',
            content: 'The runbook requires processing embeddings after promoted memory writes.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.94,
            stability: 0.93,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'user-pref',
            content: 'The user prefers a particular closing phrase.',
            category: 'preference',
            candidateType: 'preference',
            confidence: 0.99,
            stability: 0.99,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'low-confidence-runbook',
            content: 'This runbook is not stable enough.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.7,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
    role: 'assistant',
    content: 'Mixed auto promotion candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
  });
  const processedDistillEmbeddings = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
  });
  assert.deepEqual(processedDistillEmbeddings.bySourceType, {
    checkpoint: 1,
    memory_candidate: 4,
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
    trigger: 'agent_merged_pr',
    dryRun: false,
  });

  assert.equal(result.kind, 'auto_memory_promotion_result');
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.wouldPromote, []);
  assert.deepEqual(
    result.promoted.map((item) => item.key),
    ['safe-api-contract', 'safe-runbook'],
  );
  assert.ok(result.promoted[0].evidence);
  assert.equal(result.promoted[0].promotionResult.status, 'promoted');
  const pendingEmbeddingJobs = await app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    status: 'pending',
  });
  assert.deepEqual(
    pendingEmbeddingJobs.map((job) => job.sourceType),
    ['memory', 'memory'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('preference_auto_excluded')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_low_confidence')));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-enabled-repo', key: 'safe-api-contract' }).status, 'active');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-enabled-repo', key: 'user-pref' }), null);
  const promotedCandidates = app.listMemoryCandidates({ scope: 'repo', scopeKey: 'auto-enabled-repo', status: 'promoted' });
  assert.equal(promotedCandidates.length, 2);
  assert.ok(promotedCandidates.every((candidate) => candidate.reviewMetadata.autoPromoted === true));
  assert.ok(promotedCandidates.every((candidate) => candidate.reviewMetadata.autoPromotionAudit?.metadata?.model === 'gpt-5.5'));
  assert.deepEqual(
    promotedCandidates.map((candidate) => candidate.reviewMetadata.memoryId).sort(),
    result.promoted.map((item) => item.memoryId).sort(),
  );
  const promotedApiCandidate = promotedCandidates.find((candidate) => candidate.candidate.key === 'safe-api-contract');
  assert.ok(promotedApiCandidate, 'expected safe-api-contract promoted candidate');
  const autoEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    key: 'safe-api-contract',
  });
  assert.equal(autoEvents[0].metadata.sourceCandidateId, promotedApiCandidate.id);
  assert.equal(autoEvents[0].metadata.autoPromoted, true);
  const processedMemoryEmbedding = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
  });
  assert.deepEqual(processedMemoryEmbedding.bySourceType, {
    memory: 2,
  });
  const memoryResults = await app.search({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    query: 'safe-api-contract',
  });
  const safeApiMemoryResult = memoryResults.find(
    (entry) => entry.type === 'memory' && entry.memory.key === 'safe-api-contract',
  );
  assert.ok(safeApiMemoryResult, 'expected safe-api-contract memory result');
  assert.equal(safeApiMemoryResult.retrieval.vectorModel, 'test-embedding');
});

test('autoPromoteMemoryCandidates rejects one-off and environment-specific candidates before audit', async () => {
  const dataDir = await makeTempDir();
  let auditCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_strict_durability_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditCount += 1;
      return {
        approved: true,
        decision: 'approve',
        reason: 'The test auditor would approve if local policy allowed it.',
        riskCodes: [],
        metadata: {
          provider: 'codex_exec',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      auto_strict_durability_provider: async () => ({
        summaryShort: 'Strict durability checkpoint.',
        summaryText: 'Closeout produced candidates with mixed durability.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'repo-common-api-contract',
            content: 'The API contract requires idempotent delete retries.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'pr-ci-snapshot',
            content: 'PR #126 passed npm test 142/142 and CI was green.',
            category: 'project_state',
            candidateType: 'fact',
            confidence: 0.98,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'local-service-restart',
            content: 'Restart `/home/ubuntu/contextforge` service with systemctl after this local deployment.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.97,
            stability: 0.91,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
    role: 'assistant',
    content: 'Mixed strict durability candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(
    result.promoted.map((item) => item.key),
    ['repo-common-api-contract'],
  );
  assert.equal(auditCount, 1);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-strict-durability-repo', key: 'pr-ci-snapshot' }), null);
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'auto-strict-durability-repo', key: 'local-service-restart' }),
    null,
  );
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_transient_category')));
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_one_off_event')));
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_environment_specific')));
});

test('autoPromoteMemoryCandidates skips candidates rejected by the audit runner', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_reject_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => ({
      approved: false,
      decision: 'needs_review',
      reason: 'Candidate is plausible but needs human review.',
      riskCodes: ['needs_human_review'],
      metadata: {
        provider: 'codex_exec',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
      },
    }),
    distillProviders: {
      audit_reject_provider: async () => ({
        summaryShort: 'Audit rejected checkpoint.',
        summaryText: 'Closeout produced a candidate that local checks would otherwise promote.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-gated-runbook',
            content: 'The runbook requires audit approval before automatic durable promotion.',
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
    role: 'assistant',
    content: 'Audit-gated candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(result.promoted, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'audit_needs_review: needs_human_review');
  assert.equal(result.skipped[0].audit.metadata.model, 'gpt-5.5');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-reject-repo', key: 'audit-gated-runbook' }), null);
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    status: 'pending',
  });
  assert.equal(candidates.length, 1);
});

test('autoPromoteMemoryCandidates keeps candidates pending when audit runner fails', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_fail_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      throw new Error('audit runner unavailable');
    },
    distillProviders: {
      audit_fail_provider: async () => ({
        summaryShort: 'Audit failed checkpoint.',
        summaryText: 'Closeout produced a candidate that local checks would otherwise promote.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-failed-runbook',
            content: 'The runbook requires audit success before automatic durable promotion.',
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
    role: 'assistant',
    content: 'Audit failure candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(result.promoted, []);
  assert.equal(result.skipped[0].reason, 'audit_needs_review: audit_failed');
  assert.match(result.skipped[0].audit.reason, /audit runner unavailable/);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-fail-repo', key: 'audit-failed-runbook' }), null);
});

test('autoPromoteMemoryCandidates can audit through the Codex Python SDK provider', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'python_sdk_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'codex_sdk_python',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN: '/home/ubuntu/.local/bin/codex',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND: 'python3',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH: '/tmp/contextforge-codex-sdk',
    },
    cwd: process.cwd(),
    autoPromoteAuditRunner: async (invocation) => {
      auditInvocations.push(invocation);
      return {
        stdout: JSON.stringify({
          final_response: JSON.stringify({
            approved: true,
            decision: 'approve',
            reason: 'The candidate is stable and supported by checkpoint evidence.',
            riskCodes: [],
          }),
          elapsed_ms: 12,
        }),
        stderr: '',
      };
    },
    distillProviders: {
      python_sdk_audit_provider: async () => ({
        summaryShort: 'Python SDK audit checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited through the Python SDK provider.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'python-sdk-audit-runbook',
            content: 'The runbook is stable and safe enough for automatic durable promotion after audit.',
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
    role: 'assistant',
    content: 'Python SDK audit candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.equal(result.policy.audit.provider, 'codex_sdk_python');
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].audit.metadata.provider, 'codex_sdk_python');
  assert.equal(result.promoted[0].audit.metadata.codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(result.promoted[0].audit.metadata.pythonPath, '/tmp/contextforge-codex-sdk');
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(auditInvocations[0].pythonCommand, 'python3');
  assert.equal(auditInvocations[0].pythonPath, '/tmp/contextforge-codex-sdk');
  assert.match(auditInvocations[0].prompt, /ContextForge automatic memory promotion auditor/);
  assert.match(auditInvocations[0].prompt, /human-readable reason in Korean/);
  assert.ok(
    app.getMemory({ scope: 'repo', scopeKey: 'python-sdk-audit-repo', key: 'python-sdk-audit-runbook' }),
  );
});

test('auditMemoryCandidates can use the Codex Python SDK provider without enabling auto-promotion', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'python_sdk_audit_suggestions_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'codex_sdk_python',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN: '/home/ubuntu/.local/bin/codex',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND: 'python3',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH: '/tmp/contextforge-codex-sdk',
    },
    cwd: process.cwd(),
    autoPromoteAuditRunner: async (invocation) => {
      auditInvocations.push(invocation);
      return {
        stdout: JSON.stringify({
          final_response: JSON.stringify({
            approved: false,
            decision: 'needs_review',
            reason: 'The agent should review this candidate before promotion.',
            riskCodes: ['needs_human_review'],
          }),
          elapsed_ms: 21,
        }),
        stderr: '',
      };
    },
    distillProviders: {
      python_sdk_audit_suggestions_provider: async () => ({
        summaryShort: 'Python SDK audit suggestions checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited without auto-promotion.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'python-sdk-readonly-audit',
            content: 'The Python SDK audit provider can produce read-only closeout recommendations.',
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
    role: 'assistant',
    content: 'Python SDK read-only audited candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
    trigger: 'manual_closeout',
  });

  assert.equal(result.policy.audit.provider, 'codex_sdk_python');
  assert.equal(result.policy.audit.executed, true);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].recommendedAction, 'review');
  assert.equal(result.proposals[0].audit.metadata.provider, 'codex_sdk_python');
  assert.equal(result.proposals[0].audit.metadata.codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].pythonCommand, 'python3');
  assert.equal(
    app.getMemory({
      scope: 'repo',
      scopeKey: 'python-sdk-audit-suggestions-repo',
      key: 'python-sdk-readonly-audit',
    }),
    null,
  );
  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 1);
});

test('Codex Python SDK auditor treats empty final_response as needs_review', async () => {
  const auditor = createCodexSdkPythonAutoPromoteAuditor({
    codexBin: '/home/ubuntu/.local/bin/codex',
    pythonCommand: 'python3',
    runner: async () => ({
      stdout: JSON.stringify({
        final_response: null,
        elapsed_ms: 7,
      }),
      stderr: '',
    }),
  });

  const result = await auditor({
    candidate: {
      candidate: {
        key: 'empty-final-response',
        content: 'The audit runner returned no final response.',
        category: 'runbook',
      },
    },
    warnings: [],
    checkpoint: null,
  });

  assert.equal(result.approved, false);
  assert.equal(result.decision, 'needs_review');
  assert.deepEqual(result.riskCodes, ['empty_final_response']);
  assert.equal(result.metadata.runnerElapsedMs, 7);
});

test('autoPromoteMemoryCandidates rejects unsupported audit providers', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'unsupported_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'unknown_audit',
    },
    cwd: process.cwd(),
    distillProviders: {
      unsupported_audit_provider: async () => ({
        summaryShort: 'Unsupported audit provider checkpoint.',
        summaryText: 'Closeout produced a candidate while audit is misconfigured.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'unsupported-audit-runbook',
            content: 'The runbook should not promote when audit provider is unsupported.',
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
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'unsupported-audit-repo',
    sessionId: 'unsupported-audit-session',
    role: 'assistant',
    content: 'Unsupported audit provider candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'unsupported-audit-repo',
    sessionId: 'unsupported-audit-session',
  });

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'unsupported-audit-repo',
        sessionId: 'unsupported-audit-session',
        trigger: 'manual_closeout',
        dryRun: false,
      }),
    /Unsupported auto-promotion audit provider/,
  );
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'unsupported-audit-repo', key: 'unsupported-audit-runbook' }), null);
});
