import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTempDir, waitForCondition } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION } from '../src/distill/validate.js';
import { ProviderTimeoutError } from '../src/runtime/provider_execution.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

test('bootstrapContext returns semantic retrieval with trust and verification hints', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    key: 'issue-69-contract',
    content: 'Issues and PRs changed the bootstrap API contract for agents.',
    category: 'decision',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    key: 'indentation-style',
    content: 'Use four spaces for generated examples in this repo.',
    category: 'preference',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'agent-bootstrap-policy',
    content: 'Agents should verify PR and CI state before acting on retrieved context.',
    category: 'policy',
  });

  const result = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    query: 'issue 69 bootstrap contract previous work',
    includeShared: true,
    limit: 5,
  });

  assert.deepEqual(result.scope, { scopeType: 'repo', scopeKey: 'repo-bootstrap' });
  assert.equal(result.storage.mode, 'project-local');
  assert.equal(result.storage.authority, 'project-local');
  assert.match(result.summary, /Found/);
  assert.ok(result.results.some((item) => item.group === 'primary' && item.key === 'issue-69-contract'));
  assert.ok(result.results.some((item) => item.group === 'shared' && item.key === 'agent-bootstrap-policy'));
  const repoHit = result.results.find((item) => item.key === 'issue-69-contract');
  assert.equal(repoHit.trust, 'reviewed_durable');
  assert.equal(repoHit.verificationRequired, true);
  assert.ok(Array.isArray(repoHit.why));
  assert.equal(Object.hasOwn(repoHit, 'score'), false);
  assert.match(repoHit.whyUse, /Reviewed durable/);
  assert.ok(result.nextActions.some((item) => item.includes('Verify current git')));

  const stableResult = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    query: 'indentation style examples',
    limit: 3,
    rawTailLimit: 0,
  });
  const stableHit = stableResult.results.find((item) => item.key === 'indentation-style');
  assert.equal(stableHit.verificationRequired, false);
  assert.equal(Object.hasOwn(stableResult, 'rawTailLimit'), false);
});

test('bootstrapContext reuses one query embedding across repo and shared retrieval', async () => {
  const dataDir = await makeTempDir();
  let embedCalls = 0;
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      embedCalls += 1;
      return texts.map(() => [1, 0, 0]);
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: provider,
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap-embed',
    key: 'repo-bootstrap-memory',
    content: 'Repo bootstrap retrieval should reuse embeddings.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'shared-bootstrap-memory',
    content: 'Shared bootstrap retrieval should reuse embeddings.',
  });

  const result = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap-embed',
    query: 'bootstrap retrieval',
    includeShared: true,
  });

  assert.equal(embedCalls, 1);
  assert.equal(result.sharedLimit, 3);
  assert.ok(result.results.some((item) => item.group === 'primary'));
  assert.ok(result.results.some((item) => item.group === 'shared'));
});

