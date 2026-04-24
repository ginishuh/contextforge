function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .filter((token) => token.length > 1);
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
  return Math.max(0, Math.round(Math.abs(Number(rank)) * 1000000));
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
  if (source.role === 'repo') return 1000;
  if (source.role === 'shared') return 100;
  return 0;
}

export function searchMemories(store, { scopeType, scopeKey, query, limit = 10, searchScopes, sharedScopeKey }) {
  const queryTokens = unique(tokenize(query));
  if (queryTokens.length === 0) {
    return [];
  }

  const scopes = normalizeSearchScopes({ scopeType, scopeKey, searchScopes, sharedScopeKey });
  const ftsQuery = toFtsQuery(queryTokens);

  return scopes
    .flatMap((source) => {
      const ftsMatches = store.searchMemoryIndex
        ? store.searchMemoryIndex({
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            ftsQuery,
            limit: Math.max(limit * 4, 50),
          })
        : [];
      const ftsById = new Map(ftsMatches.map((match) => [match.memory.id, match]));
      const ftsIds = new Set(ftsById.keys());
      const memoriesById = new Map([
        ...store.listMemories(source).map((memory) => [memory.id, memory]),
        ...ftsMatches.map((match) => [match.memory.id, match.memory]),
      ]);

      return [...memoriesById.values()].map((memory) => {
        const match = scoreMemory(memory, queryTokens);
        const ftsMatch = ftsById.get(memory.id);
        const score = match.score + ftsScore(ftsMatch?.ftsRank);
        return {
          type: 'memory',
          score,
          why: match.matched,
          retrieval: {
            method: ftsIds.has(memory.id) ? 'fts5+lexical' : 'lexical',
            ftsRank: ftsMatch?.ftsRank ?? null,
          },
          source: {
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            role: source.role,
          },
          memory,
        };
      });
    })
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        scopeBoost(b.source) - scopeBoost(a.source) ||
        b.memory.importance - a.memory.importance ||
        b.memory.updatedAt.localeCompare(a.memory.updatedAt),
    )
    .slice(0, limit);
}
