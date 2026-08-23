import { contentHash, normalizeToken, summarySnippet } from '../common.js';
import { tokenOverlapScore } from './candidate_text.js';

// Pure helpers behind the memory-map surface: relation scoring, cluster
// assembly, and the map payload itself. Nothing here captures a closure from
// core.js, so it is a plain module rather than a factory.
//
// memoryClusterId hashes with contentHash from common.js on purpose - cluster
// ids are handed back to callers and fed to expandMemoryCluster, so the hash
// must stay the exact one common.js defines, `|| ''` coercion included.

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function memoryClusterId(scope, memory) {
  return `cluster:${contentHash(`${scope.scopeType}:${scope.scopeKey}:${memory.key || memory.id}`).slice(0, 12)}`;
}

export function memoryClusterText(memory) {
  return [
    memory.key,
    memory.category,
    ...(Array.isArray(memory.tags) ? memory.tags : []),
    memory.content,
  ]
    .filter(Boolean)
    .join('\n');
}

function memoryCompact(memory, maxChars = 260) {
  return {
    memoryId: memory.id,
    key: memory.key,
    category: memory.category,
    content: summarySnippet(memory.content, maxChars),
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    importance: memory.importance,
    updatedAt: memory.updatedAt,
  };
}

function memoryTagOverlap(left, right) {
  const leftTags = new Set((left.tags || []).map((tag) => normalizeToken(tag)).filter(Boolean));
  const rightTags = new Set((right.tags || []).map((tag) => normalizeToken(tag)).filter(Boolean));
  if (!leftTags.size || !rightTags.size) return 0;
  let shared = 0;
  for (const tag of leftTags) {
    if (rightTags.has(tag)) shared += 1;
  }
  return shared / Math.max(leftTags.size, rightTags.size);
}

function memoryKeyAffinity(left, right) {
  const leftParts = String(left.key || '').split(/[._:/-]+/).filter(Boolean);
  const rightParts = String(right.key || '').split(/[._:/-]+/).filter(Boolean);
  if (!leftParts.length || !rightParts.length) return 0;
  if (left.key === right.key) return 1;
  if (leftParts[0] && leftParts[0] === rightParts[0]) return 0.3;
  return 0;
}

function memoryRelationScore(seed, memory, hitScore = 0, vectorScore = 0) {
  if (seed.id === memory.id) return 1 + hitScore + vectorScore;
  const overlap = tokenOverlapScore(memoryClusterText(seed), memoryClusterText(memory));
  const category = seed.category && seed.category === memory.category ? 0.16 : 0;
  const tags = memoryTagOverlap(seed, memory) * 0.22;
  const key = memoryKeyAffinity(seed, memory) * 0.18;
  const vector = Math.min(0.34, vectorScore * 0.34);
  return overlap + category + tags + key + Math.min(0.16, hitScore / 10000) + vector;
}

export function vectorRelationScore(distance) {
  const parsed = Number(distance);
  if (!Number.isFinite(parsed)) return 0;
  return 1 / (1 + Math.max(0, parsed));
}

export function memoryMapEmbeddingState(storage, { queryEmbedding = null, relationEmbeddingsUsed = false } = {}) {
  const vectorUsable = Boolean(storage.vectorReady && (queryEmbedding || relationEmbeddingsUsed));
  const degraded = !vectorUsable || storage.vectorState !== 'ready';
  const reasons = [];
  if (!queryEmbedding && !relationEmbeddingsUsed) reasons.push('query_embedding_unavailable');
  if (!relationEmbeddingsUsed) reasons.push('relation_embeddings_unavailable');
  if (!storage.vectorReady) reasons.push('vector_index_not_ready');
  if (storage.vectorStaleSources > 0) reasons.push('embedding_sources_stale');
  if (storage.vectorPendingJobs > 0) reasons.push('embedding_jobs_pending');
  if (storage.vectorFailedJobs > 0) reasons.push('embedding_jobs_failed');
  return {
    provider: storage.embeddingProvider,
    vectorReady: storage.vectorReady,
    vectorState: storage.vectorState,
    used: vectorUsable,
    relationEmbeddingsUsed,
    degraded,
    reasons,
    staleSources: storage.vectorStaleSources,
    pendingJobs: storage.vectorPendingJobs,
    failedJobs: storage.vectorFailedJobs,
  };
}

