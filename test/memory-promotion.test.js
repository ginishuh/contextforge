import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

test('remember, getMemory, and search use explicit scopes', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const memory = app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'storage-mode',
    content: 'Use local SQLite in .contextforge for v0 runtime state.',
    category: 'decision',
    tags: ['storage', 'sqlite'],
    importance: 5,
  });

  assert.equal(memory.key, 'storage-mode');
  assert.equal(memory.scopeType, 'repo');

  const fetched = app.getMemory({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'storage-mode',
  });
  assert.equal(fetched.content, memory.content);

  const results = app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    query: 'sqlite runtime',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'storage-mode');
  assert.ok(results[0].why.some((hit) => hit.token === 'sqlite'));
});

test('promoteMemory writes durable memory with explicit provenance', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const memory = app.promoteMemory({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'promotion-rule',
    content: 'Checkpoint candidates require explicit promotion before becoming durable memory.',
    category: 'decision',
    tags: ['promotion'],
    importance: 3,
    sourceCheckpointId: 'checkpoint-1',
    sourceSessionId: 'session-1',
    sourceRawEventIds: ['raw-1'],
    reason: 'Reviewed during MCP implementation.',
  });

  assert.equal(memory.key, 'promotion-rule');
  assert.equal(memory.category, 'decision');

  const fetched = app.getMemory({
    scope: 'repo',
    scopeKey: 'github.com/example/contextforge',
    key: 'promotion-rule',
  });
  assert.equal(fetched.content, memory.content);
});

