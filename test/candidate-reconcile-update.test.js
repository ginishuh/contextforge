import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import Database from 'better-sqlite3';
import { createContextForge } from '../src/core.js';
import { REMOTE_METHODS } from '../src/remote/client.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

test('preference candidates record merged occurrences across checkpoints', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'preference_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      preference_provider: async () => ({
        summaryShort: 'Preference checkpoint.',
        summaryText: 'A repeated user preference was observed.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'closing-style',
            content: 'The user prefers concise Korean closeout summaries with command evidence.',
            category: 'preference',
            candidateType: 'preference',
            confidence: 0.9,
            stability: 0.86,
            sensitivity: 'low',
            promotionRecommendation: 'review',
            sourceEventIds: ['event-a'],
          },
        ],
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-a',
    role: 'user',
    content: 'Keep closeout summaries concise and in Korean.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-a',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-b',
    role: 'user',
    content: 'Again, keep closeout summaries concise and in Korean.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-b',
  });

  const occurrences = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-repo',
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].mergeKey, 'key:closing-style');
  assert.equal(occurrences[0].occurrenceCount, 2);
  assert.deepEqual(occurrences[0].sessionIds.sort(), ['preference-session-a', 'preference-session-b']);
  assert.equal(occurrences[0].checkpointIds.length, 2);
  assert.equal(occurrences[0].confidence, 0.9);
  assert.equal(occurrences[0].stability, 0.86);
});

test('preference occurrence backfill covers existing preference candidates', async () => {
  const dataDir = await makeTempDir();
  const env = {
    CONTEXTFORGE_DATA_DIR: dataDir,
    CONTEXTFORGE_DISTILL_PROVIDER: 'preference_backfill_provider',
  };
  const distillProviders = {
    preference_backfill_provider: async () => ({
      summaryShort: 'Preference backfill checkpoint.',
      summaryText: 'A preference candidate existed before occurrence tracking.',
      decisions: [],
      todos: [],
      openQuestions: [],
      memoryCandidates: [
        {
          key: 'review-style',
          content: 'The user prefers review comments grouped by severity.',
          category: 'Preference',
          candidateType: 'preference',
          confidence: 0.88,
          stability: 0.82,
          sensitivity: 'low',
          promotionRecommendation: 'review',
        },
      ],
    }),
  };
  const app = createContextForge({ env, cwd: process.cwd(), distillProviders });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
    sessionId: 'preference-backfill-session',
    role: 'assistant',
    content: 'Preference candidate exists before backfill.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
    sessionId: 'preference-backfill-session',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('DELETE FROM preference_occurrences').run();
    db.prepare("DELETE FROM schema_meta WHERE key = 'preference_occurrences_backfill_completed_at'").run();
  } finally {
    db.close();
  }

  const reopened = createContextForge({ env, cwd: process.cwd(), distillProviders });
  const occurrences = reopened.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].mergeKey, 'key:review-style');
  assert.equal(occurrences[0].occurrenceCount, 1);
});

test('reconcileMemory apply_safe weakens preference occurrences when rejecting contradicted candidates', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'preference_reconcile_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      preference_reconcile_provider: async () => ({
        summaryShort: 'Preference correction checkpoint.',
        summaryText: 'A preference candidate should be rejected after correction.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'summary-style',
            content: 'The user always wants long exhaustive closeout summaries.',
            category: 'Preference',
            candidateType: 'preference',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
    role: 'assistant',
    content: 'Preference candidate: long exhaustive summaries.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
  });

  const before = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
  });
  assert.equal(before[0].status, 'active');
  assert.equal(before[0].negativeCount, 0);

  const result = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
    query: 'summary style preference',
    correction: 'That is wrong; prefer concise summaries unless I ask for exhaustive detail.',
    mode: 'apply_safe',
  });

  assert.ok(result.appliedActions.some((action) => action.action === 'reject_memory_candidate'));
  assert.ok(result.appliedActions.some((action) => action.action === 'weaken_preference_occurrence'));
  const after = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
  });
  assert.equal(after[0].status, 'weakened');
  assert.equal(after[0].negativeCount, 1);
  assert.match(after[0].lastCorrection, /prefer concise/);
});

