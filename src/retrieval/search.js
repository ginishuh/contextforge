function normalizeLexicalText(text) {
  return String(text || '').normalize('NFKC').toLowerCase();
}

function tokenize(text) {
  return normalizeLexicalText(text)
    .split(/[^\p{L}\p{N}\p{M}_./:-]+/u)
    .filter((token) => token.length > 1 || /[^\x00-\x7f]/u.test(token));
}

function unique(values) {
  return [...new Set(values)];
}

function toFtsQuery(tokens) {
  return tokens
    .map((token) => token.replace(/[^\p{L}\p{N}\p{M}_]+/gu, ' '))
    .flatMap((token) => token.split(/\s+/).filter(Boolean))
    .map((token) => `"${token}"*`)
    .join(' OR ');
}

function ftsScore(rank) {
  if (rank == null) return 0;
  const score = Math.max(0, Math.round(Math.abs(Number(rank)) * 1000000));
  return Math.min(1000, score);
}

function vectorScore(distance) {
  const parsed = Number(distance);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(1000 / (1 + Math.max(0, parsed)));
}

function scoreMemory(memory, queryTokens) {
  const fields = {
    key: memory.key,
    category: memory.category,
    content: memory.content,
    tags: memory.tags.join(' '),
  };

  let score = 0;
  const matched = [];
  for (const token of queryTokens) {
    const hitFields = [];
    for (const [name, value] of Object.entries(fields)) {
      const fieldTokens = tokenize(value);
      const lowerValue = normalizeLexicalText(value);
      const matchType = fieldTokens.some((fieldToken) => fieldToken === token)
        ? 'exact'
        : fieldTokens.some((fieldToken) => fieldToken.startsWith(token))
          ? 'prefix'
          : lowerValue.includes(token)
            ? 'substring'
            : null;
      if (matchType) {
        hitFields.push({ name, matchType });
      }
    }
    if (hitFields.length > 0) {
      const fieldScore = hitFields.reduce((sum, field) => {
        const fieldWeight = field.name === 'key' ? 4 : field.name === 'content' ? 2 : 1;
        const matchWeight = field.matchType === 'exact' ? 3 : field.matchType === 'prefix' ? 2 : 1;
        return sum + fieldWeight * matchWeight;
      }, 0);
      score += fieldScore;
      matched.push({
        token,
        fields: hitFields.map((field) => field.name),
        matchTypes: [...new Set(hitFields.map((field) => field.matchType))],
      });
    }
  }

  return {
    score,
    matched,
  };
}

function normalizeSearchScopes({ scopeType, scopeKey, searchScopes, sharedScopeKey }) {
  const mode = searchScopes || 'scope';
  if (mode === 'scope') {
    return [{ scopeType, scopeKey, role: scopeType }];
  }
  if (mode === 'repo') {
    return [{ scopeType: 'repo', scopeKey, role: 'repo' }];
  }
  if (mode === 'shared') {
    return [{ scopeType: 'shared', scopeKey: sharedScopeKey || scopeKey, role: 'shared' }];
  }
  if (mode === 'repo+shared') {
    return [
      { scopeType: 'repo', scopeKey, role: 'repo' },
      { scopeType: 'shared', scopeKey: sharedScopeKey, role: 'shared' },
    ];
  }
  if (mode === 'local') {
    return [{ scopeType: 'local', scopeKey, role: 'local' }];
  }

  throw new Error('searchScopes must be one of: scope, repo, shared, repo+shared, local.');
}

function scopeBoost(source) {
  // Scope boost is intentionally a tie-breaker after lexical/FTS relevance.
  if (source.role === 'repo') return 1000;
  if (source.role === 'shared') return 100;
  return 0;
}

function resultImportance(result) {
  if (result.memory) return result.memory.importance;
  if (result.candidate) return result.candidate.candidate.importance || 0;
  return 0;
}

function resultTimestamp(result) {
  return result.memory?.updatedAt || result.checkpoint?.createdAt || result.candidate?.createdAt || '';
}

function vectorRetrieval(match) {
  return {
    method: 'vector',
    ftsRank: null,
    vectorDistance: match.distance,
    vectorModel: match.model,
    vectorDimensions: match.dimensions,
  };
}

