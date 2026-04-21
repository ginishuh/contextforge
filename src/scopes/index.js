const VALID_SCOPE_TYPES = new Set(['shared', 'repo', 'local']);

export function validateScope(scopeType, scopeKey) {
  if (!VALID_SCOPE_TYPES.has(scopeType)) {
    throw new Error(`Invalid scope type "${scopeType}". Expected shared, repo, or local.`);
  }

  if (!scopeKey || typeof scopeKey !== 'string') {
    throw new Error('scopeKey is required.');
  }

  return { scopeType, scopeKey };
}

export function normalizeScopeOptions(options, config) {
  const scopeType = options.scopeType || options.scope || config.defaultScope;
  const scopeKey = options.scopeKey || config.defaultScopeKey;
  return validateScope(scopeType, scopeKey);
}