export function buildMemoryCluster({
  scope,
  seed,
  allMemories,
  hitScores,
  vectorRelations = new Map(),
  limit,
  embedding,
  canonicalMemory = null,
}) {
  const seedVectorRelations = vectorRelations.get(seed.id) || new Map();
  const scored = allMemories
    .map((memory) => {
      const vectorRelation = seedVectorRelations.get(memory.id) || null;
      return {
        memory,
        relationScore: memoryRelationScore(
          seed,
          memory,
          hitScores.get(memory.id) || 0,
          vectorRelation?.score || 0,
        ),
        vectorRelation,
      };
    })
    .filter((item) => seed.id === item.memory.id || item.relationScore >= 0.18)
    .sort(
      (a, b) =>
        b.relationScore - a.relationScore ||
        (Number(b.memory.importance) || 0) - (Number(a.memory.importance) || 0) ||
        String(b.memory.updatedAt || '').localeCompare(String(a.memory.updatedAt || '')),
    )
    .slice(0, limit);
  const canonical =
    canonicalMemory ||
    scored
      .map((item) => item.memory)
      .sort(
        (a, b) =>
          (Number(b.importance) || 0) - (Number(a.importance) || 0) ||
          (hitScores.get(b.id) || 0) - (hitScores.get(a.id) || 0) ||
          String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      )[0] ||
    seed;
  const confidenceBase = embedding.degraded ? 0.56 : 0.76;
  const confidence = clampNumber(confidenceBase + Math.min(0.18, scored.length * 0.03), 0.3, 0.95);
  return {
    clusterId: memoryClusterId(scope, canonical),
    scope: {
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
    },
    canonicalKey: canonical.key,
    category: canonical.category,
    confidence: Number(confidence.toFixed(2)),
    degraded: embedding.degraded,
    degradedReasons: embedding.reasons,
    consolidatedMemory: {
      ...memoryCompact(canonical, 420),
      coverageCount: scored.length,
      relatedKeys: scored.map((item) => item.memory.key).filter((key) => key !== canonical.key),
    },
    members: scored.map((item) => ({
      ...memoryCompact(item.memory, 220),
      relationScore: Number(item.relationScore.toFixed(3)),
      vectorDistance: item.vectorRelation?.distance ?? null,
      vectorScore: item.vectorRelation ? Number(item.vectorRelation.score.toFixed(3)) : null,
      canonical: item.memory.id === canonical.id,
    })),
    retrievalHooks: {
      expand: {
        tool: 'expand_memory_cluster',
        method: 'expandMemoryCluster',
        clusterId: memoryClusterId(scope, canonical),
      },
      searches: [
        canonical.key,
        canonical.category,
        ...(Array.isArray(canonical.tags) ? canonical.tags : []),
      ].filter(Boolean).slice(0, 6),
    },
  };
}

export function buildMemoryMap(
  store,
  scope,
  { query, searchResults = [], storage, queryEmbedding, vectorRelations = new Map(), limit = 5, clusterSize = 6 },
) {
  const embedding = memoryMapEmbeddingState(storage, {
    queryEmbedding,
    relationEmbeddingsUsed: vectorRelations.size > 0,
  });
  const allMemories = store.listMemories(scope);
  const memoryResults = searchResults.filter((result) => result.type === 'memory' && result.memory);
  const hitScores = new Map(memoryResults.map((result) => [result.memory.id, Number(result.score) || 0]));
  const seeds = memoryResults.map((result) => result.memory);
  const clusters = [];
  const coveredIds = new Set();
  for (const seed of seeds) {
    if (coveredIds.has(seed.id)) continue;
    const cluster = buildMemoryCluster({
      scope,
      seed,
      allMemories,
      hitScores,
      vectorRelations,
      limit: clusterSize,
      embedding,
    });
    const overlap = cluster.members.some((member) => coveredIds.has(member.memoryId));
    if (overlap && cluster.members.length > 1) {
      continue;
    }
    clusters.push(cluster);
    for (const member of cluster.members) coveredIds.add(member.memoryId);
    if (clusters.length >= limit) break;
  }
  return {
    kind: 'memory_map',
    scope: {
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
    },
    query,
    policy: {
      navigation: 'map_first_expand_on_demand',
      detail: 'Use consolidatedMemory for orientation, expand a cluster only when atomic details are needed.',
      provenance: 'Fetch provenance only when needed.',
    },
    embedding,
    limits: {
      clusters: limit,
      clusterSize,
      maxLimit: 20,
      activeMemoryCount: allMemories.length,
      seedCount: seeds.length,
    },
    clusters,
    summary:
      clusters.length === 0
        ? 'No durable-memory clusters found for this query.'
        : `Found ${clusters.length} durable-memory cluster(s); expand a cluster on demand for atomic memories.`,
  };
}

export function fullClusterMemory(memory) {
  return {
    memoryId: memory.id,
    key: memory.key,
    category: memory.category,
    content: memory.content,
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    importance: memory.importance,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function mergeWarnings(warnings, extraWarnings) {
  const merged = [];
  const seen = new Set();
  for (const warning of [...warnings, ...extraWarnings].filter(Boolean)) {
    const key = `${warning.code}:${warning.memoryId || ''}:${warning.memoryKey || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(warning);
  }
  return merged;
}