test('reconcileMemory proposes by default and apply_safe only changes unambiguous non-live memory', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'reconcile_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      reconcile_provider: async () => ({
        summaryShort: 'Reconcile checkpoint.',
        summaryText: 'Prior note incorrectly said the API uses REST only.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'api-rest-only-candidate',
            content: 'The API uses REST only.',
            category: 'api-contract',
            confidence: 0.8,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    key: 'api-transport',
    content: 'The API uses REST only.',
    category: 'api-contract',
    tags: ['api', 'transport'],
    importance: 6,
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    role: 'assistant',
    content: 'The API uses REST only.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
  });

  const proposedWithoutQuery = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    correction: 'API REST only transport is wrong; the API supports REST and GraphQL.',
  });
  assert.equal(
    proposedWithoutQuery.query,
    'API REST only transport is wrong; the API supports REST and GraphQL.',
  );
  assert.ok(proposedWithoutQuery.basis.some((item) => item.type === 'memory'));

  const proposed = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
  });
  assert.equal(proposed.mode, 'propose');
  assert.ok(proposed.basis.some((item) => item.type === 'memory'));
  assert.ok(proposed.basis.some((item) => item.type === 'checkpoint'));
  assert.ok(proposed.basis.some((item) => item.type === 'memory_candidate'));
  assert.ok(proposed.proposedActions.some((item) => item.action === 'correct_memory'));
  assert.ok(proposed.proposedActions.some((item) => item.action === 'reject_memory_candidate'));
  assert.ok(proposed.updateCandidates.some((item) => item.action === 'correct_memory'));
  assert.ok(proposed.updateCandidates.some((item) => item.action === 'add_corrective_note'));
  assert.equal(
    app.listMemoryUpdateCandidates({
      scope: 'repo',
      scopeKey: 'reconcile-repo',
      status: 'pending',
    }).length,
    0,
  );
  const persisted = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    createUpdateCandidates: true,
  });
  assert.ok(persisted.updateCandidates.every((item) => item.status === 'pending'));
  await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    createUpdateCandidates: true,
  });
  const pendingUpdates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    status: 'pending',
  });
  assert.equal(pendingUpdates.length, 2);
  assert.ok(pendingUpdates.some((item) => item.targetMemoryKey === 'api-transport'));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content, 'The API uses REST only.');

  const updateCandidate = pendingUpdates.find((item) => item.action === 'correct_memory');
  const appliedUpdate = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    candidateId: updateCandidate.id,
    content: 'The API supports REST, GraphQL, and webhooks.',
    reason: 'Approved correction candidate in test.',
  });
  assert.equal(appliedUpdate.kind, 'memory_update_candidate_apply_result');
  assert.equal(appliedUpdate.candidate.status, 'applied');
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content,
    'The API supports REST, GraphQL, and webhooks.',
  );

  const applied = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    mode: 'apply_safe',
  });
  assert.ok(applied.appliedActions.some((item) => item.action === 'correct_memory'));
  assert.ok(applied.appliedActions.some((item) => item.action === 'reject_memory_candidate'));
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content,
    'The API supports REST and GraphQL.',
  );
  const corrected = app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' });
  assert.deepEqual(corrected.tags, ['api', 'transport']);
  assert.equal(corrected.importance, 6);

  const live = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'PR status on main',
    correction: 'PR #12 is not merged.',
    mode: 'apply_safe',
  });
  assert.ok(live.warnings.some((warning) => warning.code === 'live_state_verification_required'));
  assert.equal(live.appliedActions.length, 0);

  const koreanLive = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    correction: '그 PR 아직 안 머지됐잖아. 이슈 상태랑 원격 브랜치를 확인해야 해.',
    mode: 'apply_safe',
  });
  assert.ok(koreanLive.warnings.some((warning) => warning.code === 'live_state_verification_required'));
  assert.equal(koreanLive.appliedActions.length, 0);
});