test('syncResumeContext returns handoff context without promotion proposals', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'resume_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      resume_provider: async () => ({
        summaryShort: 'Resume handoff for usage observability.',
        summaryText:
          'Usage observability work left unfinished migration checks and PR verification for the next agent.',
        decisions: ['Use checkpoint handoff for prior intent.'],
        todos: ['Verify CI before acting.'],
        openQuestions: [],
        structured: {
          schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
          work: {
            intent: 'Resume usage observability verification.',
            status: 'in_progress',
            outcome: 'Next agent should verify CI live.',
          },
          liveState: {
            prNumber: 321,
            ciStatus: 'unknown',
            observedAt: '2026-06-03T00:00:00Z',
            verificationRequired: true,
            staleReasons: ['PR and CI state can change after checkpoint creation'],
            verifyHints: ['gh pr view 321 --json statusCheckRollup'],
          },
          changes: [],
          verification: [],
          risks: [],
          nextActions: [
            {
              action: 'Verify CI before acting.',
              priority: 'high',
              requiresLiveVerification: true,
            },
          ],
        },
        sessionWorkingContext: {
          currentTask: 'Continue usage observability closeout verification.',
          currentUserIntent: 'Resume unfinished PR verification without proposing memory promotions.',
          targetSubject: 'usage observability',
          openQuestion: 'Has CI passed on the latest PR commit?',
          nonGoals: ['memory promotion review during resume'],
          avoidMisreadings: ['checkpoint is weak memory'],
          confidence: 0.82,
        },
        memoryCandidates: [
          {
            key: 'resume-candidate-runbook',
            content: 'Review usage observability closeout candidates only at closeout.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'resume-repo',
    key: 'resume-durable-rule',
    content: 'Usage observability resume must verify CI live.',
    category: 'runbook',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
    role: 'assistant',
    content: 'Usage observability checkpoint should preserve unfinished work.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
  });

  const result = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
    query: 'usage observability resume unfinished work closeout candidates',
  });

  assert.equal(result.kind, 'resume_context');
  assert.equal(result.handoff.latestHandoff.structured.work.status, 'in_progress');
  assert.equal(result.handoff.latestHandoff.structuredWarnings[0].code, 'live_state_may_be_stale');
  assert.equal(result.handoff.structuredWorkingContext.type, 'session_working_context');
  assert.equal(result.handoff.structuredWorkingContext.trust, 'mutable_session_state');
  assert.match(result.handoff.structuredWorkingContext.currentTask, /usage observability/);
  assert.deepEqual(result.handoff.structuredWorkingContext.nonGoals, ['memory promotion review during resume']);
  assert.equal(result.handoff.recentCheckpoints[0].trust, 'credible_recent_handoff');
  assert.match(result.handoff.recentCheckpoints[0].useHint, /Use actively/);
  assert.equal(result.handoff.memoryCandidates.count, 1);
  assert.equal(result.handoff.memoryCandidates.items[0].trust, 'review_material');
  assert.equal(Object.hasOwn(result, 'proposals'), false);
  assert.ok(result.nextActions.includes('Do not propose memory promotions during resume sync.'));
});

test('syncResumeContext handles empty bootstrap results without proposals', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const result = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'empty-resume-repo',
    query: 'no matching resume context',
  });

  assert.equal(result.kind, 'resume_context');
  assert.deepEqual(result.handoff.durableMemories, []);
  assert.deepEqual(result.handoff.recentCheckpoints, []);
  assert.equal(result.handoff.memoryCandidates.count, 0);
  assert.equal(Object.hasOwn(result, 'proposals'), false);
});

test('suggestMemoryPromotions avoids scope fallback unless explicitly allowed', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'suggest_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      suggest_provider: async () => ({
        summaryShort: 'Promotion suggestion checkpoint.',
        summaryText: 'Closeout produced a stable runbook candidate.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'closeout-runbook',
            content: 'Closeout should verify branch parity before follow-up work starts.',
            reason: 'Branch parity verification is a reusable closeout runbook.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.91,
            stability: 0.92,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    sessionId: 'suggest-session',
    role: 'assistant',
    content: 'Closeout candidate: branch parity runbook.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    sessionId: 'suggest-session',
  });

  const noFallback = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    trigger: 'manual_closeout',
  });
  assert.deepEqual(noFallback.proposals, []);
  assert.equal(noFallback.source.mode, 'none');
  assert.ok(noFallback.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));
  assert.ok(
    noFallback.nextActions.some((action) =>
      action.includes('No current-session closeout candidates were reviewed'),
    ),
  );

  await assert.rejects(
    () =>
      app.suggestMemoryPromotions({
        scope: 'repo',
        scopeKey: 'suggest-repo',
        trigger: 'agent_merged_pr',
        allowScopeFallback: true,
      }),
    /allowScopeFallback/,
  );

  const fallback = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    trigger: 'manual_closeout',
    allowScopeFallback: true,
  });
  assert.equal(fallback.source.mode, 'scope_fallback');
  assert.equal(fallback.proposals.length, 1);
  assert.equal(fallback.proposals[0].key, 'closeout-runbook');
});