export const RETRIEVAL_LIMITS = Object.freeze({
  defaultResultLimit: 10,
  maxResultLimit: 100,
  minCandidateLimit: 50,
  defaultCandidateLimit: 200,
  maxCandidateLimit: 500,
});

function boundedPositiveInteger(value, fallback, max) {
  const parsed = Number(value == null ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('retrieval limits must be positive integers.');
  }
  return Math.min(parsed, max);
}

function elapsedMilliseconds(startedAt) {
  return Number((process.hrtime.bigint() - startedAt) / 1000n) / 1000;
}

function safeVectorSearch(source, search, diagnostics) {
  try {
    return search();
  } catch (error) {
    diagnostics.degradedSources.push({ source, message: String(error?.message || error) });
    return [];
  }
}

function finalizeResults(results, diagnostics, startedAt) {
  diagnostics.elapsedMs = Number(elapsedMilliseconds(startedAt).toFixed(3));
  diagnostics.returnedRows = results.length;
  for (const result of results) {
    result.retrieval.diagnostics = diagnostics;
  }
  Object.defineProperty(results, 'diagnostics', { value: diagnostics, enumerable: false });
  return results;
}

export function searchMemories(
  store,
  {
    scopeType,
    scopeKey,
    query,
    limit = RETRIEVAL_LIMITS.defaultResultLimit,
    candidateLimit = RETRIEVAL_LIMITS.defaultCandidateLimit,
    legacyFullScan = false,
    searchScopes,
    sharedScopeKey,
    queryEmbedding,
  },
) {
  const startedAt = process.hrtime.bigint();
  const queryTokens = unique(tokenize(query));
  const requestedLimit = Number(limit);
  const resultLimit = boundedPositiveInteger(
    limit,
    RETRIEVAL_LIMITS.defaultResultLimit,
    RETRIEVAL_LIMITS.maxResultLimit,
  );
  const maxCandidateRows = boundedPositiveInteger(
    candidateLimit,
    RETRIEVAL_LIMITS.defaultCandidateLimit,
    RETRIEVAL_LIMITS.maxCandidateLimit,
  );
  const candidateWindow = Math.min(Math.max(resultLimit * 4, RETRIEVAL_LIMITS.minCandidateLimit), maxCandidateRows);
  const scopes = normalizeSearchScopes({ scopeType, scopeKey, searchScopes, sharedScopeKey });
  const ftsQuery = toFtsQuery(queryTokens);
  const diagnostics = {
    elapsedMs: 0,
    requestedLimit,
    resultLimit,
    candidateLimit: candidateWindow,
    scopeCount: scopes.length,
    scannedRows: 0,
    candidateRows: 0,
    returnedRows: 0,
    legacyFullScan: Boolean(legacyFullScan),
    degradedSources: [],
    sources: {
      fts: 0,
      vectorMemory: 0,
      vectorCheckpoint: 0,
      vectorCandidate: 0,
      legacyLexical: 0,
    },
  };
  const allResults = [];
  if (queryTokens.length === 0 && !queryEmbedding) {
    return finalizeResults([], diagnostics, startedAt);
  }

  for (const source of scopes) {
    const ftsMatches = store.searchMemoryIndex && ftsQuery
      ? store.searchMemoryIndex({
          scopeType: source.scopeType,
          scopeKey: source.scopeKey,
          ftsQuery,
          limit: candidateWindow,
        })
      : [];
    const vectorMatches = store.searchMemoryVectorIndex && queryEmbedding
      ? safeVectorSearch(
          'vectorMemory',
          () =>
            store.searchMemoryVectorIndex({
              scopeType: source.scopeType,
              scopeKey: source.scopeKey,
              embedding: queryEmbedding,
              limit: candidateWindow,
            }),
          diagnostics,
        )
      : [];
    const checkpointVectorMatches = store.searchCheckpointVectorIndex && queryEmbedding
      ? safeVectorSearch(
          'vectorCheckpoint',
          () =>
            store.searchCheckpointVectorIndex({
              scopeType: source.scopeType,
              scopeKey: source.scopeKey,
              embedding: queryEmbedding,
              limit: candidateWindow,
            }),
          diagnostics,
        )
      : [];
    const candidateVectorMatches = store.searchMemoryCandidateVectorIndex && queryEmbedding
      ? safeVectorSearch(
          'vectorCandidate',
          () =>
            store.searchMemoryCandidateVectorIndex({
              scopeType: source.scopeType,
              scopeKey: source.scopeKey,
              embedding: queryEmbedding,
              limit: candidateWindow,
            }),
          diagnostics,
        )
      : [];
    const lexicalCandidates =
      legacyFullScan && queryTokens.length > 0 && store.listMemories ? store.listMemories(source) : [];

    diagnostics.sources.fts += ftsMatches.length;
    diagnostics.sources.vectorMemory += vectorMatches.length;
    diagnostics.sources.vectorCheckpoint += checkpointVectorMatches.length;
    diagnostics.sources.vectorCandidate += candidateVectorMatches.length;
    diagnostics.sources.legacyLexical += lexicalCandidates.length;
    diagnostics.scannedRows +=
      ftsMatches.length +
      vectorMatches.length +
      checkpointVectorMatches.length +
      candidateVectorMatches.length +
      lexicalCandidates.length;

    const ftsById = new Map(ftsMatches.map((match) => [match.memory.id, match]));
    const vectorById = new Map(vectorMatches.map((match) => [match.memory.id, match]));
    const ftsIds = new Set(ftsById.keys());
    const vectorIds = new Set(vectorById.keys());
    const candidateMemories = [
      ...ftsMatches.map((match) => match.memory),
      ...vectorMatches.map((match) => match.memory),
      ...lexicalCandidates,
    ];
    const memoriesById = new Map(candidateMemories.map((memory) => [memory.id, memory]));

    const memoryResults = [...memoriesById.values()].map((memory) => {
      const match = scoreMemory(memory, queryTokens);
      const ftsMatch = ftsById.get(memory.id);
      const vectorMatch = vectorById.get(memory.id);
      const score = match.score * 100 + ftsScore(ftsMatch?.ftsRank) + vectorScore(vectorMatch?.distance);
      return {
        type: 'memory',
        score,
        why: match.matched,
        retrieval: {
          method:
            ftsIds.has(memory.id) && vectorIds.has(memory.id)
              ? 'hybrid:fts5+vector+lexical'
              : ftsIds.has(memory.id)
                ? 'fts5+lexical'
                : vectorIds.has(memory.id)
                  ? 'vector'
                  : 'lexical',
          ftsRank: ftsMatch?.ftsRank ?? null,
          vectorDistance: vectorMatch?.distance ?? null,
          vectorModel: vectorMatch?.model ?? null,
          vectorDimensions: vectorMatch?.dimensions ?? null,
        },
        source: {
          scopeType: source.scopeType,
          scopeKey: source.scopeKey,
          role: source.role,
        },
        memory,
      };
    });
    const checkpointResults = checkpointVectorMatches.map((match) => ({
      type: 'checkpoint',
      score: vectorScore(match.distance),
      why: [],
      retrieval: vectorRetrieval(match),
      source: {
        scopeType: source.scopeType,
        scopeKey: source.scopeKey,
        role: source.role,
      },
      checkpoint: match.checkpoint,
    }));
    const candidateResults = candidateVectorMatches.map((match) => ({
      type: 'memory_candidate',
      score: vectorScore(match.distance),
      why: [],
      retrieval: vectorRetrieval(match),
      source: {
        scopeType: source.scopeType,
        scopeKey: source.scopeKey,
        role: source.role,
      },
      candidate: match.candidate,
    }));

    diagnostics.candidateRows += memoriesById.size + checkpointResults.length + candidateResults.length;
    allResults.push(...memoryResults, ...checkpointResults, ...candidateResults);
  }

  const results = allResults
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        scopeBoost(b.source) - scopeBoost(a.source) ||
        resultImportance(b) - resultImportance(a) ||
        resultTimestamp(b).localeCompare(resultTimestamp(a)),
    )
    .slice(0, resultLimit);
  return finalizeResults(results, diagnostics, startedAt);
}
