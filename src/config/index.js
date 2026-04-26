import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

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

function parseOptionalPositiveInteger(value, name) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function findGitRoot(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    const dotGit = path.join(current, '.git');
    if (fs.existsSync(dotGit)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function parseGitConfigRemotes(configText) {
  const remotes = new Map();
  let currentRemote = null;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[remote "(.+)"\]$/);
    if (section) {
      currentRemote = section[1];
      continue;
    }
    if (line.startsWith('[')) {
      currentRemote = null;
      continue;
    }
    if (!currentRemote) {
      continue;
    }

    const entry = line.match(/^url\s*=\s*(.+)$/);
    if (entry) {
      remotes.set(currentRemote, entry[1].trim());
    }
  }

  return remotes;
}

function readGitConfig(gitRoot) {
  const dotGitPath = path.join(gitRoot, '.git');
  let configPath = path.join(dotGitPath, 'config');

  if (fs.existsSync(dotGitPath) && fs.statSync(dotGitPath).isFile()) {
    const dotGitContent = fs.readFileSync(dotGitPath, 'utf8');
    const match = dotGitContent.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      const gitDir = path.resolve(gitRoot, match[1].trim());
      configPath = path.join(gitDir, 'config');
    }
  }

  if (!fs.existsSync(configPath)) {
    return null;
  }
  return fs.readFileSync(configPath, 'utf8');
}

function normalizeGitHubRemote(url) {
  const trimmed = String(url || '').trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
    /^http:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return `github.com/${match[1]}/${match[2]}`;
    }
  }

  return null;
}

function pathScopeKey(cwd) {
  const resolved = path.resolve(cwd);
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return `path:${digest}:${path.basename(resolved) || 'root'}`;
}

function defaultScopeKeyFor(scope, cwd, sharedScopeKey) {
  if (scope === 'repo') {
    return inferRepoScopeKey(cwd);
  }
  if (scope === 'shared') {
    return sharedScopeKey;
  }
  return pathScopeKey(cwd);
}

export function inferRepoScopeKey(cwd) {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return pathScopeKey(cwd);
  }

  const configText = readGitConfig(gitRoot);
  if (configText) {
    const remotes = parseGitConfigRemotes(configText);
    const preferred = remotes.get('origin') || [...remotes.values()][0];
    const githubKey = normalizeGitHubRemote(preferred);
    if (githubKey) {
      return githubKey;
    }
  }

  return pathScopeKey(gitRoot);
}

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const storageMode = env.CONTEXTFORGE_STORAGE_MODE || (env.CONTEXTFORGE_REMOTE_URL ? 'remote' : 'project-local');
  if (!VALID_STORAGE_MODES.has(storageMode)) {
    throw new Error(`Invalid CONTEXTFORGE_STORAGE_MODE: ${storageMode}`);
  }

  const dataDir = env.CONTEXTFORGE_DATA_DIR
    ? path.resolve(resolvedCwd, env.CONTEXTFORGE_DATA_DIR)
    : storageMode === 'local'
      ? path.join(env.HOME || os.homedir(), '.contextforge')
      : path.join(resolvedCwd, '.contextforge');

  const defaultScope = env.CONTEXTFORGE_DEFAULT_SCOPE || 'repo';
  if (!VALID_SCOPES.has(defaultScope)) {
    throw new Error(`Invalid CONTEXTFORGE_DEFAULT_SCOPE: ${defaultScope}`);
  }
  const codexExecMaxInputChars = parsePositiveInteger(
    env.CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS,
    'CONTEXTFORGE_CODEX_EXEC_MAX_INPUT_CHARS',
    12000,
  );
  const distillMinIntervalMs = parsePositiveInteger(
    env.CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS,
    'CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS',
    10 * 60 * 1000,
  );
  const defaultSharedScopeKey = env.CONTEXTFORGE_SHARED_SCOPE_KEY || 'global';
  const defaultScopeKey =
    env.CONTEXTFORGE_DEFAULT_SCOPE_KEY || defaultScopeKeyFor(defaultScope, resolvedCwd, defaultSharedScopeKey);

  return {
    storageMode,
    cwd: resolvedCwd,
    dataDir,
    defaultScope,
    defaultScopeKey,
    defaultSharedScopeKey,
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
      reasoningEffort: env.CONTEXTFORGE_CODEX_EXEC_REASONING_EFFORT || null,
      sandbox: env.CONTEXTFORGE_CODEX_EXEC_SANDBOX || 'read-only',
      cwd: env.CONTEXTFORGE_CODEX_EXEC_CWD
        ? path.resolve(resolvedCwd, env.CONTEXTFORGE_CODEX_EXEC_CWD)
        : resolvedCwd,
      timeoutMs: parsePositiveInteger(
        env.CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS,
        'CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS',
        120000,
      ),
      maxInputChars: codexExecMaxInputChars,
    },
    distillPolicy: {
      minEvents: parsePositiveInteger(env.CONTEXTFORGE_DISTILL_MIN_EVENTS, 'CONTEXTFORGE_DISTILL_MIN_EVENTS', 5),
      minIntervalMs: distillMinIntervalMs,
      charMinIntervalMs: parsePositiveInteger(
        env.CONTEXTFORGE_DISTILL_CHAR_MIN_INTERVAL_MS,
        'CONTEXTFORGE_DISTILL_CHAR_MIN_INTERVAL_MS',
        distillMinIntervalMs,
      ),
      charThreshold: parsePositiveInteger(
        env.CONTEXTFORGE_DISTILL_CHAR_THRESHOLD,
        'CONTEXTFORGE_DISTILL_CHAR_THRESHOLD',
        Math.floor(codexExecMaxInputChars * 0.8),
      ),
      maxEvents: parsePositiveInteger(env.CONTEXTFORGE_DISTILL_MAX_EVENTS, 'CONTEXTFORGE_DISTILL_MAX_EVENTS', 80),
      maxChars: parsePositiveInteger(
        env.CONTEXTFORGE_DISTILL_MAX_CHARS,
        'CONTEXTFORGE_DISTILL_MAX_CHARS',
        codexExecMaxInputChars,
      ),
    },
    rawRetention: {
      ttlDays: parseOptionalPositiveInteger(
        env.CONTEXTFORGE_RAW_TTL_DAYS ?? env.CONTEXTFORGE_RAW_EVENT_TTL_DAYS,
        'CONTEXTFORGE_RAW_TTL_DAYS',
      ),
      pruneIntervalMs: parsePositiveInteger(
        env.CONTEXTFORGE_RAW_PRUNE_INTERVAL_MS,
        'CONTEXTFORGE_RAW_PRUNE_INTERVAL_MS',
        60 * 60 * 1000,
      ),
    },
  };
}