test('suggestMemoryPromotions honors scanLimit and reports capped proposal limits', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'scan_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: null,
    distillProviders: {
      scan_provider: async () => ({
        summaryShort: 'Many candidates.',
        summaryText: 'Closeout produced many promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: Array.from({ length: 5 }, (_, index) => ({
          key: `scan-runbook-${index + 1}`,
          content: `Runbook candidate ${index + 1}.`,
          category: 'runbook',
          candidateType: 'runbook',
          confidence: 0.9,
          stability: 0.9,
          sensitivity: 'low',
          promotionRecommendation: 'promote',
        })),
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
    role: 'assistant',
    content: 'Many closeout candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
  });

  const result = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
    trigger: 'manual_closeout',
    scanLimit: 2,
    limit: 5,
  });

  assert.equal(result.proposals.length, 2);
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'limit_capped'));
});

test('suggestMemoryPromotions uses only latest checkpoint for a session and skips risky candidates', async () => {
  const dataDir = await makeTempDir();
  let callCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'latest_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      latest_provider: async () => {
        callCount += 1;
        return {
          summaryShort: `Checkpoint ${callCount}.`,
          summaryText: `Checkpoint ${callCount} contains candidates.`,
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates:
            callCount === 1
              ? [
                  {
                    key: 'old-runbook',
                    content: 'Old checkpoint candidate should not be suggested from latest session closeout.',
                    category: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'low',
                    promotionRecommendation: 'promote',
                  },
                ]
              : [
                  {
                    key: 'latest-runbook',
                    content: 'Latest checkpoint candidate should be suggested.',
                    category: 'runbook',
                    candidateType: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'low',
                    promotionRecommendation: 'promote',
                  },
                  {
                    key: 'latest-secret',
                    content: 'Risky candidate should not be suggested.',
                    category: 'runbook',
                    candidateType: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'high',
                    promotionRecommendation: 'promote',
                  },
                ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    role: 'assistant',
    content: 'First checkpoint raw.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    role: 'assistant',
    content: 'Second checkpoint raw.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
  });

  const result = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    trigger: 'user_declared_work_done',
  });

  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key),
    ['latest-runbook'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('high_sensitivity')));
});

test('autoPromoteMemoryCandidates requires closeout scope and defaults to dry-run', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      auto_provider: async () => ({
        summaryShort: 'Auto promote checkpoint.',
        summaryText: 'Closeout produced strict automatic promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'auto-runbook',
            content: 'Closeout automation can promote strict runbook candidates.',
            category: 'runbook',
            candidateType: 'runbook',
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
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
    role: 'assistant',
    content: 'Strict auto promotion candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
  });

  const noSource = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    trigger: 'manual_closeout',
  });
  assert.equal(noSource.kind, 'auto_memory_promotion_result');
  assert.deepEqual(noSource.wouldPromote, []);
  assert.equal(noSource.source.mode, 'none');
  assert.ok(noSource.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));
  assert.ok(
    noSource.nextActions.some((action) =>
      action.includes('No current-session closeout candidates were reviewed'),
    ),
  );

  const dryRun = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
    trigger: 'user_declared_work_done',
    limit: 5,
  });
  assert.equal(dryRun.kind, 'auto_memory_promotion_result');
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.wouldPromote.length, 1);
  assert.deepEqual(dryRun.promoted, []);
  assert.equal(dryRun.wouldPromote[0].key, 'auto-runbook');
  assert.ok(dryRun.requestWarnings.some((warning) => warning.code === 'limit_capped'));
  assert.equal(app.listMemoryCandidates({ scope: 'repo', scopeKey: 'auto-repo', status: 'promoted' }).length, 0);

  const checkpointOnly = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(checkpointOnly.source.mode, 'checkpoint');
  assert.equal(checkpointOnly.wouldPromote.length, 1);

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        minConfidence: 1.5,
      }),
    /minConfidence/,
  );

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        minStability: -1,
      }),
    /minStability/,
  );

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        dryRun: false,
      }),
    /CONTEXTFORGE_AUTO_PROMOTE_ENABLED/,
  );
});

