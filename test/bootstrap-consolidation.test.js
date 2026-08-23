import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION } from '../src/distill/validate.js';
import { ContextForgeStore } from '../src/storage/sqlite.js';

test('bootstrapContext includes working summary and recent raw tail separately from search results', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'working_summary_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      working_summary_provider: async () => ({
        summaryShort: 'Working summary checkpoint.',
        summaryText: 'Checkpoint delta: the agent implemented storage scaffolding.',
        workingSummary: 'Current state: storage is done, bootstrap wiring is next.',
        decisions: [],
        todos: ['Wire bootstrapContext to include working summary.'],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-working',
    key: 'durable-rule',
    content: 'Durable memory remains reviewed canonical state.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    role: 'user',
    content: 'Implement working summaries.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    role: 'assistant',
    content: 'Bootstrap wiring is now in progress.',
  });

  const defaultBootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
  });
  assert.deepEqual(defaultBootstrap.rawTail, []);
  assert.equal(defaultBootstrap.rawTailLimit, 0);

  const zeroBootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
    rawTailLimit: 0,
  });
  assert.deepEqual(zeroBootstrap.rawTail, []);
  assert.equal(zeroBootstrap.rawTailLimit, 0);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
    rawTailLimit: 1,
  });

  assert.equal(bootstrap.results.some((item) => item.type === 'memory' && item.key === 'durable-rule'), true);
  assert.equal(bootstrap.workingSummary.type, 'working_summary');
  assert.equal(bootstrap.workingSummary.trust, 'live_continuity');
  assert.match(bootstrap.workingSummary.content, /storage is done/);
  assert.equal(bootstrap.rawTail.length, 1);
  assert.match(bootstrap.rawTail[0].content, /Bootstrap wiring/);
});

test('bootstrapContext includes latest checkpoints independently from search results', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'handoff_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      handoff_provider: async (input) => {
        const latestContent = input.rawEvents.at(-1).content;
        if (latestContent.includes('usage smoke')) {
          return {
            summaryShort: 'Usage smoke checkpoint.',
            summaryText: `Synthetic checkpoint: ${latestContent}`,
            decisions: [],
            todos: [],
            openQuestions: [],
            memoryCandidates: [],
            sourceEventCount: input.rawEvents.length,
            metadata: { synthetic: true },
          };
        }
        return {
          summaryShort: 'Latest handoff.',
          summaryText: `Recent checkpoint: ${latestContent}`,
          decisions: ['Recent decision.'],
          todos: ['Recent todo.'],
          openQuestions: [],
          memoryCandidates: [],
          structured: {
            schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
            work: {
              intent: 'Preserve latest handoff independently from search ranking.',
              status: 'verified',
              outcome: 'Latest checkpoint should appear in handoff.latestHandoff.',
            },
            liveState: {
              repo: 'github.com/example/mcp-repo',
              branch: 'feature/handoff',
              headCommit: 'abc1234',
              ciStatus: 'pass',
              observedAt: '2026-06-03T00:00:00Z',
              verificationRequired: true,
              staleReasons: ['branch, commit, and CI are mutable live state'],
              verifyHints: ['git status --short --branch', 'gh pr view 123 --json statusCheckRollup'],
            },
            changes: [],
            verification: [],
            risks: [],
            nextActions: [],
          },
          sourceEventCount: input.rawEvents.length,
          metadata: { synthetic: true },
        };
      },
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    key: 'durable-bootstrap-hit',
    content: 'Durable bootstrap memory should win ordinary search ranking.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'handoff-session',
    role: 'assistant',
    content: 'PR #123 merged after all CI passed.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'handoff-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'usage-smoke-session',
    role: 'assistant',
    content: 'usage smoke checkpoint should not become the preferred latest handoff.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'usage-smoke-session',
    source: 'manual',
    sourceRef: 'usage-smoke',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    query: 'durable bootstrap memory',
  });

  assert.equal(bootstrap.results.some((item) => item.type === 'memory' && item.key === 'durable-bootstrap-hit'), true);
  assert.equal(bootstrap.handoff.latestCheckpointLimit, 1);
  assert.deepEqual(bootstrap.handoff.relatedScopeKeys, []);
  assert.equal(bootstrap.handoff.latestHandoff.id, bootstrap.handoff.latestCheckpoints[0].id);
  assert.equal(bootstrap.handoff.latestHandoff.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(bootstrap.handoff.latestHandoff.structured.liveState.branch, 'feature/handoff');
  assert.equal(bootstrap.handoff.latestHandoff.source, 'distill');
  assert.notEqual(bootstrap.handoff.latestHandoff.sessionId, 'usage-smoke-session');
  assert.equal(bootstrap.handoff.latestHandoff.structuredWarnings[0].code, 'live_state_may_be_stale');
  assert.ok(bootstrap.handoff.latestHandoff.structuredWarnings[0].fields.includes('liveState.branch'));
  assert.deepEqual(bootstrap.handoff.latestHandoff.structuredWarnings[0].verifyHints, [
    'git status --short --branch',
    'gh pr view 123 --json statusCheckRollup',
  ]);
  assert.equal(bootstrap.handoff.latestCheckpoints.length, 1);
  assert.equal(bootstrap.handoff.latestCheckpoints[0].trust, 'credible_recent_handoff');
  assert.equal(bootstrap.handoff.latestCheckpoints[0].scope.scopeKey, 'repo-handoff');
  assert.match(bootstrap.handoff.latestCheckpoints[0].summaryText, /PR #123 merged/);
  assert.ok(bootstrap.handoff.latestCheckpoints[0].useFor.includes('recent_status'));

  const disabled = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    query: 'durable bootstrap memory',
    latestCheckpointLimit: 0,
  });
  assert.deepEqual(disabled.handoff.latestCheckpoints, []);
  assert.equal(disabled.handoff.latestHandoff, null);
});

