import path from 'node:path';

const VALID_SCOPES = new Set(['shared', 'repo', 'local']);

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const dataDir = env.CONTEXTFORGE_DATA_DIR
    ? path.resolve(cwd, env.CONTEXTFORGE_DATA_DIR)
    : path.join(cwd, '.contextforge');

  const defaultScope = env.CONTEXTFORGE_DEFAULT_SCOPE || 'repo';
  if (!VALID_SCOPES.has(defaultScope)) {
    throw new Error(`Invalid CONTEXTFORGE_DEFAULT_SCOPE: ${defaultScope}`);
  }

  return {
    dataDir,
    defaultScope,
    defaultScopeKey: env.CONTEXTFORGE_DEFAULT_SCOPE_KEY || null,
    distillProvider: env.CONTEXTFORGE_DISTILL_PROVIDER || 'mock',
  };
}