test('memory update candidates can be rejected without mutating memory', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const original = app.remember({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    key: 'closeout-rule',
    content: 'Closeout requires local tests.',
    category: 'runbook',
  });
  const store = new ContextForgeStore({ dataDir });
  try {
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-reject-repo',
      action: 'deactivate_memory',
      targetMemoryId: original.id,
      targetMemoryKey: original.key,
      reason: 'Proposed stale rule deactivation.',
      confidence: 0.6,
    });
  } finally {
    store.close();
  }

  const candidates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    status: 'pending',
  });
  assert.equal(candidates.length, 1);
  const rejected = app.rejectMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    candidateId: candidates[0].id,
    reason: 'Keep the runbook active.',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'update-reject-repo', key: 'closeout-rule' }).status,
    'active',
  );

  const storeAgain = new ContextForgeStore({ dataDir });
  try {
    storeAgain.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-reject-repo',
      action: 'add_corrective_note',
      proposedKey: 'closeout-rule-note',
      proposedContent: 'Closeout requirements were reviewed but not changed.',
      reason: 'Optional note.',
    });
  } finally {
    storeAgain.close();
  }
  const skippedCandidate = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    status: 'pending',
  })[0];
  const skipped = app.skipMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    candidateId: skippedCandidate.id,
  });
  assert.equal(skipped.status, 'skipped');
});

test('memory update candidates apply deactivation and duplicate merge actions', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const stale = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'stale-runbook',
    content: 'This runbook is stale.',
    category: 'runbook',
  });
  const canonical = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'canonical-runbook',
    content: 'This runbook is canonical.',
    category: 'runbook',
  });
  const duplicate = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'duplicate-runbook',
    content: 'Duplicate runbook.',
    category: 'runbook',
  });
  const store = new ContextForgeStore({ dataDir });
  try {
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-apply-repo',
      action: 'deactivate_memory',
      targetMemoryId: stale.id,
      targetMemoryKey: stale.key,
      reason: 'Stale after product change.',
    });
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-apply-repo',
      action: 'merge_duplicate_memories',
      targetMemoryId: duplicate.id,
      targetMemoryKey: duplicate.key,
      proposedKey: canonical.key,
      reason: 'Duplicate durable memory.',
    });
  } finally {
    store.close();
  }

  const updates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    status: 'pending',
  });
  const deactivate = updates.find((item) => item.action === 'deactivate_memory');
  const merge = updates.find((item) => item.action === 'merge_duplicate_memories');

  const deactivated = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    candidateId: deactivate.id,
  });
  assert.equal(deactivated.candidate.status, 'applied');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: stale.key }).status, 'inactive');

  const merged = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    candidateId: merge.id,
  });
  assert.equal(merged.candidate.status, 'applied');
  assert.equal(merged.candidate.reviewMetadata.mergedIntoKey, canonical.key);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: duplicate.key }).status, 'inactive');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: canonical.key }).status, 'active');
});

test('reconcileMemory apply_safe rejects matching candidates when no durable memory matches', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_only_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_only_provider: async () => ({
        summaryShort: 'Candidate only checkpoint.',
        summaryText: 'Only a candidate exists for this correction.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'candidate-only',
            content: 'Candidate-only stale claim.',
            category: 'runbook',
            confidence: 0.8,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
    role: 'assistant',
    content: 'Candidate-only stale claim.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
  });

  const result = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
    query: 'candidate-only stale claim',
    correction: 'Candidate-only claim is wrong.',
    mode: 'apply_safe',
  });
  assert.deepEqual(
    result.appliedActions.map((action) => action.action),
    ['reject_memory_candidate'],
  );
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    status: 'rejected',
  });
  assert.equal(candidates.length, 1);
});

test('listScopeKeys returns real scopes from memories, candidates, and distill runs', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'scope_keys_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      scope_keys_provider: async () => ({
        summaryShort: 'Scope key checkpoint.',
        summaryText: 'A checkpoint that creates a candidate for scope key discovery.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'scope-key-candidate',
            content: 'Candidate used for scope key discovery.',
            category: 'note',
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
    scope: 'shared',
    scopeKey: 'team-shared',
    key: 'scope-key-memory',
    content: 'Durable memory used for scope key discovery.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-scope-keys',
    sessionId: 'scope-key-session',
    role: 'user',
    content: 'Create a checkpoint and candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-scope-keys',
    sessionId: 'scope-key-session',
  });

  const allKeys = app.listScopeKeys();
  const repoKey = allKeys.find((item) => item.scopeType === 'repo' && item.scopeKey === 'repo-scope-keys');
  assert.equal(repoKey.candidates, 1);
  assert.equal(repoKey.distillRuns, 1);
  assert.equal(repoKey.rawEvents, 1);
  assert.equal(repoKey.checkpoints, 1);
  const sharedKeys = app.listScopeKeys({ scope: 'shared' });
  assert.deepEqual(
    sharedKeys.map((item) => item.scopeKey),
    ['team-shared'],
  );
  assert.equal(sharedKeys[0].memories, 1);
});

