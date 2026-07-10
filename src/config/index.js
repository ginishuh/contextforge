import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const VALID_SCOPES = new Set(['shared', 'repo', 'local']);
const VALID_STORAGE_MODES = new Set(['local', 'project-local', 'remote']);
const VALID_EMBEDDINGS_PROVIDERS = new Set(['none', 'openai']);

function parseScopedKey(value, fallbackScope = 'repo') {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error('scope alias entries must not be empty.');
  }
  const match = text.match(/^(shared|repo|local):(.+)$/);
  if (match) {
    return {
      scopeType: match[1],
      scopeKey: match[2].trim(),
    };
  }
  return {
    scopeType: fallbackScope,
    scopeKey: text,
  };
}

function scopeAliasEntry(from, to) {
  const parsedFrom = typeof from === 'object' && from
    ? { scopeType: from.scopeType || from.scope || 'repo', scopeKey: from.scopeKey }
    : parseScopedKey(from);
  const parsedTo = typeof to === 'object' && to
    ? { scopeType: to.scopeType || to.scope || parsedFrom.scopeType, scopeKey: to.scopeKey }
    : parseScopedKey(to, parsedFrom.scopeType);
  if (!VALID_SCOPES.has(parsedFrom.scopeType) || !VALID_SCOPES.has(parsedTo.scopeType)) {
    throw new Error('scope alias scope type must be shared, repo, or local.');
  }
  if (parsedFrom.scopeType !== parsedTo.scopeType) {
    throw new Error('scope aliases cannot change scope type.');
  }
  if (!parsedFrom.scopeKey || !parsedTo.scopeKey) {
    throw new Error('scope alias entries require both source and target scope keys.');
  }
  return {
    from: parsedFrom,
    to: parsedTo,
  };
}

export function parseScopeAliases(value) {
  if (value == null || value === '') {
    return [];
  }
  const text = String(value).trim();
  let parsed = null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`CONTEXTFORGE_SCOPE_ALIASES must be valid JSON or alias text: ${error.message}`);
    }
  }
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => scopeAliasEntry(entry.from, entry.to));
  }
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed).map(([from, to]) => scopeAliasEntry(from, to));
  }

  return text
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.includes('->') ? entry.split('->') : entry.split('=');
      if (parts.length !== 2) {
        throw new Error('CONTEXTFORGE_SCOPE_ALIASES entries must use "=" or "->".');
      }
      return scopeAliasEntry(parts[0], parts[1]);
    });
}

