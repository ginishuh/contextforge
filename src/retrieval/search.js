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

export function searchMemories(store, { scopeType, scopeKey, query, limit = 10 }) {
  const queryTokens = unique(tokenize(query));
  if (queryTokens.length === 0) {
    return [];
  }

  return store
    .listMemories({ scopeType, scopeKey })
    .map((memory) => {
      const match = scoreMemory(memory, queryTokens);
      return {
        type: 'memory',
        score: match.score,
        why: match.matched,
        memory,
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance)
    .slice(0, limit);
}
