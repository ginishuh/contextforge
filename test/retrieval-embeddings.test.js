import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION } from '../src/distill/validate.js';
import { createOpenAiEmbeddingProvider } from '../src/embeddings/index.js';
import { searchMemories } from '../src/retrieval/search.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

const execFileAsync = promisify(execFile);

test('search can combine repo and shared scopes while excluding local by default', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-combined',
    key: 'repo-rule',
    content: 'Always inspect repository code before changing retrieval behavior.',
    category: 'decision',
    importance: 1,
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'shared-rule',
    content: 'Always keep retrieval explanations visible.',
    category: 'policy',
    importance: 10,
  });
  app.remember({
    scope: 'local',
    scopeKey: 'machine-a',
    key: 'local-rule',
    content: 'Always keep this local-only retrieval note private to this machine.',
    category: 'note',
    importance: 99,
  });

  const combined = app.search({
    scope: 'repo',
    scopeKey: 'repo-combined',
    searchScopes: 'repo+shared',
    query: 'always retrieval',
  });

  assert.deepEqual(
    combined.map((result) => result.memory.key),
    ['repo-rule', 'shared-rule'],
  );
  assert.deepEqual(
    combined.map((result) => result.source.role),
    ['repo', 'shared'],
  );
  assert.ok(combined.every((result) => result.source.scopeType !== 'local'));
  assert.ok(combined.every((result) => result.why.some((hit) => hit.token === 'retrieval')));

  const local = app.search({
    scope: 'local',
    scopeKey: 'machine-a',
    searchScopes: 'local',
    query: 'retrieval',
  });
  assert.equal(local.length, 1);
  assert.equal(local[0].memory.key, 'local-rule');
  assert.equal(local[0].source.role, 'local');
});

test('search supports shared-only retrieval with an explicit shared scope key', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-shared-only',
    key: 'repo-rule',
    content: 'Repo retrieval should not appear in a shared-only query.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'team',
    key: 'team-rule',
    content: 'Shared retrieval can be requested independently.',
  });

  const results = app.search({
    scope: 'repo',
    scopeKey: 'repo-shared-only',
    searchScopes: 'shared',
    sharedScopeKey: 'team',
    query: 'retrieval',
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'team-rule');
  assert.equal(results[0].source.scopeType, 'shared');
  assert.equal(results[0].source.scopeKey, 'team');
});

test('search uses explainable FTS-backed ranking while keeping durable memory canonical', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-quality',
    key: 'retrieval-quality',
    content: 'Use SQLite FTS for explainable retrieval ranking.',
    category: 'decision',
    tags: ['search'],
    importance: 1,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-quality',
    key: 'general-note',
    content: 'Retrieval can mention ranking in a lower priority note.',
    category: 'note',
    tags: [],
    importance: 10,
  });

  const results = app.search({
    scope: 'repo',
    scopeKey: 'repo-quality',
    query: 'retriev qual',
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].memory.key, 'retrieval-quality');
  assert.equal(results[0].retrieval.method, 'fts5+lexical');
  assert.ok(results[0].why.some((hit) => hit.token === 'retriev' && hit.matchTypes.includes('prefix')));
  assert.ok(results[0].why.some((hit) => hit.fields.includes('key')));
  assert.ok(results.every((result) => result.retrieval.ftsRank != null));

  const fetched = app.getMemory({
    scope: 'repo',
    scopeKey: 'repo-quality',
    key: 'retrieval-quality',
  });
  assert.equal(fetched.content, 'Use SQLite FTS for explainable retrieval ranking.');
});

test('search retrieves Korean keys, content, and tags without embeddings', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
    },
    cwd: process.cwd(),
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-korean-lexical',
    key: '배포-체크리스트',
    content: '운영 서버 배포 절차와 복구 기준을 기록한다.',
    category: 'runbook',
    tags: ['장애복구'],
  });

  for (const [query, token, field] of [
    ['체크리스트', '체크리스트', 'key'],
    ['운영 절차', '운영', 'content'],
    ['장애복구', '장애복구', 'tags'],
    ['값', '값', 'content'],
  ]) {
    if (query === '값') {
      app.remember({
        scope: 'repo',
        scopeKey: 'repo-korean-lexical',
        key: '단일-문자',
        content: '설정 키 값 보존 규칙.',
      });
    }
    const results = app.search({
      scope: 'repo',
      scopeKey: 'repo-korean-lexical',
      query,
    });
    assert.ok(results.length > 0, `Expected a lexical result for ${query}`);
    const expectedKey = query === '값' ? '단일-문자' : '배포-체크리스트';
    const result = results.find((item) => item.memory.key === expectedKey);
    assert.ok(result, `Expected ${expectedKey} for ${query}`);
    assert.match(result.retrieval.method, /lexical/);
    assert.ok(result.why.some((hit) => hit.token === token && hit.fields.includes(field)));
  }
});