test('auditMemoryCandidates persists audit metadata without promoting durable memory', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_suggestions_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate, warnings, checkpoint }) => {
      auditInvocations.push({ candidate, warnings, checkpoint });
      return {
        approved: true,
        decision: 'approve',
        reason: 'Candidate is stable enough to offer as a closeout recommendation.',
        riskCodes: [],
        metadata: {
          provider: 'codex_exec',
          model: 'gpt-5.5',
          reasoningEffort: 'low',
          usage: {
            prompt_tokens: 100,
            completion_tokens: 25,
            total_tokens: 125,
            prompt_tokens_details: {
              cached_tokens: 40,
            },
            completion_tokens_details: {
              reasoning_tokens: 7,
            },
          },
        },
      };
    },
    distillProviders: {
      audit_suggestions_provider: async () => ({
        summaryShort: 'Audit suggestions checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited without mutation.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audited-readonly-runbook',
            content: 'Agents should audit closeout memory candidates before suggesting promotion.',
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
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
    role: 'assistant',
    content: 'Read-only audited candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
  });

  const noSource = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    trigger: 'manual_closeout',
  });
  assert.equal(noSource.kind, 'memory_candidate_audit_suggestions');
  assert.deepEqual(noSource.proposals, []);
  assert.equal(noSource.source.mode, 'none');
  assert.equal(noSource.policy.mutatesDurableMemory, false);
  assert.equal(noSource.policy.persistsAuditMetadata, false);
  assert.ok(noSource.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    checkpointId: checkpoint.id,
    trigger: 'user_declared_work_done',
    limit: 50,
  });

  assert.equal(result.kind, 'memory_candidate_audit_suggestions');
  assert.equal(result.policy.mutatesDurableMemory, false);
  assert.equal(result.policy.persistsAuditMetadata, true);
  assert.equal(result.policy.audit.executed, true);
  assert.equal(result.policy.audit.provider, 'none');
  assert.equal(result.source.mode, 'checkpoint');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].key, 'audited-readonly-runbook');
  assert.equal(result.proposals[0].recommendedAction, 'promote');
  assert.equal(result.proposals[0].audit.metadata.model, 'gpt-5.5');
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'limit_capped'));
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].checkpoint.id, checkpoint.id);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-suggestions-repo', key: 'audited-readonly-runbook' }), null);
  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 1);
  assert.equal(pendingCandidates[0].candidate.key, 'audited-readonly-runbook');
  assert.ok(pendingCandidates[0].reviewedAt);
  assert.equal(
    pendingCandidates[0].reviewReason,
    'Candidate is stable enough to offer as a closeout recommendation.',
  );
  assert.equal(pendingCandidates[0].reviewMetadata.audit.decision, 'approve');
  assert.equal(pendingCandidates[0].reviewMetadata.auditMetadata.mutatesDurableMemory, false);
  assert.equal(pendingCandidates[0].reviewMetadata.auditMetadata.persistsAuditMetadata, true);

  const store = new ContextForgeStore({ dataDir });
  const events = store.listLlmUsageEvents({
    scopeType: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'candidate_audit');
  assert.equal(events[0].provider, 'codex_exec');
  assert.equal(events[0].model, 'gpt-5.5');
  assert.equal(events[0].checkpointId, checkpoint.id);
  assert.equal(events[0].candidateId, pendingCandidates[0].id);
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].cachedInputTokens, 40);
  assert.equal(events[0].uncachedInputTokens, 60);
  assert.equal(events[0].outputTokens, 25);
  assert.equal(events[0].reasoningTokens, 7);
  assert.equal(events[0].totalTokens, 125);
  store.close();
});