test('memory candidates require explicit promotion and can be corrected or deactivated', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('candidate-rule') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
    distillProviders: {
      candidate_provider: async () => ({
        summaryShort: 'Candidate checkpoint.',
        summaryText: 'The checkpoint proposes one durable memory candidate.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'candidate-rule',
            content: 'Promote reviewed checkpoint candidates explicitly.',
            category: 'policy',
            tags: ['promotion'],
            importance: 7,
            candidateType: 'project_policy',
            confidence: 0.91,
            stability: 0.88,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
            sourceEventIds: ['raw-candidate-1'],
          },
          {
            key: 'candidate-runbook',
            content: 'Review checkpoint candidates before promotion.',
            reason: 'Documents review queue behavior.',
            candidateType: 'runbook',
            confidence: 0.7,
            stability: 0.6,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
    role: 'assistant',
    content: 'Candidate: promote reviewed checkpoint candidates explicitly.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
  });
  assert.equal(checkpoint.memoryCandidateCount, 2);
  await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
  });

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
  });
  assert.equal(status.latestCheckpointId, checkpoint.id);
  assert.equal(status.latestCheckpointMemoryCandidateCount, 2);
  assert.match(status.memoryCandidateHint, /list_memory_candidates/);

  assert.equal(
    app.getMemory({
      scope: 'repo',
      scopeKey: 'repo-promote',
      key: 'candidate-rule',
    }),
    null,
  );

  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    sessionId: 'candidate-session',
  });
  assert.equal(candidates.length, 2);
  const candidateRule = candidates.find((candidate) => candidate.candidate.key === 'candidate-rule');
  assert.ok(candidateRule.id);
  assert.equal(candidateRule.status, 'pending');
  assert.equal(candidateRule.checkpointId, checkpoint.id);
  assert.equal(candidateRule.index, 0);
  assert.equal(candidateRule.candidate.reason, '');
  assert.deepEqual(candidateRule.candidate.tags, ['promotion']);
  assert.equal(candidateRule.candidate.importance, 7);
  assert.equal(candidateRule.candidate.candidateType, 'project_policy');
  assert.equal(candidateRule.candidate.confidence, 0.91);
  assert.equal(candidateRule.candidate.stability, 0.88);
  assert.equal(candidateRule.candidate.sensitivity, 'low');
  assert.equal(candidateRule.candidate.promotionRecommendation, 'promote');
  assert.deepEqual(candidateRule.candidate.sourceEventIds, ['raw-candidate-1']);
  assert.equal(candidateRule.source.provider, 'candidate_provider');
  const candidateRunbook = candidates.find((candidate) => candidate.candidate.key === 'candidate-runbook');
  assert.ok(candidateRunbook.id);

  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 2);

  const promotedRecommendationCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
    candidateType: 'project_policy',
    promotionRecommendation: 'promote',
    sort: 'recommendation',
  });
  assert.equal(promotedRecommendationCandidates.length, 1);
  assert.equal(promotedRecommendationCandidates[0].id, candidateRule.id);

  const limitedCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
    limit: 1,
  });
  assert.equal(limitedCandidates.length, 1);

  const candidateInfo = app.dbInfo();
  assert.equal(candidateInfo.tables.memoryCandidates, 2);

  const promotedFromCandidate = app.promoteMemoryCandidate({
    scope: 'repo',
    scopeKey: 'repo-promote',
    candidateId: candidateRule.id,
    key: 'candidate-rule-via-helper',
    reason: 'Reviewed via helper.',
  });
  assert.equal(promotedFromCandidate.key, 'candidate-rule-via-helper');
  assert.equal(promotedFromCandidate.content, candidateRule.candidate.content);
  const helperEmbeddingJobs = await app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.deepEqual(
    helperEmbeddingJobs.map((job) => job.sourceType),
    ['memory'],
  );
  await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
  });

  const helperEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule-via-helper',
  });
  assert.equal(helperEvents[0].metadata.sourceCheckpointId, checkpoint.id);
  assert.equal(helperEvents[0].metadata.sourceSessionId, 'candidate-session');
  assert.equal(helperEvents[0].metadata.sourceCandidateId, candidateRule.id);
  assert.deepEqual(helperEvents[0].metadata.candidateSourceEventIds, ['raw-candidate-1']);

  const promotedCandidate = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'promoted',
  });
  assert.equal(promotedCandidate.length, 1);
  assert.equal(promotedCandidate[0].id, candidateRule.id);
  assert.equal(promotedCandidate[0].promotedMemoryId, promotedFromCandidate.id);
  assert.equal(promotedCandidate[0].reviewReason, 'Reviewed via helper.');
  assert.ok(promotedCandidate[0].reviewedAt);
  assert.throws(
    () =>
      app.rejectMemoryCandidate({
        scope: 'repo',
        scopeKey: 'repo-promote',
        candidateId: candidateRule.id,
        reason: 'Should not reject after promotion.',
      }),
    /expected pending/,
  );

  const rejectedCandidate = app.rejectMemoryCandidate({
    scope: 'repo',
    scopeKey: 'repo-promote',
    candidateId: candidateRunbook.id,
    reason: 'Too procedural for durable memory.',
  });
  assert.equal(rejectedCandidate.status, 'rejected');
  assert.equal(rejectedCandidate.reviewReason, 'Too procedural for durable memory.');
  assert.equal(rejectedCandidate.reviewMetadata.sourceCandidateIndex, 1);
  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'repo-promote',
        candidateId: candidateRunbook.id,
      }),
    /expected pending/,
  );

  const pendingAfterReview = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.equal(pendingAfterReview.length, 0);

  app.deactivateMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule-via-helper',
    reason: 'Keep the helper assertion isolated from search assertions.',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('DELETE FROM memory_candidate_index').run();
    db.prepare("DELETE FROM schema_meta WHERE key = 'memory_candidate_index_backfill_completed_at'").run();
  } finally {
    db.close();
  }
  const appAfterBackfill = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  assert.equal(
    appAfterBackfill.listMemoryCandidates({
      scope: 'repo',
      scopeKey: 'repo-promote',
      sessionId: 'candidate-session',
    }).length,
    2,
  );

  const promoted = app.promoteMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: candidateRule.candidate.key,
    content: candidateRule.candidate.content,
    category: candidateRule.candidate.category,
    tags: candidateRule.candidate.tags,
    sourceCheckpointId: candidateRule.checkpointId,
    sourceSessionId: candidateRule.sessionId,
    sourceCandidateIndex: candidateRule.index,
    reason: 'Reviewed synthetic candidate.',
  });
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.key, 'candidate-rule');
  const promoteMemoryEmbeddingJobs = await app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
    status: 'pending',
  });
  assert.ok(promoteMemoryEmbeddingJobs.some((job) => job.sourceType === 'memory'));

  const promoteEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
  });
  assert.equal(promoteEvents.length, 1);
  assert.equal(promoteEvents[0].eventType, 'promote');
  assert.equal(promoteEvents[0].metadata.sourceCheckpointId, checkpoint.id);
  assert.equal(promoteEvents[0].metadata.sourceCandidateIndex, 0);

  const corrected = app.correctMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
    content: 'Promote reviewed checkpoint candidates explicitly after human or agent review.',
    reason: 'Clarify review requirement.',
  });
  assert.equal(corrected.supersedesMemoryId, promoted.id);
  assert.match(corrected.content, /agent review/);

  const correctEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
  });
  assert.equal(correctEvents.length, 2);
  assert.equal(correctEvents[1].eventType, 'correct');
  assert.equal(correctEvents[1].metadata.previousContent, promoted.content);
  const processedPromoteMemoryEmbedding = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-promote',
  });
  assert.ok(processedPromoteMemoryEmbedding.bySourceType.memory >= 1);

  const searchBeforeDeactivate = await app.search({
    scope: 'repo',
    scopeKey: 'repo-promote',
    query: 'human agent review',
  });
  const memoryBeforeDeactivate = searchBeforeDeactivate.find((result) => result.type === 'memory');
  assert.ok(memoryBeforeDeactivate, 'expected memory result before deactivation');
  assert.equal(memoryBeforeDeactivate.memory.key, 'candidate-rule');

  const inactive = app.deactivateMemory({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
    reason: 'Superseded outside this test.',
  });
  assert.equal(inactive.status, 'inactive');
  assert.ok(inactive.deactivatedAt);

  const deactivateEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'repo-promote',
    key: 'candidate-rule',
  });
  assert.equal(deactivateEvents.length, 3);
  assert.equal(deactivateEvents[2].eventType, 'deactivate');

  const searchAfterDeactivate = await app.search({
    scope: 'repo',
    scopeKey: 'repo-promote',
    query: 'agent review',
  });
  assert.equal(searchAfterDeactivate.find((result) => result.type === 'memory'), undefined);
});