test('mixed Korean and ASCII lexical ranking preserves path API and error tokens', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
    },
    cwd: process.cwd(),
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-mixed-lexical',
    key: 'api-장애대응',
    content: 'POST /v0/dbInfo 요청의 SQLITE_BUSY 오류 복구 절차.',
    tags: ['운영'],
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-mixed-lexical',
    key: 'api-request-note',
    content: 'POST /v0/other 요청을 기록한다.',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-mixed-lexical',
    key: 'unicode-normalization',
    content: 'Ｆｕｌｌｗｉｄｔｈ ＡＰＩ 호환성 규칙.',
  });

  const results = app.search({
    scope: 'repo',
    scopeKey: 'repo-mixed-lexical',
    query: 'POST 장애대응 /v0/dbInfo SQLITE_BUSY',
  });

  assert.equal(results[0].memory.key, 'api-장애대응');
  assert.ok(results[0].why.some((hit) => hit.token === '장애대응' && hit.fields.includes('key')));
  assert.ok(results[0].why.some((hit) => hit.token === '/v0/dbinfo' && hit.fields.includes('content')));
  assert.ok(results[0].why.some((hit) => hit.token === 'sqlite_busy' && hit.fields.includes('content')));

  const normalizedResults = app.search({
    scope: 'repo',
    scopeKey: 'repo-mixed-lexical',
    query: 'fullwidth API 호환성',
  });
  assert.equal(normalizedResults[0].memory.key, 'unicode-normalization');
  assert.ok(normalizedResults[0].why.some((hit) => hit.token === 'api'));
});

test('Korean lexical matches remain ranked when embeddings are enabled', async () => {
  const dataDir = await makeTempDir();
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) =>
        String(text).includes('한국어 검색 정책') || String(text) === '한국어 정책' ? [1, 0, 0] : [0, 1, 0],
      );
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: { openai: provider },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-korean-hybrid',
    key: '한국어-정책',
    content: '한국어 검색 정책은 lexical 결과를 유지한다.',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-korean-hybrid',
    key: 'unrelated-note',
    content: 'An unrelated embedding neighbor.',
  });
  await app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-korean-hybrid' });

  const results = await app.search({
    scope: 'repo',
    scopeKey: 'repo-korean-hybrid',
    query: '한국어 정책',
  });

  assert.equal(results[0].memory.key, '한국어-정책');
  assert.equal(results[0].retrieval.method, 'hybrid:fts5+vector+lexical');
  assert.ok(results[0].why.some((hit) => hit.token === '한국어'));
});

test('embedding rebuild populates sqlite-vec index for hybrid retrieval', async () => {
  const dataDir = await makeTempDir();
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => {
        const value = String(text).toLowerCase();
        if (value.includes('semantic fruit')) return [1, 0, 0];
        if (value.includes('apple')) return [1, 0, 0];
        if (value.includes('database')) return [0, 1, 0];
        return [0, 0, 1];
      });
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
    scopeKey: 'repo-vector',
    key: 'apple-note',
    content: 'Apple orchards need pollination planning.',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector',
    key: 'database-note',
    content: 'Database migrations need rollback planning.',
  });

  const rebuilt = await app.rebuildEmbeddings({
    scope: 'repo',
    scopeKey: 'repo-vector',
  });
  assert.equal(rebuilt.embedded, 2);
  assert.equal(rebuilt.dimensions, 3);
  assert.deepEqual(rebuilt.bySourceType, { memory: 2 });

  const results = await app.search({
    scope: 'repo',
    scopeKey: 'repo-vector',
    query: 'semantic fruit',
  });

  assert.equal(results[0].memory.key, 'apple-note');
  assert.equal(results[0].retrieval.method, 'vector');
  assert.equal(results[0].retrieval.vectorDistance, 0);
  assert.equal(results[0].retrieval.vectorModel, 'test-embedding');
  assert.equal(results[0].retrieval.vectorDimensions, 3);

  const info = app.dbInfo();
  assert.equal(info.tables.embeddings, 2);
  assert.equal(info.vector.sqliteVecAvailable, true);
  assert.equal(info.vector.dimensions, 3);
});