test('concurrent duplicate candidate audits share one provider call and metadata write', async () => {
  const dataDir = await makeTempDir();
  let releaseAudit;
  let auditInvocations = 0;
  const auditor = async () => {
    auditInvocations += 1;
    await new Promise((resolve) => {
      releaseAudit = resolve;
    });
    return {
      approved: true,
      decision: 'approve',
      reason: 'Synthetic concurrent audit approved the candidate.',
      riskCodes: [],
      metadata: {
        provider: 'synthetic_auditor',
        model: 'synthetic-model',
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    };
  };
  auditor.metadata = { provider: 'synthetic_auditor', model: 'synthetic-model', timeoutMs: 1000 };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'concurrent_audit_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      concurrent_audit_provider: async () => ({
        summaryShort: 'Concurrent audit checkpoint.',
        summaryText: 'One candidate is available for concurrent audit retries.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'concurrent-audit-runbook',
            content: 'Concurrent candidate audit retries share one provider execution.',
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
  const source = { scope: 'repo', scopeKey: 'concurrent-audit-repo', sessionId: 'concurrent-audit-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Concurrent audit raw evidence.' });
  const checkpoint = await app.distillCheckpoint(source);
  const options = {
    ...source,
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  };

  const first = app.auditMemoryCandidates(options);
  const retry = app.auditMemoryCandidates(options);
  await waitForCondition(() => typeof releaseAudit === 'function', 'candidate audit did not start');
  assert.equal(auditInvocations, 1);
  releaseAudit();
  const [firstResult, retryResult] = await Promise.all([first, retry]);

  assert.equal(auditInvocations, 1);
  assert.deepEqual(firstResult.proposals, retryResult.proposals);
  assert.equal(firstResult.proposals.length, 1);
  assert.equal(app.listLlmUsageEvents({ ...source, operation: 'candidate_audit' }).length, 1);
  const [candidate] = app.listMemoryCandidates({ ...source, checkpointId: checkpoint.id, status: 'pending' });
  assert.equal(candidate.reviewMetadata.audit.decision, 'approve');
});

test('retryable candidate audit failures can be safely retried without force', async () => {
  const dataDir = await makeTempDir();
  let auditInvocations = 0;
  const auditor = async () => {
    auditInvocations += 1;
    if (auditInvocations === 1) {
      const error = new ProviderTimeoutError('retryable_auditor', 25);
      error.metadata = {
        provider: 'retryable_auditor',
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      };
      throw error;
    }
    return {
      approved: true,
      decision: 'approve',
      reason: 'Retry succeeded without a duplicate concurrent write.',
      riskCodes: [],
      metadata: {
        provider: 'retryable_auditor',
        usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
      },
    };
  };
  auditor.metadata = { provider: 'retryable_auditor', timeoutMs: 1000 };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'retryable_audit_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      retryable_audit_provider: async () => ({
        summaryShort: 'Retryable audit checkpoint.',
        summaryText: 'The candidate audit may be retried after a transient timeout.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'retryable-audit-runbook',
            content: 'Retry transient audit failures without force.',
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
  const source = { scope: 'repo', scopeKey: 'retryable-audit-repo', sessionId: 'retryable-audit-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Retryable audit raw evidence.' });
  const checkpoint = await app.distillCheckpoint(source);
  const options = { ...source, checkpointId: checkpoint.id, trigger: 'manual_closeout' };

  const failed = await app.auditMemoryCandidates(options);
  assert.equal(failed.proposals[0].audit.retryable, true);
  const retried = await app.auditMemoryCandidates(options);
  assert.equal(retried.proposals[0].audit.decision, 'approve');
  assert.equal(retried.proposals[0].audit.retryable, undefined);
  assert.equal(auditInvocations, 2);
  assert.equal(app.listLlmUsageEvents({ ...source, operation: 'candidate_audit' }).length, 2);
  const [candidate] = app.listMemoryCandidates({ ...source, checkpointId: checkpoint.id, status: 'pending' });
  assert.equal(candidate.reviewMetadata.audit.decision, 'approve');
});