export function canonicalizeScope(scope, aliases = []) {
  let current = { scopeType: scope.scopeType, scopeKey: scope.scopeKey };
  const seen = new Set();
  for (let depth = 0; depth < 20; depth += 1) {
    const signature = `${current.scopeType}:${current.scopeKey}`;
    if (seen.has(signature)) {
      throw new Error(`Scope alias cycle detected at ${signature}.`);
    }
    seen.add(signature);
    const alias = aliases.find(
      (item) => item.from.scopeType === current.scopeType && item.from.scopeKey === current.scopeKey,
    );
    if (!alias) {
      return current;
    }
    current = { ...alias.to };
  }
  throw new Error('Scope alias chain is too deep.');
}

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

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
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
  const embeddingsProvider = env.CONTEXTFORGE_EMBEDDINGS_PROVIDER || (env.CONTEXTFORGE_OPENAI_API_KEY || env.OPENAI_API_KEY ? 'openai' : 'none');
  if (!VALID_EMBEDDINGS_PROVIDERS.has(embeddingsProvider)) {
    throw new Error(`Invalid CONTEXTFORGE_EMBEDDINGS_PROVIDER: ${embeddingsProvider}`);
  }
  const embeddingsDimensions = parsePositiveInteger(
    env.CONTEXTFORGE_EMBEDDINGS_DIMENSIONS,
    'CONTEXTFORGE_EMBEDDINGS_DIMENSIONS',
    1536,
  );
  const embeddingsStaleAfterMs = parsePositiveInteger(
    env.CONTEXTFORGE_EMBEDDINGS_STALE_AFTER_MS,
    'CONTEXTFORGE_EMBEDDINGS_STALE_AFTER_MS',
    10 * 60 * 1000,
  );
  const distillMinIntervalMs = parsePositiveInteger(
    env.CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS,
    'CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS',
    10 * 60 * 1000,
  );
  const defaultSharedScopeKey = env.CONTEXTFORGE_SHARED_SCOPE_KEY || 'global';
  const scopeAliases = parseScopeAliases(env.CONTEXTFORGE_SCOPE_ALIASES);
  const defaultScopeKey = canonicalizeScope(
    {
      scopeType: defaultScope,
      scopeKey: env.CONTEXTFORGE_DEFAULT_SCOPE_KEY || defaultScopeKeyFor(defaultScope, resolvedCwd, defaultSharedScopeKey),
    },
    scopeAliases,
  ).scopeKey;

  return {
    storageMode,
    cwd: resolvedCwd,
    dataDir,
    defaultScope,
    defaultScopeKey,
    defaultSharedScopeKey,
    scopeAliases,
    distillProvider: env.CONTEXTFORGE_DISTILL_PROVIDER || 'mock',
    embeddings: {
      provider: embeddingsProvider,
      model: env.CONTEXTFORGE_EMBEDDINGS_MODEL || 'text-embedding-3-small',
      dimensions: embeddingsDimensions,
      apiKey: env.CONTEXTFORGE_OPENAI_API_KEY || env.OPENAI_API_KEY || null,
      baseUrl: env.CONTEXTFORGE_OPENAI_BASE_URL || 'https://api.openai.com/v1',
      timeoutMs: parsePositiveInteger(
        env.CONTEXTFORGE_EMBEDDINGS_TIMEOUT_MS,
        'CONTEXTFORGE_EMBEDDINGS_TIMEOUT_MS',
        30000,
      ),
      staleAfterMs: embeddingsStaleAfterMs,
    },
    remote: {
      url: env.CONTEXTFORGE_REMOTE_URL || null,
      token: env.CONTEXTFORGE_REMOTE_TOKEN || null,
      timeoutMs: parsePositiveInteger(
        env.CONTEXTFORGE_REMOTE_TIMEOUT_MS,
        'CONTEXTFORGE_REMOTE_TIMEOUT_MS',
        30000,
      ),
    },
    runtime: {
      role: env.CONTEXTFORGE_RUNTIME_ROLE || 'local-process',
      allowPlaintextRuntimeSecrets: parseBoolean(env.CONTEXTFORGE_ALLOW_PLAINTEXT_RUNTIME_SECRETS),
    },
    providerExecution: {
      concurrencyLimit: parsePositiveInteger(
        env.CONTEXTFORGE_PROVIDER_CONCURRENCY_LIMIT,
        'CONTEXTFORGE_PROVIDER_CONCURRENCY_LIMIT',
        2,
      ),
    },
    operations: {
      readinessMinFreeBytes: parsePositiveInteger(
        env.CONTEXTFORGE_READINESS_MIN_FREE_BYTES,
        'CONTEXTFORGE_READINESS_MIN_FREE_BYTES',
        100 * 1024 * 1024,
      ),
      readinessMaxQueuedJobs: parsePositiveInteger(
        env.CONTEXTFORGE_READINESS_MAX_QUEUED_JOBS,
        'CONTEXTFORGE_READINESS_MAX_QUEUED_JOBS',
        1000,
      ),
      shutdownTimeoutMs: parsePositiveInteger(
        env.CONTEXTFORGE_SHUTDOWN_TIMEOUT_MS,
        'CONTEXTFORGE_SHUTDOWN_TIMEOUT_MS',
        30000,
      ),
    },
    autoPromote: {
      enabled: parseBoolean(env.CONTEXTFORGE_AUTO_PROMOTE_ENABLED),
      audit: {
        enabled: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED !== 'false',
        provider: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER || 'codex_exec',
        command: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_COMMAND || env.CONTEXTFORGE_CODEX_EXEC_COMMAND || 'codex',
        codexBin:
          env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN ||
          env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_COMMAND ||
          env.CONTEXTFORGE_CODEX_EXEC_COMMAND ||
          'codex',
        pythonCommand: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND || 'python3',
        pythonPath: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH || null,
        model: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_MODEL || 'gpt-5.5',
        reasoningEffort: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_REASONING_EFFORT || 'low',
        sandbox: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_SANDBOX || 'read-only',
        cwd: env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_CWD
          ? path.resolve(resolvedCwd, env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_CWD)
          : resolvedCwd,
        timeoutMs: parsePositiveInteger(
          env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_TIMEOUT_MS,
          'CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_TIMEOUT_MS',
          120000,
        ),
        minBatchCandidates: parsePositiveInteger(
          env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES,
          'CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES',
          5,
        ),
        batchLimit: parsePositiveInteger(
          env.CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT,
          'CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT',
          5,
        ),
      },
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
    openAiCompatible: {
      preset: env.CONTEXTFORGE_OPENAI_COMPATIBLE_PRESET || 'deepseek',
      baseUrl: env.CONTEXTFORGE_OPENAI_COMPATIBLE_BASE_URL || 'https://api.deepseek.com',
      apiKey:
        env.CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY ||
        env.CONTEXTFORGE_DEEPSEEK_API_KEY ||
        env.DEEPSEEK_API_KEY ||
        null,
      model: env.CONTEXTFORGE_OPENAI_COMPATIBLE_MODEL || 'deepseek-v4-flash',
      responseFormat: env.CONTEXTFORGE_OPENAI_COMPATIBLE_RESPONSE_FORMAT || 'json_object',
      timeoutMs: parsePositiveInteger(
        env.CONTEXTFORGE_OPENAI_COMPATIBLE_TIMEOUT_MS,
        'CONTEXTFORGE_OPENAI_COMPATIBLE_TIMEOUT_MS',
        120000,
      ),
      maxInputChars: parsePositiveInteger(
        env.CONTEXTFORGE_OPENAI_COMPATIBLE_MAX_INPUT_CHARS,
        'CONTEXTFORGE_OPENAI_COMPATIBLE_MAX_INPUT_CHARS',
        12000,
      ),
      maxTokens: parseOptionalPositiveInteger(
        env.CONTEXTFORGE_OPENAI_COMPATIBLE_MAX_TOKENS,
        'CONTEXTFORGE_OPENAI_COMPATIBLE_MAX_TOKENS',
      ),
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