test('bootstrapContext falls back to newest checkpoint when no preferred handoff exists', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'plain_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      plain_provider: async (input) => ({
        summaryShort: input.rawEvents.at(-1).content,
        summaryText: `Plain checkpoint: ${input.rawEvents.at(-1).content}`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: input.rawEvents.length,
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-old',
    role: 'assistant',
    content: 'older manual checkpoint',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-old',
    source: 'manual',
    sourceRef: 'older',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-new',
    role: 'assistant',
    content: 'newer manual checkpoint',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-new',
    source: 'manual',
    sourceRef: 'newer',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    query: 'plain checkpoint fallback',
  });

  assert.equal(bootstrap.handoff.latestHandoff.sessionId, 'plain-new');
  assert.equal(bootstrap.handoff.latestHandoff.source, 'manual');
  assert.equal(bootstrap.handoff.latestHandoff.structured, null);
  assert.equal(bootstrap.handoff.latestCheckpoints[0].sessionId, 'plain-new');
});

test('bootstrapContext returns compact memory map and cluster expansion hooks', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    key: 'retrieval.progressive-map',
    content:
      'Progressive retrieval should return a compact memory map with canonical consolidated memory before individual memory fragments.',
    category: 'architecture',
    tags: ['retrieval', 'memory-map', 'cluster'],
    importance: 5,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    key: 'retrieval.cluster-expansion',
    content:
      'Cluster expansion loads related atomic durable memories on demand without pulling every durable memory in the scope.',
    category: 'architecture',
    tags: ['retrieval', 'memory-map', 'cluster'],
    importance: 4,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    key: 'runtime.scheduler-note',
    content: 'Scheduler maintenance windows belong to runtime operations and service restarts.',
    category: 'operations',
    tags: ['scheduler'],
    importance: 3,
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    query: 'progressive retrieval memory map cluster expansion',
    memoryMapLimit: 3,
    memoryMapClusterSize: 4,
  });

  assert.equal(bootstrap.memoryMap.kind, 'memory_map');
  assert.equal(bootstrap.memoryMap.query, 'progressive retrieval memory map cluster expansion');
  assert.equal(bootstrap.memoryMap.embedding.degraded, true);
  assert.ok(bootstrap.memoryMap.embedding.reasons.includes('query_embedding_unavailable'));
  assert.ok(Array.isArray(bootstrap.results));
  assert.ok(bootstrap.results.some((item) => item.type === 'memory'));
  assert.ok(bootstrap.memoryMap.clusters.length >= 1);

  const cluster = bootstrap.memoryMap.clusters[0];
  assert.equal(cluster.retrievalHooks.expand.tool, 'expand_memory_cluster');
  assert.equal(cluster.retrievalHooks.expand.method, 'expandMemoryCluster');
  assert.equal(cluster.consolidatedMemory.key, 'retrieval.progressive-map');
  assert.ok(cluster.consolidatedMemory.coverageCount >= 2);
  assert.ok(cluster.members.some((member) => member.key === 'retrieval.cluster-expansion'));
  assert.ok(!cluster.members.some((member) => member.key === 'runtime.scheduler-note'));
});