test('embedding maintenance inventory and GC remove only eligible artifacts in bounded batches', async () => {
  const dataDir = await makeTempDir();
  const scopeKey = 'repo-embedding-maintenance';
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map(() => [1, 0, 0]);
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'maintenance_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: { openai: embeddingProvider },
    distillProviders: {
      maintenance_provider: async () => ({
        summaryShort: 'Embedding maintenance checkpoint.',
        summaryText: 'Candidates exercise pending, promoted, and rejected retention.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          { key: 'pending-candidate', content: 'Keep pending candidate embedding.', reason: 'Awaiting review.' },
          { key: 'promoted-candidate', content: 'Keep promoted candidate embedding.', reason: 'Approved.' },
          { key: 'rejected-candidate', content: 'Delete rejected candidate embedding.', reason: 'Rejected.' },
          { key: 'stale-candidate', content: 'Delete stale candidate embedding.', reason: 'Stale.' },
          { key: 'snoozed-candidate', content: 'Delete snoozed candidate embedding.', reason: 'Snoozed.' },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  try {
    const active = app.remember({
      scope: 'repo',
      scopeKey,
      key: 'active-current',
      content: 'This current active embedding must survive GC.',
    });
    const inactive = app.remember({
      scope: 'repo',
      scopeKey,
      key: 'inactive-memory',
      content: 'This inactive memory embedding is eligible for GC.',
    });
    const staleHash = app.remember({
      scope: 'repo',
      scopeKey,
      key: 'stale-hash',
      content: 'This source has a deliberately stale content hash.',
    });
    const retired = app.remember({
      scope: 'repo',
      scopeKey,
      key: 'retired-model',
      content: 'This source was indexed with a retired model.',
    });
    app.appendRaw({
      scope: 'repo',
      scopeKey,
      sessionId: 'embedding-maintenance-session',
      role: 'assistant',
      content: 'Create candidate lifecycle fixtures.',
    });
    await app.distillCheckpoint({
      scope: 'repo',
      scopeKey,
      sessionId: 'embedding-maintenance-session',
    });
    await app.processEmbeddingJobs({ scope: 'repo', scopeKey, limit: 100 });

    const candidates = app.listMemoryCandidates({ scope: 'repo', scopeKey });
    const pendingCandidate = candidates.find((item) => item.candidate.key === 'pending-candidate');
    const promotedCandidate = candidates.find((item) => item.candidate.key === 'promoted-candidate');
    const rejectedCandidate = candidates.find((item) => item.candidate.key === 'rejected-candidate');
    const staleCandidate = candidates.find((item) => item.candidate.key === 'stale-candidate');
    const snoozedCandidate = candidates.find((item) => item.candidate.key === 'snoozed-candidate');
    app.promoteMemoryCandidate({
      scope: 'repo',
      scopeKey,
      candidateId: promotedCandidate.id,
      reason: 'Promotion fixture.',
    });
    app.rejectMemoryCandidate({
      scope: 'repo',
      scopeKey,
      candidateId: rejectedCandidate.id,
      reason: 'Rejection fixture.',
    });
    await app.processEmbeddingJobs({ scope: 'repo', scopeKey, limit: 100 });
    app.deactivateMemory({ scope: 'repo', scopeKey, key: inactive.key, reason: 'Maintenance fixture.' });

    const store = new ContextForgeStore({ dataDir });
    try {
      store.upsertEmbedding({
        sourceType: 'memory',
        recordId: 'missing-memory',
        scopeType: 'repo',
        scopeKey,
        model: 'test-embedding',
        dimensions: 3,
        contentHash: 'missing-source-hash',
        embedding: [0, 1, 0],
      });
      store.upsertEmbedding({
        sourceType: 'memory',
        recordId: 'vector-only-memory',
        scopeType: 'repo',
        scopeKey,
        model: 'test-embedding',
        dimensions: 3,
        contentHash: 'vector-only-hash',
        embedding: [0, 0, 1],
      });
      store.db.prepare('DELETE FROM embedding_index WHERE source_id = ?').run('memory:vector-only-memory');
      store.db
        .prepare('UPDATE embedding_index SET content_hash = ? WHERE source_id = ?')
        .run('stale-index-hash', `memory:${staleHash.id}`);
      store.db
        .prepare('UPDATE embedding_index SET model = ? WHERE source_id = ?')
        .run('retired-embedding-model', `memory:${retired.id}`);
      store.db.prepare('UPDATE memory_candidate_index SET status = ? WHERE id = ?').run('stale', staleCandidate.id);
      store.db.prepare('UPDATE memory_candidate_index SET status = ? WHERE id = ?').run('snoozed', snoozedCandidate.id);
      store.db
        .prepare(
          "UPDATE embedding_jobs SET completed_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE record_id = ?",
        )
        .run(active.id);
      const [processingJob] = store.enqueueEmbeddingJobs(
        [
          {
            sourceType: 'memory',
            scopeType: 'repo',
            scopeKey,
            recordId: 'processing-missing-memory',
            contentHash: 'processing-hash',
          },
        ],
        { model: 'test-embedding', dimensions: 3 },
      );
      store.markEmbeddingJobProcessing(processingJob.id);
      const [failedJob] = store.enqueueEmbeddingJobs(
        [
          {
            sourceType: 'memory',
            scopeType: 'repo',
            scopeKey,
            recordId: 'failed-missing-memory',
            contentHash: 'failed-hash',
          },
        ],
        { model: 'test-embedding', dimensions: 3 },
      );
      store.markEmbeddingJobProcessing(failedJob.id);
      store.markEmbeddingJobFailed(failedJob.id, new Error('Synthetic maintenance failure.'));
    } finally {
      store.close();
    }

    const scopedInventory = app.embeddingInventory({
      scope: 'repo',
      scopeKey,
      completedJobRetentionDays: 1,
    });
    assert.equal(scopedInventory.eligible.vectorOnly, 0);
    assert.equal(scopedInventory.skippedUnknownScopeVectorRows, null);
    const limitedInventory = app.embeddingInventory({ scope: 'repo', scopeKey, scanLimit: 1 });
    assert.equal(limitedInventory.scanned.jobs, 1);
    assert.equal(limitedInventory.truncated.jobs, true);
    assert.equal(limitedInventory.processingJobs, 1);
    assert.ok(limitedInventory.nextCursor);
    const pagedReasons = new Set(Object.keys(limitedInventory.byReason));
    let inventoryCursor = limitedInventory.nextCursor;
    for (let page = 0; inventoryCursor && page < 50; page += 1) {
      const next = app.embeddingInventory({ scope: 'repo', scopeKey, scanLimit: 1, cursor: inventoryCursor });
      for (const reason of Object.keys(next.byReason)) pagedReasons.add(reason);
      inventoryCursor = next.nextCursor;
    }
    assert.equal(inventoryCursor, null);
    assert.ok(pagedReasons.has('orphan_source'));
    assert.ok(pagedReasons.has('candidate_stale'));
    assert.throws(
      () =>
        app.embeddingInventory({
          scope: 'repo',
          scopeKey: 'different-scope',
          scanLimit: 1,
          cursor: limitedInventory.nextCursor,
        }),
      /cursor does not match/,
    );
    const inventory = app.embeddingInventory({ completedJobRetentionDays: 1 });
    assert.equal(inventory.processingJobs, 1);
    assert.ok(inventory.byReason.inactive_memory >= 1);
    assert.ok(inventory.byReason.candidate_rejected >= 1);
    assert.ok(inventory.byReason.candidate_stale >= 1);
    assert.ok(inventory.byReason.candidate_snoozed >= 1);
    assert.ok(inventory.byReason.orphan_source >= 1);
    assert.ok(inventory.byReason.vector_without_index >= 1);
    assert.ok(inventory.byReason.content_hash_mismatch >= 1);
    assert.ok(inventory.byReason.retired_model_or_dimensions >= 1);
    assert.ok(inventory.byReason.old_completed_job >= 1);
    assert.ok(inventory.byReason.orphan_job_source >= 1);
    assert.ok(!inventory.artifacts.some((item) => item.sourceId === `memory:${active.id}`));
    assert.ok(!inventory.artifacts.some((item) => item.sourceId === `memory_candidate:${pendingCandidate.id}`));
    assert.ok(!inventory.artifacts.some((item) => item.sourceId === `memory_candidate:${promotedCandidate.id}`));

    const disabledApp = createContextForge({
      env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none' },
      cwd: process.cwd(),
    });
    try {
      const disabledInventory = disabledApp.embeddingInventory({ completedJobRetentionDays: 1 });
      assert.equal(disabledInventory.current.authoritative, false);
      assert.ok(!disabledInventory.artifacts.some((item) => item.reason === 'retired_model_or_dimensions'));
      assert.ok(!disabledInventory.jobs.some((item) => item.reason === 'retired_job_model_or_dimensions'));
    } finally {
      disabledApp.close();
    }

    const dryRun = app.pruneEmbeddingArtifacts({ completedJobRetentionDays: 1, batchSize: 100 });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.deleted.vectors, 0);
    assert.ok(dryRun.plan.total > 0);
    assert.equal(dryRun.includeRetired, false);
    assert.equal(dryRun.includeInventory, false);
    assert.equal(dryRun.inventory.artifacts, undefined);
    assert.equal(dryRun.skippedRetiredArtifacts, 1);
    assert.ok(!dryRun.plan.artifacts.some((item) => item.reason === 'retired_model_or_dimensions'));
    assert.ok(dryRun.reindexSuggestedSourceIds.includes(`memory:${staleHash.id}`));
    assert.ok(dryRun.plan.artifacts.every((item) => item.sourceType && item.reason));
    assert.ok(dryRun.plan.vectorOnly.every((item) => item.sourceType && item.reason === 'vector_without_index'));
    assert.ok(dryRun.plan.jobs.every((item) => item.sourceType && item.status && item.reason));

    const blocked = app.pruneEmbeddingArtifacts({
      completedJobRetentionDays: 1,
      batchSize: 100,
      dryRun: false,
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.blockedReason, 'embedding_jobs_processing');
    assert.equal(blocked.blockedRetry, true);
    assert.equal(blocked.needsRescan, true);
    assert.equal(blocked.nextCursor, null);
    assert.deepEqual(blocked.deleted, { vectors: 0, indexRows: 0, jobs: 0 });

    const cursorBlocked = app.pruneEmbeddingArtifacts({
      scope: 'repo',
      scopeKey,
      scanLimit: 1,
      cursor: limitedInventory.nextCursor,
      dryRun: false,
    });
    assert.equal(cursorBlocked.blockedReason, 'embedding_jobs_processing');
    assert.equal(cursorBlocked.nextCursor, limitedInventory.nextCursor);
    assert.equal(cursorBlocked.needsRescan, true);

    const pruned = app.pruneEmbeddingArtifacts({
      completedJobRetentionDays: 1,
      batchSize: 100,
      dryRun: false,
      force: true,
      includeRetired: true,
    });
    assert.equal(pruned.blocked, false);
    assert.ok(pruned.deleted.vectors >= 6);
    assert.ok(pruned.deleted.indexRows >= 5);
    assert.ok(pruned.deleted.jobs >= 2);

    const after = app.embeddingInventory({ completedJobRetentionDays: 1 });
    assert.equal(after.eligible.total, 0);
    assert.equal(after.processingJobs, 1);
    const verifyStore = new ContextForgeStore({ dataDir });
    try {
      const remainingIds = verifyStore.listEmbeddingIndexRecords({ scopeType: 'repo', scopeKey, limit: 100 })
        .map((item) => item.sourceId);
      assert.ok(remainingIds.includes(`memory:${active.id}`));
      assert.ok(remainingIds.includes(`memory_candidate:${pendingCandidate.id}`));
      assert.ok(remainingIds.includes(`memory_candidate:${promotedCandidate.id}`));
      assert.ok(!remainingIds.includes(`memory:${inactive.id}`));
      assert.ok(!remainingIds.includes(`memory_candidate:${rejectedCandidate.id}`));
      assert.ok(!remainingIds.includes(`memory_candidate:${staleCandidate.id}`));
      assert.ok(!remainingIds.includes(`memory_candidate:${snoozedCandidate.id}`));
    } finally {
      verifyStore.close();
    }
  } finally {
    app.close();
  }
});

test('embedding GC requires an extra confirmation for majority retired indexes', async () => {
  const dataDir = await makeTempDir();
  const provider = {
    name: 'test-vector',
    model: 'current-model',
    dimensions: 3,
    async embed(texts) {
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
    embeddingProviders: { openai: provider },
  });
  try {
    app.remember({ scope: 'repo', scopeKey: 'repo-mass-retired', key: 'one', content: 'First vector.' });
    app.remember({ scope: 'repo', scopeKey: 'repo-mass-retired', key: 'two', content: 'Second vector.' });
    await app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-mass-retired' });
    const store = new ContextForgeStore({ dataDir });
    try {
      store.db.prepare('UPDATE embedding_index SET model = ?').run('retired-model');
    } finally {
      store.close();
    }

    const inventory = app.embeddingInventory({ scope: 'repo', scopeKey: 'repo-mass-retired' });
    assert.equal(inventory.retiredRisk.code, 'mass_retired');
    assert.equal(inventory.retiredRisk.retiredRatio, 1);

    const blocked = app.pruneEmbeddingArtifacts({
      scope: 'repo',
      scopeKey: 'repo-mass-retired',
      dryRun: false,
      includeRetired: true,
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.blockedReason, 'mass_retired_confirmation_required');
    assert.equal(blocked.blockedRetry, true);
    assert.equal(blocked.needsRescan, true);
    assert.equal(blocked.nextCursor, null);

    const confirmed = app.pruneEmbeddingArtifacts({
      scope: 'repo',
      scopeKey: 'repo-mass-retired',
      dryRun: false,
      includeRetired: true,
      confirmMassRetired: true,
    });
    assert.equal(confirmed.blocked, false);
    assert.equal(confirmed.deleted.indexRows, 2);
  } finally {
    app.close();
  }
});

test('embedding GC rescans a batch-capped page before advancing its cursor', async () => {
  const dataDir = await makeTempDir();
  const scopeKey = 'repo-batch-capped-gc';
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
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
    embeddingProviders: { openai: provider },
  });
  try {
    for (const key of ['one', 'two', 'three']) {
      app.remember({ scope: 'repo', scopeKey, key, content: `Inactive vector ${key}.` });
    }
    await app.rebuildEmbeddings({ scope: 'repo', scopeKey });
    for (const key of ['one', 'two', 'three']) {
      app.deactivateMemory({ scope: 'repo', scopeKey, key, reason: 'Batch-cap fixture.' });
    }

    const deleted = [];
    let cursor = null;
    let result;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      result = app.pruneEmbeddingArtifacts({
        scope: 'repo',
        scopeKey,
        scanLimit: 10,
        batchSize: 1,
        dryRun: false,
        ...(cursor ? { cursor } : {}),
      });
      deleted.push(result.deleted.indexRows);
      if (result.needsRescan) {
        assert.equal(result.nextCursor, cursor);
        continue;
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    assert.deepEqual(deleted, [1, 1, 1]);
    assert.equal(result.needsRescan, false);
    assert.equal(result.nextCursor, null);
    assert.equal(app.embeddingInventory({ scope: 'repo', scopeKey }).eligible.total, 0);
  } finally {
    app.close();
  }
});

test('vector search still runs alongside Korean lexical tokens', () => {
  const memory = {
    id: 'memory-korean',
    key: 'korean-memory',
    category: 'note',
    content: '한국어 의미 검색은 벡터 경로로 동작해야 한다.',
    tags: [],
    importance: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const results = searchMemories(
    {
      searchMemoryVectorIndex: () => [{ memory, distance: 0, model: 'test-embedding', dimensions: 3 }],
      listMemories: () => [],
    },
    {
      scopeType: 'repo',
      scopeKey: 'repo-korean',
      query: '체크포인트 후보',
      queryEmbedding: [1, 0, 0],
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'korean-memory');
  assert.equal(results[0].retrieval.method, 'vector');
});

test('hybrid ranking keeps strong lexical matches ahead of weak vector-only matches', () => {
  const exactMemory = {
    id: 'memory-exact',
    key: 'sqlite-vec-upsert',
    category: 'decision',
    content: 'Track sqlite-vec upsert behavior.',
    tags: [],
    importance: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const vectorMemory = {
    id: 'memory-vector',
    key: 'unrelated-vector',
    category: 'note',
    content: 'A weak semantic neighbor.',
    tags: [],
    importance: 0,
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  const results = searchMemories(
    {
      searchMemoryIndex: ({ limit }) => {
        assert.equal(limit, 50);
        return [{ memory: exactMemory, ftsRank: -0.001 }];
      },
      searchMemoryVectorIndex: () => [{ memory: vectorMemory, distance: 0.99, model: 'test-embedding', dimensions: 3 }],
      listMemories: () => {
        throw new Error('default indexed retrieval must not scan the full scope');
      },
    },
    {
      scopeType: 'repo',
      scopeKey: 'repo-ranking',
      query: 'sqlite-vec-upsert',
      queryEmbedding: [1, 0, 0],
    },
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].memory.key, 'sqlite-vec-upsert');
  assert.equal(results[0].retrieval.method, 'fts5+lexical');
  assert.equal(results[1].memory.key, 'unrelated-vector');
  assert.equal(results[1].retrieval.method, 'vector');
  assert.deepEqual(results[0].retrieval.diagnostics.sources, {
    fts: 1,
    vectorMemory: 1,
    vectorCheckpoint: 0,
    vectorCandidate: 0,
    legacyLexical: 0,
  });
  assert.equal(results[0].retrieval.diagnostics.scannedRows, 2);
  assert.equal(results[0].retrieval.diagnostics.candidateRows, 2);
});

test('retrieval degrades to bounded FTS candidates when vector search is unavailable', () => {
  const memory = {
    id: 'memory-fts-degraded',
    key: 'degraded-vector-fallback',
    category: 'runbook',
    content: 'Use indexed FTS when the vector index is unavailable.',
    tags: ['retrieval'],
    importance: 3,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const results = searchMemories(
    {
      searchMemoryIndex: ({ limit }) => {
        assert.equal(limit, 50);
        return [{ memory, ftsRank: -0.001 }];
      },
      searchMemoryVectorIndex: () => {
        throw new Error('sqlite-vec is unavailable');
      },
      listMemories: () => {
        throw new Error('degraded indexed retrieval must not fall back to a scope scan');
      },
    },
    {
      scopeType: 'repo',
      scopeKey: 'repo-degraded-vector',
      query: 'indexed FTS',
      queryEmbedding: [1, 0, 0],
    },
  );

  assert.equal(results[0].memory.key, 'degraded-vector-fallback');
  assert.equal(results[0].retrieval.method, 'fts5+lexical');
  assert.equal(results[0].retrieval.diagnostics.sources.fts, 1);
  assert.equal(results[0].retrieval.diagnostics.sources.vectorMemory, 0);
  assert.equal(results[0].retrieval.diagnostics.scannedRows, 1);
  assert.deepEqual(results[0].retrieval.diagnostics.degradedSources, [
    { source: 'vectorMemory', message: 'sqlite-vec is unavailable' },
  ]);
});

test('indexed retrieval bounds candidates and exposes legacy full scan only by explicit opt-in', () => {
  const substringMemory = {
    id: 'memory-substring',
    key: 'prefix-internal-suffix',
    category: 'note',
    content: 'Diagnostic substring fallback.',
    tags: [],
    importance: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const observedLimits = [];
  const store = {
    searchMemoryIndex: ({ limit }) => {
      observedLimits.push(limit);
      return [];
    },
    listMemories: () => [substringMemory],
  };

  const indexed = searchMemories(store, {
    scopeType: 'repo',
    scopeKey: 'repo-bounded',
    query: 'internal',
    limit: 1000,
    candidateLimit: 1000,
  });
  assert.deepEqual(indexed, []);
  assert.equal(indexed.diagnostics.returnedRows, 0);
  assert.equal(indexed.diagnostics.scannedRows, 0);
  assert.deepEqual(observedLimits, [400]);

  const diagnostic = searchMemories(store, {
    scopeType: 'repo',
    scopeKey: 'repo-bounded',
    query: 'internal',
    limit: 1000,
    candidateLimit: 1000,
    legacyFullScan: true,
  });
  assert.equal(diagnostic.length, 1);
  assert.equal(diagnostic[0].memory.key, 'prefix-internal-suffix');
  assert.equal(diagnostic[0].retrieval.method, 'lexical');
  assert.equal(diagnostic[0].retrieval.diagnostics.requestedLimit, 1000);
  assert.equal(diagnostic[0].retrieval.diagnostics.resultLimit, 100);
  assert.equal(diagnostic[0].retrieval.diagnostics.candidateLimit, 400);
  assert.equal(diagnostic[0].retrieval.diagnostics.legacyFullScan, true);
  assert.equal(diagnostic[0].retrieval.diagnostics.sources.legacyLexical, 1);
  assert.equal(diagnostic[0].retrieval.diagnostics.returnedRows, 1);
  assert.ok(diagnostic[0].retrieval.diagnostics.elapsedMs >= 0);
});

test('core search keeps arbitrary substring fallback behind legacyFullScan', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none' },
    cwd: process.cwd(),
  });
  try {
    app.remember({
      scope: 'repo',
      scopeKey: 'repo-substring-diagnostic',
      key: 'prefix-internal-suffix',
      content: 'Arbitrary token substring comparison is diagnostic only.',
    });
    const indexed = app.search({
      scope: 'repo',
      scopeKey: 'repo-substring-diagnostic',
      query: 'nterna',
    });
    assert.deepEqual(indexed, []);

    const zeroHitEnvelope = app.search({
      scope: 'repo',
      scopeKey: 'repo-substring-diagnostic',
      query: 'nterna',
      includeDiagnostics: true,
    });
    assert.equal(zeroHitEnvelope.kind, 'search_results');
    assert.deepEqual(zeroHitEnvelope.results, []);
    assert.equal(zeroHitEnvelope.diagnostics.returnedRows, 0);
    assert.equal(zeroHitEnvelope.diagnostics.sources.fts, 0);
    assert.ok(zeroHitEnvelope.diagnostics.elapsedMs >= 0);

    const legacy = app.search({
      scope: 'repo',
      scopeKey: 'repo-substring-diagnostic',
      query: 'nterna',
      legacyFullScan: true,
      candidateLimit: 5,
    });
    assert.equal(legacy[0].memory.key, 'prefix-internal-suffix');
    assert.equal(legacy[0].retrieval.method, 'lexical');
    assert.equal(legacy[0].retrieval.diagnostics.candidateLimit, 5);
    assert.equal(legacy[0].retrieval.diagnostics.sources.legacyLexical, 1);
  } finally {
    app.close();
  }
});

test('retrieval benchmark reports bounded indexed rows against the legacy scope scan', async () => {
  const benchmark = JSON.parse(
    (
      await execFileAsync('node', ['scripts/benchmark-retrieval.js', '--sizes', '100', '--iterations', '1'])
    ).stdout,
  );
  assert.equal(benchmark.kind, 'contextforge_retrieval_benchmark');
  assert.equal(benchmark.results[0].size, 100);
  assert.equal(benchmark.results[0].modes.ftsPrefix.scannedRows, 1);
  assert.equal(benchmark.results[0].modes.ftsPrefix.firstKey, 'retrievaltarget-100');
  assert.equal(benchmark.results[0].modes.koreanFts.firstKey, 'retrievaltarget-100');
  assert.equal(benchmark.results[0].modes.pathErrorFts.firstKey, 'retrievaltarget-100');
  assert.equal(benchmark.results[0].modes.legacySubstring.scannedRows, 100);
});

test('distillCheckpoint queues embedding jobs and processEmbeddingJobs indexes them', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => {
        const value = String(text).toLowerCase();
        if (value.includes('candidate')) return [0, 1, 0];
        if (value.includes('checkpoint')) return [1, 0, 0];
        return [0, 0, 1];
      });
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
        summaryShort: 'Checkpoint summary.',
        summaryText: 'Checkpoint detail for embedding.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'embedded-candidate',
            content: 'Candidate content for embedding.',
            reason: 'Candidate reason.',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    sessionId: 'distill-vector-session',
    role: 'assistant',
    content: 'Checkpoint should embed immediately after successful distillation.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    sessionId: 'distill-vector-session',
  });

  assert.equal(checkpoint.embedding.reason, 'queued');
  assert.equal(checkpoint.embedding.queued, 2);
  assert.deepEqual(checkpoint.embedding.bySourceType, {
    checkpoint: 1,
    memory_candidate: 1,
  });
  assert.equal(app.dbInfo().tables.embeddings, 0);
  assert.equal(app.dbInfo().embeddings.jobs.pending, 2);

  const processed = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
  });
  assert.equal(processed.embedded, 2);
  assert.deepEqual(processed.bySourceType, {
    checkpoint: 1,
    memory_candidate: 1,
  });
  assert.equal(app.dbInfo().tables.embeddings, 2);
  assert.equal(app.dbInfo().embeddings.jobs.completed, 2);
  assert.equal(app.dbInfo().embeddings.coverage.staleSources, 0);

  const checkpointResults = await app.search({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    query: 'checkpoint search',
  });
  assert.equal(checkpointResults[0].type, 'checkpoint');
  assert.equal(checkpointResults[0].checkpoint.id, checkpoint.id);
  assert.equal(checkpointResults[0].retrieval.method, 'vector');

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    query: 'checkpoint search',
  });
  const bootstrapCheckpoint = bootstrap.results.find((item) => item.type === 'checkpoint');
  assert.equal(bootstrapCheckpoint.trust, 'credible_recent_handoff');
  assert.match(bootstrapCheckpoint.whyUse, /Credible recent handoff state/);

  const candidateResults = await app.search({
    scope: 'repo',
    scopeKey: 'repo-distill-vector',
    query: 'candidate search',
  });
  assert.equal(candidateResults[0].type, 'memory_candidate');
  assert.equal(candidateResults[0].candidate.candidate.key, 'embedded-candidate');
  assert.equal(candidateResults[0].retrieval.vectorModel, 'test-embedding');
});