test('auditMemoryCandidates records failed audit usage when error metadata includes usage', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_failure_usage_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      const error = new Error('Synthetic audit transport failure.');
      error.metadata = {
        provider: 'codex_sdk_python',
        model: 'gpt-5.5',
        usage: {
          input_tokens: 30,
          output_tokens: 4,
          total_tokens: 34,
          input_tokens_details: {
            cached_tokens: 12,
          },
        },
      };
      throw error;
    },
    distillProviders: {
      audit_failure_usage_provider: async () => ({
        summaryShort: 'Audit failure usage checkpoint.',
        summaryText: 'Closeout produced a candidate whose audit fails after usage is known.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-failure-usage-runbook',
            content: 'Failed audit calls should preserve token usage when providers expose it.',
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
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
    role: 'assistant',
    content: 'Failed audit usage should be preserved.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].recommendedAction, 'review');

  const events = app.listLlmUsageEvents({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'candidate_audit');
  assert.equal(events[0].status, 'failed');
  assert.equal(events[0].provider, 'codex_sdk_python');
  assert.equal(events[0].inputTokens, 30);
  assert.equal(events[0].cachedInputTokens, 12);
  assert.equal(events[0].uncachedInputTokens, 18);
  assert.equal(events[0].totalTokens, 34);
});

test('auditMemoryCandidates audits review candidates and skips noisy events before runner', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_review_selection_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '99',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Reviewed ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      audit_review_selection_provider: async () => ({
        summaryShort: 'Audit review selection checkpoint.',
        summaryText: 'Closeout produced review and noisy candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'review-worthy-policy',
            content: 'Agents must verify mutable live state before using structured checkpoint liveState values.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.82,
            stability: 0.82,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-api-contract',
            content: 'GET /healthz must return 200 for the server health contract.',
            category: 'api_contract',
            candidateType: 'api_contract',
            confidence: 0.83,
            stability: 0.83,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-ci-policy',
            content: 'CI must run lint and tests on every PR before merge.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.84,
            stability: 0.84,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-draft-policy',
            content: 'Open work as a draft PR until checks are ready for review.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.81,
            stability: 0.81,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'pr-status-noise',
            content: 'PR #126 passed npm test 142/142 and CI was green.',
            category: 'project_status',
            candidateType: 'fact',
            confidence: 0.98,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'local-runtime-noise',
            content: 'Restart `/home/ubuntu/contextforge` with systemctl on this host.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.97,
            stability: 0.91,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    sessionId: 'audit-review-selection-session',
    role: 'assistant',
    content: 'Review candidates should be filtered before audit.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    sessionId: 'audit-review-selection-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    limit: 5,
  });

  assert.deepEqual(auditInvocations.sort(), [
    'review-worthy-api-contract',
    'review-worthy-ci-policy',
    'review-worthy-draft-policy',
    'review-worthy-policy',
  ]);
  assert.equal(result.policy.audit.executed, true);
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key).sort(),
    [
      'review-worthy-api-contract',
      'review-worthy-ci-policy',
      'review-worthy-draft-policy',
      'review-worthy-policy',
    ],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_transient_category')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_one_off_event')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_environment_specific')));
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'audit-review-selection-repo', key: 'review-worthy-policy' }),
    null,
  );
});

test('auditMemoryCandidates honors narrowed allowedCategories', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_allowed_categories_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Reviewed ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      audit_allowed_categories_provider: async () => ({
        summaryShort: 'Audit allowed categories checkpoint.',
        summaryText: 'Closeout produced candidates in different durable categories.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'allowed-runbook',
            content: 'Use scoped bootstrap before editing ContextForge runtime code.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'blocked-policy',
            content: 'Agents must verify mutable live state before using checkpoint liveState.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    sessionId: 'audit-allowed-categories-session',
    role: 'assistant',
    content: 'Allowed categories should narrow audit candidate selection.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    sessionId: 'audit-allowed-categories-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    allowedCategories: ['runbook'],
    limit: 5,
  });

  assert.deepEqual(auditInvocations, ['allowed-runbook']);
  assert.deepEqual(result.policy.allowedCategories, ['runbook']);
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key),
    ['allowed-runbook'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('audit_disallowed_category')));
});