test('bootstrapContext uses seed embeddings for memory map cluster membership', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => {
        const value = String(text).toLowerCase();
        if (
          value.includes('authorization') ||
          value.includes('permission gate') ||
          value.includes('bearer credentials')
        ) {
          return [1, 0, 0];
        }
        if (value.includes('billing')) return [0, 1, 0];
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
      openai: embeddingProvider,
    },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    key: 'auth.header-contract',
    content: 'Authorization header is required for protected endpoints.',
    category: 'api',
    tags: ['http'],
    importance: 5,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    key: 'security.gateway-rule',
    content: 'Permission gate validates bearer credentials before handlers run.',
    category: 'security',
    tags: ['gateway'],
    importance: 3,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    key: 'billing.export-rule',
    content: 'Billing export files are produced after monthly closeout.',
    category: 'finance',
    tags: ['billing'],
    importance: 4,
  });
  await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    query: 'authorization protected endpoints',
    limit: 1,
    memoryMapClusterSize: 4,
  });

  assert.equal(bootstrap.memoryMap.embedding.degraded, false);
  assert.equal(bootstrap.memoryMap.embedding.used, true);
  assert.equal(bootstrap.memoryMap.embedding.relationEmbeddingsUsed, true);
  const cluster = bootstrap.memoryMap.clusters[0];
  const vectorMember = cluster.members.find((member) => member.key === 'security.gateway-rule');
  assert.ok(vectorMember);
  assert.ok(vectorMember.vectorScore > 0);
  assert.ok(!cluster.members.some((member) => member.key === 'billing.export-rule'));
});

test('expandMemoryCluster returns atomic durable memories for one map cluster', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    key: 'retrieval.canonical-contract',
    content:
      'Canonical durable memory for progressive retrieval says agents should read the memory map first.',
    category: 'runbook',
    tags: ['retrieval', 'memory-map'],
    importance: 6,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    key: 'retrieval.atomic-detail',
    content:
      'Atomic durable memory detail says expand the selected memory cluster only when implementation details are needed.',
    category: 'runbook',
    tags: ['retrieval', 'memory-map'],
    importance: 4,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    key: 'billing.unrelated',
    content: 'Billing exports use a separate monthly closeout workflow.',
    category: 'finance',
    tags: ['billing'],
    importance: 4,
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    query: 'progressive retrieval memory map canonical atomic detail',
  });
  const clusterId = bootstrap.memoryMap.clusters[0].clusterId;
  const expansion = await app.expandMemoryCluster({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    clusterId,
    limit: 4,
  });

  assert.equal(expansion.kind, 'memory_cluster_expansion');
  assert.equal(expansion.clusterId, clusterId);
  assert.equal(expansion.provenanceIncluded, false);
  assert.equal(expansion.cluster.consolidatedMemory.key, 'retrieval.canonical-contract');
  assert.ok(expansion.memories.some((memory) => memory.key === 'retrieval.atomic-detail'));
  assert.ok(!expansion.memories.some((memory) => memory.key === 'billing.unrelated'));
  assert.equal(expansion.memories.some((memory) => memory.provenance), false);

  const withProvenance = await app.expandMemoryCluster({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    clusterId,
    includeProvenance: true,
    limit: 4,
  });
  assert.equal(withProvenance.clusterId, clusterId);
  assert.equal(withProvenance.provenanceIncluded, true);
  assert.ok(Array.isArray(withProvenance.memories[0].provenance));

  const byQuery = await app.expandMemoryCluster({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    query: 'selected memory cluster atomic detail',
    limit: 4,
  });
  assert.equal(byQuery.memories.some((memory) => memory.key === 'retrieval.canonical-contract'), true);
});