test('embedding jobs can fail and be retried independently after distill succeeds', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('bad-candidate-vector') ? [0, 1] : [1, 0, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'partial_embedding_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
    distillProviders: {
      partial_embedding_provider: async () => ({
        summaryShort: 'Checkpoint summary.',
        summaryText: 'Checkpoint detail.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'bad-candidate-vector',
            content: 'Candidate content.',
            reason: 'The second vector has the wrong dimension.',
          },
        ],
        sourceEventCount: 1,
        metadata: {},
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
    sessionId: 'partial-embedding-session',
    role: 'assistant',
    content: 'Create a checkpoint and candidate.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
    sessionId: 'partial-embedding-session',
  });

  assert.equal(checkpoint.embedding.reason, 'queued');
  assert.equal(checkpoint.embedding.queued, 2);
  const processed = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
  });
  assert.equal(processed.embedded, 1);
  assert.equal(processed.failed, 1);
  assert.deepEqual(processed.bySourceType, { checkpoint: 1 });
  const failedJobs = app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-partial-embedding',
    status: 'failed',
  });
  assert.equal(failedJobs.length, 1);
  assert.match(failedJobs[0].lastError, /dimensions/);
  assert.equal(app.dbInfo().embeddings.coverage.staleSources, 1);
});

test('search unions lexical candidates with FTS candidates', () => {
  const memory = {
    id: 'memory-1',
    key: 'indexed-memory',
    category: 'decision',
    content: 'Use indexed candidate search.',
    tags: [],
    importance: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const results = searchMemories(
    {
      searchMemoryIndex: () => [{ memory, ftsRank: -0.0001 }],
      listMemories: () => [],
    },
    {
      scopeType: 'repo',
      scopeKey: 'repo-index',
      query: 'indexed',
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].memory.key, 'indexed-memory');
  assert.equal(results[0].retrieval.method, 'fts5+lexical');
});

test('embedding dimension changes require an explicit forced rebuild', async () => {
  const dataDir = await makeTempDir();
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map(() => Array.from({ length: provider.dimensions }, (_, index) => (index === 0 ? 1 : 0)));
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
    scopeKey: 'repo-dimensions',
    key: 'dimension-note',
    content: 'Dimension changes should be explicit.',
  });
  await app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-dimensions' });

  provider.dimensions = 2;
  await assert.rejects(
    () => app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-dimensions' }),
    /Embedding dimensions changed from 3 to 2/,
  );
  const rebuilt = await app.rebuildEmbeddings({ scope: 'repo', scopeKey: 'repo-dimensions', force: true });
  assert.equal(rebuilt.dimensions, 2);
});