test('CLI supports promoteMemory', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const promoted = await execFileAsync(
      'node',
      [
      path.resolve('src/cli.js'),
      'promoteMemory',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--key',
      'promoted-rule',
      '--content',
      'Promoted memories are durable.',
      '--sourceCheckpointId',
      'checkpoint-cli',
      '--reason',
      'Synthetic CLI test.',
    ],
    { env },
  );
  assert.match(promoted.stdout, /"key": "promoted-rule"/);

  const fetched = await execFileAsync(
    'node',
    ['src/cli.js', 'getMemory', '--scope', 'repo', '--scopeKey', 'cli-repo', '--key', 'promoted-rule'],
    { env },
  );
  assert.match(fetched.stdout, /Promoted memories are durable/);
});

test('CLI supports candidate id promotion and rejection', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_provider: async () => ({
        summaryShort: 'CLI candidate checkpoint.',
        summaryText: 'The checkpoint proposes CLI candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'cli-candidate-promote',
            content: 'CLI can promote a memory candidate by id.',
          },
          {
            key: 'cli-candidate-reject',
            content: 'CLI can reject a memory candidate by id.',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'cli-review',
    sessionId: 'cli-review-session',
    role: 'assistant',
    content: 'Candidate review queue CLI smoke.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'cli-review',
    sessionId: 'cli-review-session',
  });
  const cliCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'cli-review',
    status: 'pending',
  });
  const promoteCandidate = cliCandidates.find((candidate) => candidate.candidate.key === 'cli-candidate-promote');
  const rejectCandidate = cliCandidates.find((candidate) => candidate.candidate.key === 'cli-candidate-reject');

  const promoted = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'promoteMemoryCandidate',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-review',
      '--candidateId',
      promoteCandidate.id,
      '--reason',
      'Reviewed from CLI.',
    ],
    { env },
  );
  assert.match(promoted.stdout, /"key": "cli-candidate-promote"/);

  const rejected = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'rejectMemoryCandidate',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-review',
      '--candidateId',
      rejectCandidate.id,
      '--reason',
      'Rejected from CLI.',
    ],
    { env },
  );
  assert.match(rejected.stdout, /"status": "rejected"/);
  assert.match(rejected.stdout, /Rejected from CLI/);

  const listed = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'listMemoryCandidates',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-review',
      '--status',
      'promoted',
    ],
    { env },
  );
  assert.match(listed.stdout, /"promotedMemoryId":/);
});