test('bootstrapContext records session-first consult reasons and active-session warnings', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    key: 'targeted-search-rule',
    content: 'Use targeted search for active-session API lookup.',
  });

  const startup = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'startup consult policy',
    consultReason: 'startup',
  });
  assert.equal(startup.consult.reason, 'startup');
  assert.equal(startup.consult.handoffRecommended, true);
  assert.deepEqual(startup.consult.warnings, []);

  const active = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    sessionId: 'active-session',
    query: 'active session consult policy',
    consultReason: 'active_session',
  });
  assert.equal(active.consult.reason, 'active_session');
  assert.equal(active.consult.handoffRecommended, false);
  assert.ok(active.consult.warnings.some((warning) => warning.code === 'active_session_handoff_not_self_check'));
  assert.ok(active.consult.warnings.some((warning) => warning.code === 'same_session_bootstrap_warning'));
  assert.ok(!active.nextActions.some((action) => /routine self-confirmation/.test(action)));

  const targeted = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'targeted API lookup',
    consultReason: 'targeted_search',
  });
  assert.ok(targeted.consult.recommendedTools.includes('search'));
  assert.ok(targeted.consult.warnings.some((warning) => warning.code === 'prefer_search_for_targeted_lookup'));

  const liveState = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'runtime status check',
    consultReason: 'live_state_check',
  });
  assert.ok(liveState.consult.recommendedTools.includes('db_info'));
  assert.ok(liveState.consult.warnings.some((warning) => warning.code === 'prefer_live_sources_for_mutable_state'));

  const compaction = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'compaction recovery',
    consultReason: 'compaction_recovery',
  });
  assert.equal(compaction.consult.handoffRecommended, true);

  const resume = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'resume recovery',
    consultReason: 'resume',
  });
  assert.equal(resume.consult.handoffRecommended, true);

  const agentSwitch = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'agent switch recovery',
    consultReason: 'agent_switch',
  });
  assert.equal(agentSwitch.consult.handoffRecommended, true);

  await assert.rejects(
    () =>
      app.bootstrapContext({
        scope: 'repo',
        scopeKey: 'repo-consult-policy',
        query: 'bad consult reason',
        consultReason: 'just_checking',
      }),
    /consultReason/,
  );
});

