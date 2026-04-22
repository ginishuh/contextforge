function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .filter((token) => token.length > 1);
}

function unique(values) {
  return [...new Set(values)];
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
    const hitFields = Object.entries(fields)
      .filter(([, value]) => String(value || '').toLowerCase().includes(token))
      .map(([name]) => name);
    if (hitFields.length > 0) {
      score += hitFields.includes('content') ? 2 : 1;
      matched.push({ token, fields: hitFields });
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

  return scopes
    .flatMap((source) =>
      store.listMemories(source).map((memory) => {
        const match = scoreMemory(memory, queryTokens);
        return {
          type: 'memory',
          score: match.score,
          why: match.matched,
          source: {
            scopeType: source.scopeType,
            scopeKey: source.scopeKey,
            role: source.role,
          },
          memory,
        };
      }),
    )
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