test('checkpoint embedding text flattens selected structured handoff fields', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  try {
    const checkpoint = store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-structured-embedding',
      sessionId: 'structured-embedding-session',
      summaryShort: 'Structured embedding checkpoint.',
      summaryText: 'Structured embedding detail.',
      decisions: [],
      todos: [],
      openQuestions: [],
      provider: 'test',
      metadata: {
        structured: {
          schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
          work: {
            intent: 'Index structured checkpoint handoff fields.',
            status: 'verified',
            outcome: 'Embedding text includes selected structured facts.',
          },
          liveState: {
            repo: 'github.com/ginishuh/contextforge',
            branch: 'feature/structured-checkpoints',
            headCommit: 'abc1234',
            prNumber: 119,
            ciStatus: 'pass',
          },
          changes: [
            {
              type: 'storage',
              name: 'candidate_json',
              description: 'Preserve raw memory candidate fields.',
            },
          ],
          verification: [
            {
              command: 'npm test',
              result: 'pass',
              details: 'structured checkpoint tests pass',
            },
          ],
          risks: [
            {
              risk: 'Live state may be stale.',
              mitigation: 'Recheck GitHub before acting.',
            },
          ],
          nextActions: [
            {
              action: 'Open a PR.',
              priority: 'medium',
            },
          ],
        },
      },
    });
    const text = store.embeddingTextForCheckpoint(checkpoint);
    assert.match(text, /feature\/structured-checkpoints/);
    assert.match(text, /PR #119/);
    assert.match(text, /candidate_json/);
    assert.match(text, /npm test pass/);
    assert.doesNotMatch(text, /schemaVersion/);
  } finally {
    store.close();
  }
});

test('OpenAI embeddings omit dimensions for legacy embedding models', async () => {
  let requestBody = null;
  const provider = createOpenAiEmbeddingProvider(
    {
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.test/v1',
      model: 'text-embedding-ada-002',
      dimensions: 1536,
      timeoutMs: 1000,
    },
    {
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0) }] };
          },
        };
      },
    },
  );

  await provider.embed(['legacy model']);

  assert.equal(requestBody.model, 'text-embedding-ada-002');
  assert.equal(Object.hasOwn(requestBody, 'dimensions'), false);
});
