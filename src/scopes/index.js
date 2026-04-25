import path from 'node:path';
import { inferRepoScopeKey } from '../config/index.js';

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
  let scopeKey = options.scopeKey;
  if (!scopeKey && scopeType === 'repo' && (options.repoPath || options.cwd)) {
    scopeKey = inferRepoScopeKey(path.resolve(config.cwd || process.cwd(), options.repoPath || options.cwd));
  }
  if (!scopeKey && scopeType === 'shared') {
    scopeKey = config.defaultSharedScopeKey || config.defaultScopeKey;
  }
  if (!scopeKey) {
    scopeKey = config.defaultScopeKey;
  }
  return validateScope(scopeType, scopeKey);
}