test('REMOTE_METHODS exposes resume, suggestion, auto-promotion, and reconciliation wrappers', () => {
  assert.ok(REMOTE_METHODS.includes('readiness'));
  assert.ok(REMOTE_METHODS.includes('operationalMetrics'));
  assert.ok(REMOTE_METHODS.includes('migrateScope'));
  assert.ok(REMOTE_METHODS.includes('syncResumeContext'));
  assert.ok(REMOTE_METHODS.includes('agentStart'));
  assert.ok(REMOTE_METHODS.includes('agentCloseout'));
  assert.ok(REMOTE_METHODS.includes('getRuntimeSettings'));
  assert.ok(REMOTE_METHODS.includes('updateRuntimeSettings'));
  assert.ok(REMOTE_METHODS.includes('checkDistillProvider'));
  assert.ok(REMOTE_METHODS.includes('upsertWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('getWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('listWorkspaceProfiles'));
  assert.ok(REMOTE_METHODS.includes('deleteWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('deactivateWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('upsertWorkspaceMember'));
  assert.ok(REMOTE_METHODS.includes('removeWorkspaceMember'));
  assert.ok(REMOTE_METHODS.includes('upsertWorkspaceRoutingRule'));
  assert.ok(REMOTE_METHODS.includes('removeWorkspaceRoutingRule'));
  assert.ok(REMOTE_METHODS.includes('resolveWorkspace'));
  assert.ok(REMOTE_METHODS.includes('listScopeKeys'));
  assert.ok(REMOTE_METHODS.includes('listRecentDistillRuns'));
  assert.ok(REMOTE_METHODS.includes('expandMemoryCluster'));
  assert.ok(REMOTE_METHODS.includes('listLlmUsageEvents'));
  assert.ok(REMOTE_METHODS.includes('llmUsageRollup'));
  assert.ok(REMOTE_METHODS.includes('listDueDistillSessions'));
  assert.ok(REMOTE_METHODS.includes('processDueDistills'));
  assert.ok(REMOTE_METHODS.includes('submitDistillJob'));
  assert.ok(REMOTE_METHODS.includes('submitAuditJob'));
  assert.ok(REMOTE_METHODS.includes('getJob'));
  assert.ok(REMOTE_METHODS.includes('listJobs'));
  assert.ok(REMOTE_METHODS.includes('processJobs'));
  assert.ok(REMOTE_METHODS.includes('cancelJob'));
  assert.ok(REMOTE_METHODS.includes('listMemories'));
  assert.ok(REMOTE_METHODS.includes('suggestMemoryPromotions'));
  assert.ok(REMOTE_METHODS.includes('auditMemoryCandidates'));
  assert.ok(REMOTE_METHODS.includes('autoPromoteMemoryCandidates'));
  assert.ok(REMOTE_METHODS.includes('reconcileMemory'));
  assert.ok(REMOTE_METHODS.includes('listPreferenceOccurrences'));
  assert.ok(REMOTE_METHODS.includes('listMemoryUpdateCandidates'));
  assert.ok(REMOTE_METHODS.includes('auditMemoryDuplicates'));
  assert.ok(REMOTE_METHODS.includes('applyMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('rejectMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('skipMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('embeddingInventory'));
  assert.ok(REMOTE_METHODS.includes('pruneEmbeddingArtifacts'));
  assert.ok(REMOTE_METHODS.includes('processEmbeddingJobs'));
  assert.ok(REMOTE_METHODS.includes('listEmbeddingJobs'));
  assert.ok(REMOTE_METHODS.includes('listCheckpoints'));
  assert.ok(REMOTE_METHODS.includes('getSessionWorkingContext'));
  assert.ok(REMOTE_METHODS.includes('upsertSessionWorkingContext'));
});