test('processConsolidations creates scope-window checkpoints and bootstrap exposes them', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  let providerInput = null;
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('consolidated') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'consolidation_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    store,
    embeddingProviders: {
      openai: embeddingProvider,
    },
    distillProviders: {
      consolidation_provider: async (input) => {
        providerInput = input;
        return {
          summaryShort: 'Daily consolidated context.',
          summaryText: `Daily consolidated context from ${input.sourceCheckpoints.length} source checkpoints.`,
          decisions: ['Use period consolidation for bootstrap context.'],
          todos: ['Verify mutable live state before acting.'],
          openQuestions: [],
          memoryCandidates: [
            {
              key: 'period-consolidation-runbook',
              content: 'Period consolidation should preserve repeated durable runbook signals.',
              reason: 'Repeated across source checkpoints.',
              promotionRecommendation: 'review',
            },
          ],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: { synthetic: true, codexExec: { inputTruncated: true } },
        };
      },
    },
  });

  for (const [sessionId, summaryText] of [
    ['thread-a', 'First checkpoint mentions bootstrap being too thin.'],
    ['thread-a', 'Second checkpoint mentions preserving period context.'],
    ['thread-b', 'Third checkpoint from another session mentions memory candidates.'],
  ]) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-consolidation',
      sessionId,
      summaryShort: 'Source checkpoint.',
      summaryText,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {
        sourceProvenance: {
          sourceAgent: sessionId === 'thread-b' ? 'claude_code' : 'codex',
        },
      },
    });
  }
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    key: 'existing-memory',
    content: 'Existing durable memory for lifecycle summary.',
  });

  const due = app.listDueConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(due.count, 1);
  assert.equal(due.items[0].target, 'repo');
  assert.equal(due.items[0].sourceCheckpointCount, 3);
  assert.equal(due.memoryLifecycle.latestPromotedAt != null, true);

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(result.created, 1);
  assert.equal(result.checkpoint.source, 'daily_consolidation');
  assert.equal(result.checkpoint.metadata.consolidation.target, 'repo');
  assert.equal(result.checkpoint.metadata.consolidation.windowKind, 'daily');
  assert.equal(result.checkpoint.metadata.consolidation.inputTruncated, true);
  assert.equal(result.checkpoint.metadata.consolidation.sourceCheckpointIds.length, 3);
  assert.deepEqual(result.checkpoint.metadata.consolidation.sourceAgents.sort(), ['claude_code', 'codex']);
  assert.equal(result.memoryCandidateCount, 1);
  assert.equal(result.embedding.queued, 2);
  assert.equal(providerInput.consolidation.target, 'repo');
  assert.equal(providerInput.rawEvents.length, 0);
  assert.equal(providerInput.sourceCheckpoints.length, 3);
  assert.throws(
    () =>
      store.insertCheckpoint({
        scopeType: 'repo',
        scopeKey: 'repo-consolidation',
        sessionId: 'duplicate-consolidation',
        summaryShort: 'Duplicate consolidation.',
        summaryText: 'This should be blocked by the consolidation uniqueness index.',
        decisions: [],
        todos: [],
        openQuestions: [],
        sourceEventCount: 1,
        provider: 'test',
        source: 'daily_consolidation',
        sourceRef: result.checkpoint.sourceRef,
        metadata: {
          consolidation: {
            target: 'repo',
          },
        },
      }),
    /UNIQUE constraint failed|constraint/i,
  );
  assert.throws(
    () =>
      app.listDueConsolidations({
        scope: 'repo',
        scopeKey: 'repo-consolidation',
        target: 'repo',
        windowKind: 'rolling',
      }),
    /windowKind must be one of: daily, custom/,
  );

  const duplicate = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(duplicate.created, 0);
  assert.equal(duplicate.skipped, 1);
  assert.equal(duplicate.items[0].reason, 'already_exists');

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    query: 'period consolidation bootstrap',
  });
  assert.equal(bootstrap.handoff.latestConsolidation.repo.id, result.checkpoint.id);
  assert.equal(bootstrap.handoff.latestConsolidation.repo.consolidation.target, 'repo');
  assert.equal(bootstrap.memoryLifecycle.pendingReviewCount, 1);
  assert.equal(bootstrap.memoryLifecycle.candidatesLast7d >= 1, true);
  assert.equal(bootstrap.rawTail, undefined);
});