test('candidate promotion warnings require explicit override', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'warning_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      warning_provider: async () => ({
        summaryShort: 'Warning checkpoint.',
        summaryText: 'The checkpoint proposes risky candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'existing-rule',
            content: 'Different content for the same key.',
            reason: 'Tests key conflict detection.',
            candidateType: 'project_policy',
            confidence: 0.4,
            stability: 0.4,
            sensitivity: 'high',
            promotionRecommendation: 'reject',
          },
          {
            key: 'duplicate-content-rule',
            content: 'Existing durable memory content.',
            reason: 'Tests exact content duplicate detection.',
            promotionRecommendation: 'promote',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'warning-repo',
    key: 'existing-rule',
    content: 'Original durable memory content.',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'warning-repo',
    key: 'existing-content-rule',
    content: 'Existing durable memory content.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'warning-repo',
    sessionId: 'warning-session',
    role: 'assistant',
    content: 'Candidate: risky promotion.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'warning-repo',
    sessionId: 'warning-session',
  });
  const warningCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'warning-repo',
    status: 'pending',
    sort: 'recommendation',
  });
  const conflictCandidate = warningCandidates.find((candidate) => candidate.candidate.key === 'existing-rule');
  const duplicateContentCandidate = warningCandidates.find(
    (candidate) => candidate.candidate.key === 'duplicate-content-rule',
  );

  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'warning-repo',
        candidateId: conflictCandidate.id,
      }),
    /allowWarnings/,
  );

  try {
    app.promoteMemoryCandidate({
      scope: 'repo',
      scopeKey: 'warning-repo',
      candidateId: conflictCandidate.id,
    });
    assert.fail('Expected warning error.');
  } catch (error) {
    assert.equal(error.name, 'MemoryCandidatePromotionWarningError');
    assert.deepEqual(
      error.warnings.map((warning) => warning.code),
      [
        'candidate_conflict_requires_update',
        'existing_key_conflict',
        'high_sensitivity',
        'recommendation_not_promote',
        'low_confidence',
        'low_stability',
      ],
    );
  }

  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'warning-repo',
        candidateId: duplicateContentCandidate.id,
      }),
    /allowWarnings/,
  );

  const promoted = app.promoteMemoryCandidate({
    scope: 'repo',
    scopeKey: 'warning-repo',
    candidateId: conflictCandidate.id,
    allowWarnings: true,
    reason: 'Reviewed warnings and accepted.',
  });
  assert.equal(promoted.key, 'existing-rule');

  const events = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'warning-repo',
    key: 'existing-rule',
  });
  assert.equal(events.at(-1).eventType, 'promote');
  assert.ok(events.at(-1).metadata.promotionWarnings.length >= 1);
});

test('promotion quality assessment prefers update proposals over duplicate durable memories', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'dedupe_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      dedupe_provider: async () => ({
        summaryShort: 'Dedupe checkpoint.',
        summaryText: 'The checkpoint proposes overlapping memory candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'runtime-verification',
            content: 'Verify git, GitHub, CI, runtime health, and migrations before making live-state claims.',
            reason: 'Adds CI and migration specifics to the existing runtime verification rule.',
            category: 'runbook',
            tags: ['runtime', 'verification'],
            importance: 72,
            confidence: 0.9,
            stability: 0.9,
            promotionRecommendation: 'promote',
          },
          {
            key: 'duplicate-runtime-rule',
            content: 'Verify git and GitHub before making live-state claims.',
            reason: 'Exact duplicate content should not be promoted again.',
            category: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            promotionRecommendation: 'promote',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'dedupe-repo',
    key: 'runtime-verification',
    content: 'Verify git and GitHub before making live-state claims.',
    category: 'runbook',
    importance: 99,
  });
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'dedupe-repo', key: 'runtime-verification' }).importance,
    10,
  );
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'dedupe-repo',
    sessionId: 'dedupe-session',
    role: 'assistant',
    content: 'Candidate: improve runtime verification memory.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'dedupe-repo',
    sessionId: 'dedupe-session',
  });

  const suggestions = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'dedupe-repo',
    sessionId: 'dedupe-session',
    trigger: 'manual_closeout',
    createUpdateCandidates: true,
    scanLimit: 10,
  });
  assert.equal(suggestions.proposals.length, 0);
  assert.equal(suggestions.updateCandidates.length, 1);
  assert.equal(suggestions.updateCandidates[0].action, 'correct_memory');
  assert.equal(suggestions.updateCandidates[0].targetMemoryKey, 'runtime-verification');
  assert.equal(suggestions.updateCandidates[0].promotionAssessment.classification, 'refinement');
  assert.equal(suggestions.updateCandidates[0].proposedImportance, 10);
  assert.ok(
    suggestions.skipped.some(
      (item) => item.promotionAssessment?.classification === 'refinement',
    ),
  );
  assert.ok(
    suggestions.skipped.some(
      (item) => item.promotionAssessment?.classification === 'duplicate',
    ),
  );

  const updateCandidates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'dedupe-repo',
    status: 'pending',
  });
  assert.equal(updateCandidates.length, 1);
  assert.equal(updateCandidates[0].targetMemoryKey, 'runtime-verification');

  const duplicateCandidate = app
    .listMemoryCandidates({
      scope: 'repo',
      scopeKey: 'dedupe-repo',
      status: 'pending',
    })
    .find((candidate) => candidate.candidate.key === 'duplicate-runtime-rule');
  assert.equal(duplicateCandidate.candidate.importance, 0);
  assert.throws(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'dedupe-repo',
        candidateId: duplicateCandidate.id,
      }),
    /allowWarnings/,
  );
});

