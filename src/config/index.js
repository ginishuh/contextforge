import path from 'node:path';
import os from 'node:os';

const VALID_SCOPES = new Set(['shared', 'repo', 'local']);
const VALID_STORAGE_MODES = new Set(['local', 'project-local', 'remote']);

function parsePositiveInteger(value, name, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const storageMode = env.CONTEXTFORGE_STORAGE_MODE || (env.CONTEXTFORGE_REMOTE_URL ? 'remote' : 'project-local');
  if (!VALID_STORAGE_MODES.has(storageMode)) {
    throw new Error(`Invalid CONTEXTFORGE_STORAGE_MODE: ${storageMode}`);
  }

  const dataDir = env.CONTEXTFORGE_DATA_DIR
    ? path.resolve(cwd, env.CONTEXTFORGE_DATA_DIR)
    : storageMode === 'local'
      ? path.join(env.HOME || os.homedir(), '.contextforge')
    : path.join(cwd, '.contextforge');

  const defaultScope = env.CONTEXTFORGE_DEFAULT_SCOPE || 'repo';
  if (!VALID_SCOPES.has(defaultScope)) {
    throw new Error(`Invalid CONTEXTFORGE_DEFAULT_SCOPE: ${defaultScope}`);
  }

  return {
    storageMode,
    dataDir,
    defaultScope,
    defaultScopeKey: env.CONTEXTFORGE_DEFAULT_SCOPE_KEY || null,
    distillProvider: env.CONTEXTFORGE_DISTILL_PROVIDER || 'mock',
    remote: {
      url: env.CONTEXTFORGE_REMOTE_URL || null,
      token: env.CONTEXTFORGE_REMOTE_TOKEN || null,
      timeoutMs: parsePositiveInteger(
        env.CONTEXTFORGE_REMOTE_TIMEOUT_MS,
        'CONTEXTFORGE_REMOTE_TIMEOUT_MS',
        30000,
      ),
    },
    codexExec: {
      command: env.CONTEXTFORGE_CODEX_EXEC_COMMAND || 'codex',
      model: env.CONTEXTFORGE_CODEX_EXEC_MODEL || null,
      sandbox: env.CONTEXTFORGE_CODEX_EXEC_SANDBOX || 'read-only',
      cwd: env.CONTEXTFORGE_CODEX_EXEC_CWD ? path.resolve(cwd, env.CONTEXTFORGE_CODEX_EXEC_CWD) : cwd,
      timeoutMs: parsePositiveInteger(
        env.CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS,
        'CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS',
        120000,
      ),
      maxInputChars: parsePositiveInteger(
        env.CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS,
        'CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS',
        12000,
      ),
    },
  };
}