test('processConsolidations collapses race duplicate insertions into already_exists', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'race_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      race_provider: async (input) => {
        store.insertCheckpoint({
          scopeType: input.session.scopeType,
          scopeKey: input.session.scopeKey,
          sessionId: 'competing-worker',
          summaryShort: 'Competing consolidation.',
          summaryText: 'A competing worker inserted this consolidation first.',
          decisions: [],
          todos: [],
          openQuestions: [],
          sourceEventCount: input.sourceCheckpoints.length,
          provider: 'race_provider',
          level: 1,
          coversFrom: input.consolidation.coversFrom,
          coversTo: input.consolidation.coversTo,
          source: 'daily_consolidation',
          sourceRef: input.consolidation.sourceRef,
          metadata: {
            consolidation: {
              target: input.consolidation.target,
            },
          },
        });
        return {
          summaryShort: 'Losing consolidation.',
          summaryText: 'This output should be collapsed to the existing checkpoint.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: {},
        };
      },
    },
  });

  for (const summaryText of ['First source checkpoint.', 'Second source checkpoint.']) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-consolidation-race',
      sessionId: 'thread-race',
      summaryShort: 'Source checkpoint.',
      summaryText,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {},
    });
  }

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation-race',
    target: 'repo',
    day: new Date().toISOString(),
  });

  assert.equal(result.processed, 1);
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.items[0].reason, 'already_exists');
  assert.equal(result.checkpoint.summaryShort, 'Competing consolidation.');
});

test('processConsolidations supports thread windows without mixing sessions', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  let sourceSessionIds = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'thread_consolidation_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      thread_consolidation_provider: async (input) => {
        sourceSessionIds = input.sourceCheckpoints.map((checkpoint) => checkpoint.sessionId);
        return {
          summaryShort: 'Thread consolidated context.',
          summaryText: 'Thread consolidated context from one session.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: {},
        };
      },
    },
  });

  for (const sessionId of ['target-thread', 'target-thread', 'other-thread']) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-thread-consolidation',
      sessionId,
      summaryShort: 'Thread source checkpoint.',
      summaryText: `Checkpoint for ${sessionId}.`,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {},
    });
  }

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-thread-consolidation',
    target: 'thread',
    sessionId: 'target-thread',
    day: new Date().toISOString(),
  });

  assert.equal(result.created, 1);
  assert.deepEqual(sourceSessionIds, ['target-thread', 'target-thread']);
  assert.deepEqual(result.checkpoint.metadata.consolidation.sourceSessionIds, ['target-thread']);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-thread-consolidation',
    sessionId: 'target-thread',
    query: 'thread consolidated context',
  });
  assert.equal(bootstrap.handoff.latestConsolidation.thread.id, result.checkpoint.id);
});

test('bootstrapContext can include latest checkpoints from related repo scopes', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'related_handoff_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      related_handoff_provider: async (input) => ({
        summaryShort: 'Latest related handoff.',
        summaryText: `Recent related checkpoint: ${input.rawEvents.at(-1).content}`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: input.rawEvents.length,
        metadata: {},
      }),
    },
  });

  for (const scopeKey of ['repo-child', 'repo-suite']) {
    app.appendRaw({
      scope: 'repo',
      scopeKey,
      sessionId: `${scopeKey}-session`,
      role: 'assistant',
      content: `Checkpoint evidence for ${scopeKey}.`,
    });
    await app.distillCheckpoint({
      scope: 'repo',
      scopeKey,
      sessionId: `${scopeKey}-session`,
    });
  }

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-child',
    relatedScopeKeys: ['repo-suite', 'repo-suite', 'repo-child'],
    query: 'unrelated query still needs latest handoff',
  });

  assert.deepEqual(
    bootstrap.handoff.latestCheckpoints.map((checkpoint) => checkpoint.scope.scopeKey).sort(),
    ['repo-child', 'repo-suite'],
  );
  assert.deepEqual(bootstrap.handoff.relatedScopeKeys, ['repo-suite']);

  await assert.rejects(
    () =>
      app.bootstrapContext({
        scope: 'repo',
        scopeKey: 'repo-child',
        query: 'invalid handoff limit',
        latestCheckpointLimit: 4,
      }),
    /latestCheckpointLimit must be an integer between 0 and 3/,
  );
});