test('promotion quality assessment covers supersedes, too-specific, and new candidates', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'classification_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      classification_provider: async () => ({
        summaryShort: 'Classification checkpoint.',
        summaryText: 'The checkpoint proposes several promotion classifications.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'runtime-verification',
            content: 'Verify git, GitHub, CI, runtime health, and migrations before acting on live state.',
            reason: 'This is a more complete runtime verification rule that should supersede the older version.',
            category: 'runbook',
            confidence: 0.92,
            stability: 0.9,
            promotionRecommendation: 'promote',
          },
          {
            key: 'pr-142-status',
            content: 'PR #142 CI passed on Node 20, 22, and 24.',
            reason: 'One-off PR status should stay in checkpoint context.',
            category: 'temporary',
            confidence: 0.95,
            stability: 0.95,
            promotionRecommendation: 'promote',
          },
          {
            key: 'api-contract-rule',
            content: 'API contract memories should include endpoint, request shape, response shape, and migration notes.',
            reason: 'Reusable API contract guidance.',
            category: 'api-contract',
            confidence: 0.95,
            stability: 0.95,
            promotionRecommendation: 'promote',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'classification-repo',
    key: 'runtime-verification',
    content: 'Verify git and GitHub before acting on live state.',
    category: 'runbook',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'classification-repo',
    sessionId: 'classification-session',
    role: 'assistant',
    content: 'Candidate: classify memory promotions.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'classification-repo',
    sessionId: 'classification-session',
  });

  const suggestions = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'classification-repo',
    sessionId: 'classification-session',
    trigger: 'manual_closeout',
    createUpdateCandidates: true,
    scanLimit: 10,
  });

  assert.ok(suggestions.proposals.some((proposal) => proposal.key === 'api-contract-rule'));
  assert.ok(
    suggestions.updateCandidates.some(
      (candidate) =>
        candidate.targetMemoryKey === 'runtime-verification' &&
        candidate.reason.includes('supersedes'),
    ),
  );
  assert.ok(
    suggestions.skipped.some(
      (item) => item.promotionAssessment?.classification === 'too_specific',
    ),
  );
});

test('auditMemoryDuplicates reports merge proposals without mutating by default', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'duplicate-audit-repo',
    key: 'runtime-rule-a',
    content: 'Agents must verify git and GitHub before making live-state claims.',
    category: 'runbook',
    importance: 5,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'duplicate-audit-repo',
    key: 'runtime-rule-b',
    content: 'Agents must verify git and GitHub before making live-state claims.',
    category: 'runbook',
    importance: 2,
  });

  const dryRun = app.auditMemoryDuplicates({
    scope: 'repo',
    scopeKey: 'duplicate-audit-repo',
  });
  assert.equal(dryRun.duplicatePairs.length, 1);
  assert.equal(dryRun.duplicatePairs[0].survivor.key, 'runtime-rule-a');
  assert.equal(dryRun.duplicatePairs[0].updateCandidate.status, 'proposed');
  assert.equal(
    app.listMemoryUpdateCandidates({
      scope: 'repo',
      scopeKey: 'duplicate-audit-repo',
    }).length,
    0,
  );

  const persisted = app.auditMemoryDuplicates({
    scope: 'repo',
    scopeKey: 'duplicate-audit-repo',
    createUpdateCandidates: true,
  });
  assert.equal(persisted.duplicatePairs[0].updateCandidate.status, 'pending');
  assert.equal(
    app.listMemoryUpdateCandidates({
      scope: 'repo',
      scopeKey: 'duplicate-audit-repo',
      action: 'merge_duplicate_memories',
    }).length,
    1,
  );
});

test('auditMemoryDuplicates limits persisted update candidates after sorting and dedupe', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  for (const [key, importance] of [
    ['runtime-rule-a', 9],
    ['runtime-rule-b', 5],
    ['runtime-rule-c', 1],
  ]) {
    app.remember({
      scope: 'repo',
      scopeKey: 'duplicate-limit-repo',
      key,
      content: 'Agents must verify git and GitHub before making live-state claims.',
      category: 'runbook',
      importance,
    });
  }

  const result = app.auditMemoryDuplicates({
    scope: 'repo',
    scopeKey: 'duplicate-limit-repo',
    createUpdateCandidates: true,
    limit: 1,
  });

  assert.equal(result.matchedPairs, 3);
  assert.equal(result.duplicatePairs.length, 1);
  assert.equal(
    app.listMemoryUpdateCandidates({
      scope: 'repo',
      scopeKey: 'duplicate-limit-repo',
      action: 'merge_duplicate_memories',
    }).length,
    1,
  );
});
