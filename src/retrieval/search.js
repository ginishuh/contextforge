function tokenize(text) {
  const parts = String(text || '')
    .toLowerCase()
    .match(/[a-z0-9_./:-]+|[\p{Script=Hangul}]+/gu);
  if (!parts) return [];

  return parts.flatMap((part) => {
    if (!/\p{Script=Hangul}/u.test(part)) {
      return part.split(/[^a-z0-9_./:-]+/).filter((token) => token.length > 1);
    }
    if (part.length <= 2) {
      return [part];
    }
    const grams = [part];
    for (let index = 0; index <= part.length - 2; index += 1) {
      grams.push(part.slice(index, index + 2));
    }
    for (let index = 0; index <= part.length - 3; index += 1) {
      grams.push(part.slice(index, index + 3));
    }
    return grams;
  });
}

function unique(values) {
  return [...new Set(values)];
}

function toFtsQuery(tokens) {
  return tokens
    .map((token) => token.replace(/"/g, '').replace(/[^a-z0-9_]+/g, ' '))
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

function scoreFields(fields, queryTokens) {
  let score = 0;
  const matched = [];
  for (const token of queryTokens) {
    const hitFields = [];
    for (const [name, value] of Object.entries(fields)) {
      const fieldTokens = tokenize(value);
      const lowerValue = String(value || '').toLowerCase();
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

function scoreMemory(memory, queryTokens) {
  return scoreFields(
    {
      key: memory.key,
      category: memory.category,
      content: memory.content,
      tags: memory.tags.join(' '),
    },
    queryTokens,
  );
}

function scoreCheckpoint(checkpoint, queryTokens) {
  return scoreFields(
    {
      summary: checkpoint.summaryShort,
      content: checkpoint.summaryText,
      decisions: (checkpoint.decisions || []).join(' '),
      todos: (checkpoint.todos || []).join(' '),
      openQuestions: (checkpoint.openQuestions || []).join(' '),
      hooks: Array.isArray(checkpoint.metadata?.providerMetadata?.retrievalHooks)
        ? checkpoint.metadata.providerMetadata.retrievalHooks.join(' ')
        : '',
    },
    queryTokens,
  );
}

function scoreCandidate(candidate, queryTokens) {
  return scoreFields(
    {
      key: candidate.candidate.key,
      category: candidate.candidate.category,
      content: candidate.candidate.content,
      reason: candidate.candidate.reason,
      tags: (candidate.candidate.tags || []).join(' '),
    },
    queryTokens,
  );
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

function lexicalVectorRetrieval({ lexical, vectorMatch }) {
  return {
    method: lexical && vectorMatch ? 'hybrid:vector+lexical' : vectorMatch ? 'vector' : 'lexical',
    ftsRank: null,
    vectorDistance: vectorMatch?.distance ?? null,
    vectorModel: vectorMatch?.model ?? null,
    vectorDimensions: vectorMatch?.dimensions ?? null,
  };
}

export function searchMemories(store, { scopeType, scopeKey, query, limit = 10, searchScopes, sharedScopeKey, queryEmbedding }) {
  const queryTokens = unique(tokenize(query));
  if (queryTokens.length === 0 && !queryEmbedding) {
    return [];
  }

  const scopes = normalizeSearchScopes({ scopeType, scopeKey, searchScopes, sharedScopeKey });
  const ftsQuery = toFtsQuery(queryTokens);

  return scopes
    .flatMap((source) => {
      const ftsMatches = store.searchMemoryIndex && ftsQuery
        ? store.searchMemoryIndex({
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            ftsQuery,
            limit: Math.max(limit * 4, 50),
          })
        : [];
      const vectorMatches = store.searchMemoryVectorIndex && queryEmbedding
        ? store.searchMemoryVectorIndex({
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            embedding: queryEmbedding,
            limit: Math.max(limit * 4, 50),
          })
        : [];
      const checkpointVectorMatches = store.searchCheckpointVectorIndex && queryEmbedding
        ? store.searchCheckpointVectorIndex({
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            embedding: queryEmbedding,
            limit: Math.max(limit * 4, 50),
          })
        : [];
      const candidateVectorMatches = store.searchMemoryCandidateVectorIndex && queryEmbedding
        ? store.searchMemoryCandidateVectorIndex({
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            embedding: queryEmbedding,
            limit: Math.max(limit * 4, 50),
          })
        : [];
      const ftsById = new Map(ftsMatches.map((match) => [match.memory.id, match]));
      const vectorById = new Map(vectorMatches.map((match) => [match.memory.id, match]));
      const checkpointVectorById = new Map(checkpointVectorMatches.map((match) => [match.checkpoint.id, match]));
      const candidateVectorById = new Map(candidateVectorMatches.map((match) => [match.candidate.id, match]));
      const ftsIds = new Set(ftsById.keys());
      const vectorIds = new Set(vectorById.keys());
      const lexicalCandidates =
        queryTokens.length > 0 && store.listMemories
          ? store.listMemories(source)
          : [];
      const lexicalCheckpoints =
        queryTokens.length > 0 && store.listCheckpoints
          ? store.listCheckpoints({
              scopeType: source.scopeType,
              scopeKey: source.scopeKey,
            })
          : [];
      const lexicalMemoryCandidates =
        queryTokens.length > 0 && store.listMemoryCandidates
          ? store.listMemoryCandidates({
              scopeType: source.scopeType,
              scopeKey: source.scopeKey,
            })
          : [];
      const candidateMemories = [
        ...ftsMatches.map((match) => match.memory),
        ...vectorMatches.map((match) => match.memory),
        ...lexicalCandidates,
      ];
      const memoriesById = new Map(candidateMemories.map((memory) => [memory.id, memory]));
      const checkpointsById = new Map([
        ...checkpointVectorMatches.map((match) => [match.checkpoint.id, match.checkpoint]),
        ...lexicalCheckpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
      ]);
      const candidatesById = new Map([
        ...candidateVectorMatches.map((match) => [match.candidate.id, match.candidate]),
        ...lexicalMemoryCandidates.map((candidate) => [candidate.id, candidate]),
      ]);

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
      const checkpointResults = [...checkpointsById.values()].map((checkpoint) => {
        const match = scoreCheckpoint(checkpoint, queryTokens);
        const vectorMatch = checkpointVectorById.get(checkpoint.id);
        return {
          type: 'checkpoint',
          score: match.score * 100 + vectorScore(vectorMatch?.distance),
          why: match.matched,
          retrieval: lexicalVectorRetrieval({ lexical: match.score > 0, vectorMatch }),
          source: {
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            role: source.role,
          },
          checkpoint,
        };
      });
      const candidateResults = [...candidatesById.values()].map((candidate) => {
        const match = scoreCandidate(candidate, queryTokens);
        const vectorMatch = candidateVectorById.get(candidate.id);
        return {
          type: 'memory_candidate',
          score: match.score * 100 + vectorScore(vectorMatch?.distance),
          why: match.matched,
          retrieval: lexicalVectorRetrieval({ lexical: match.score > 0, vectorMatch }),
          source: {
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            role: source.role,
          },
          candidate,
        };
      });

      return [...memoryResults, ...checkpointResults, ...candidateResults];
    })
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        scopeBoost(b.source) - scopeBoost(a.source) ||
        resultImportance(b) - resultImportance(a) ||
        resultTimestamp(b).localeCompare(resultTimestamp(a)),
    )
    .slice(0, limit);
}
