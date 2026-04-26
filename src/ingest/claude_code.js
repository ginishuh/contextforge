import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_CONTENT_CHARS = 8000;
const DEFAULT_WATCH_INTERVAL_MS = 30000;
const CLAUDE_CODE_PROVENANCE = {
  sourceAgent: 'claude_code',
  sourceRuntime: 'claude_code_tui',
  sourceAdapter: 'claude_code_jsonl',
};

function stripClaudeCodeSessionPrefix(sessionId) {
  const text = String(sessionId || '');
  return text.startsWith('claude_code:') ? text.slice('claude_code:'.length) : text;
}

function claudeCodeSessionId(nativeSessionId) {
  const native = stripClaudeCodeSessionPrefix(nativeSessionId);
  return native ? `claude_code:${native}` : null;
}

function isPathWithin(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeAdapterList(adapters) {
  if (adapters == null) {
    return null;
  }
  if (Array.isArray(adapters)) {
    return adapters.map((adapter) => String(adapter));
  }
  return String(adapters)
    .split(',')
    .map((adapter) => adapter.trim())
    .filter(Boolean);
}

async function loadRepoRegistry(options = {}) {
  const registryPath = options.repoRegistry || options.registry || options.repoRegistryFile;
  if (!registryPath) {
    throw new Error('--repoRegistry is required for routed Claude Code ingest.');
  }
  const text = await fs.readFile(registryPath, 'utf8');
  const parsed = JSON.parse(text);
  const repos = Array.isArray(parsed) ? parsed : parsed.repos;
  if (!Array.isArray(repos)) {
    throw new Error('Repo registry must be a JSON array or an object with a repos array.');
  }

  return repos
    .filter((repo) => repo && repo.enabled !== false)
    .map((repo, index) => {
      if (!repo.name) {
        throw new Error(`Repo registry entry ${index} is missing name.`);
      }
      if (!repo.repoPath) {
        throw new Error(`Repo registry entry ${repo.name} is missing repoPath.`);
      }
      if (!repo.scopeKey) {
        throw new Error(`Repo registry entry ${repo.name} is missing scopeKey.`);
      }
      const adapters = normalizeAdapterList(repo.adapters);
      return {
        name: String(repo.name),
        repoPath: path.resolve(repo.repoPath),
        scopeKey: String(repo.scopeKey),
        adapters,
      };
    })
    .filter((repo) => !repo.adapters || repo.adapters.includes('claude_code'));
}

function matchRepoForCwd(cwd, repos) {
  if (!cwd) {
    return null;
  }
  const matches = repos.filter((repo) => isPathWithin(repo.repoPath, cwd));
  matches.sort((a, b) => b.repoPath.length - a.repoPath.length || a.name.localeCompare(b.name));
  return matches[0] || null;
}

function shouldSkipOutsideRepo(parsed, options = {}) {
  return Boolean(options.repoPath && parsed.cwd && !isPathWithin(options.repoPath, parsed.cwd));
}

async function shouldSkipRecentFailedAutoDistill(app, scopeOptions, sessionId, status) {
  const runs = await app.listDistillRuns({
    ...scopeOptions,
    sessionId,
  });
  const latest = runs[0];
  if (!latest || latest.status !== 'failed') {
    return false;
  }
  const failedAt = Date.parse(latest.completedAt || latest.createdAt);
  if (!Number.isFinite(failedAt)) {
    return false;
  }
  return Date.now() - failedAt < status.thresholds.minIntervalMs;
}

function truncate(value, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n[truncated]`, truncated: true };
}

function textFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text') return item.text || '';
      if (item.type === 'tool_use') {
        return JSON.stringify({ name: item.name || 'tool_use', input: item.input || {}, id: item.id || null }, null, 2);
      }
      if (item.type === 'tool_result') {
        return typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '', null, 2);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function roleFromRecord(record) {
  const role = record.message?.role || record.role || record.type;
  if (role === 'user' || role === 'assistant') {
    return role;
  }
  return null;
}

function outputRoleFromContent(content, fallbackRole) {
  if (Array.isArray(content) && content.some((item) => item?.type === 'tool_use')) {
    return 'tool_call';
  }
  if (Array.isArray(content) && content.some((item) => item?.type === 'tool_result')) {
    return 'tool_result';
  }
  return fallbackRole;
}

export function normalizeClaudeCodeRecord(record, context, options = {}) {
  const nativeSessionId = record.sessionId || context.nativeSessionId;
  if (nativeSessionId) {
    context.nativeSessionId = context.nativeSessionId || nativeSessionId;
    context.sessionId = context.sessionId || claudeCodeSessionId(nativeSessionId);
    context.conversationId = context.conversationId || claudeCodeSessionId(nativeSessionId);
  }
  context.cwd = context.cwd || record.cwd || null;

  const role = roleFromRecord(record);
  if (!role) {
    return null;
  }

  const contentValue = record.message?.content ?? record.content;
  const content = truncate(textFromContent(contentValue), options.maxContentChars);
  if (!content.text) {
    return null;
  }

  const native = context.nativeSessionId || stripClaudeCodeSessionPrefix(context.sessionId) || null;
  return {
    role: outputRoleFromContent(contentValue, role),
    content: content.text,
    metadata: {
      source: 'claude_code_jsonl',
      ...CLAUDE_CODE_PROVENANCE,
      nativeSessionId: native,
      ingestId: `claude-code:${native || 'unknown'}:${record.uuid || context.lineNumber}`,
      recordType: record.type || null,
      claudeRole: role,
      claudeUuid: record.uuid || null,
      parentUuid: record.parentUuid || null,
      timestamp: record.timestamp || null,
      truncated: content.truncated,
      sourceFile: context.filePath || null,
    },
  };
}

export async function parseClaudeCodeFile(filePath, options = {}) {
  const text = await fs.readFile(filePath, 'utf8');
  const nativeSessionId = options.sessionId ? stripClaudeCodeSessionPrefix(options.sessionId) : null;
  const sessionId = nativeSessionId ? claudeCodeSessionId(nativeSessionId) : null;
  const context = {
    filePath,
    nativeSessionId,
    sessionId,
    conversationId: options.conversationId ? claudeCodeSessionId(options.conversationId) : sessionId,
    cwd: null,
    lineNumber: 0,
  };
  const events = [];
  const warnings = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    context.lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 || index === lines.length - 2) {
        warnings.push({
          type: 'partial_json_line',
          lineNumber: context.lineNumber,
          message: error.message,
        });
        continue;
      }
      throw error;
    }
    const event = normalizeClaudeCodeRecord(record, context, options);
    if (event) {
      events.push(event);
    }
  }

  return {
    nativeSessionId: context.nativeSessionId,
    sessionId: context.sessionId,
    conversationId: context.conversationId || context.sessionId,
    cwd: context.cwd,
    events,
    warnings,
  };
}

async function appendNewEvents(app, scopeOptions, parsed) {
  const existing = await app.listRawEvents({
    ...scopeOptions,
    sessionId: parsed.sessionId,
  });
  const existingIds = new Set(existing.map((event) => event.metadata?.ingestId).filter(Boolean));
  const appended = [];
  let skipped = 0;

  for (const event of parsed.events) {
    if (existingIds.has(event.metadata.ingestId)) {
      skipped += 1;
      continue;
    }
    appended.push(
      await app.appendRaw({
        ...scopeOptions,
        sessionId: parsed.sessionId,
        conversationId: parsed.conversationId,
        role: event.role,
        content: event.content,
        metadata: event.metadata,
      }),
    );
  }

  return { appended, skipped };
}

async function ingestParsedClaudeCodeFile(app, parsed, options = {}) {
  if (!parsed.sessionId) {
    throw new Error('Claude Code session id could not be determined.');
  }
  const scopeOptions = {
    scope: options.scope,
    scopeKey: options.scopeKey,
    cwd: options.cwd || parsed.cwd,
    repoPath: options.repoPath,
  };
  const { appended, skipped } = await appendNewEvents(app, scopeOptions, parsed);
  const statusOptions = {
    ...scopeOptions,
    sessionId: parsed.sessionId,
    minEvents: options.minEvents,
    minIntervalMs: options.minIntervalMs,
    charMinIntervalMs: options.charMinIntervalMs,
    charThreshold: options.charThreshold,
    maxEvents: options.maxEvents,
    maxChars: options.maxChars,
  };
  const status = await app.sessionStatus(statusOptions);
  let checkpoint = null;
  let checkpointError = null;
  let checkpointSkippedReason = null;
  const distill = options.distill || 'never';
  if (distill === 'always' || (distill === 'auto' && status.shouldDistill)) {
    if (distill === 'auto' && (await shouldSkipRecentFailedAutoDistill(app, scopeOptions, parsed.sessionId, status))) {
      checkpointSkippedReason = 'recent_failed_distill';
    } else {
      try {
        checkpoint = await app.distillCheckpoint({
          ...scopeOptions,
          sessionId: parsed.sessionId,
          conversationId: parsed.conversationId,
          provider: options.provider,
          maxEvents: options.maxEvents,
          maxChars: options.maxChars,
        });
      } catch (error) {
        checkpointError = {
          message: error.message,
          name: error.name,
        };
      }
    }
  }

  return {
    parsedEvents: parsed.events.length,
    appendedEvents: appended.length,
    skippedEvents: skipped,
    status,
    checkpoint,
    checkpointError,
    checkpointSkippedReason,
  };
}

export async function ingestClaudeCodeFile(app, options = {}) {
  if (!options.file) {
    throw new Error('file is required.');
  }
  const parsed = await parseClaudeCodeFile(options.file, options);
  if (!parsed.sessionId) {
    throw new Error('Claude Code session id could not be determined.');
  }
  if (shouldSkipOutsideRepo(parsed, options)) {
    return {
      source: 'claude_code_jsonl',
      file: options.file,
      sessionId: parsed.sessionId,
      conversationId: parsed.conversationId,
      parsedEvents: parsed.events.length,
      appendedEvents: 0,
      skippedEvents: parsed.events.length,
      warnings: parsed.warnings,
      skipped: true,
      skippedReason: 'cwd_outside_repo_path',
      cwd: parsed.cwd,
      repoPath: path.resolve(options.repoPath),
      status: null,
      checkpoint: null,
    };
  }
  const result = await ingestParsedClaudeCodeFile(app, parsed, options);

  return {
    source: 'claude_code_jsonl',
    file: options.file,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    warnings: parsed.warnings,
    ...result,
  };
}

async function walkFiles(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

export async function discoverClaudeCodeFiles(options = {}) {
  const projectsDir = path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir());
  const files = (await walkFiles(projectsDir)).filter((file) => file.endsWith('.jsonl'));
  const stats = await Promise.all(
    files.map(async (file) => ({
      file,
      stat: await fs.stat(file),
    })),
  );
  const sinceMs = options.sinceMinutes == null ? null : Date.now() - Number(options.sinceMinutes) * 60 * 1000;
  return stats
    .filter((item) => sinceMs == null || item.stat.mtimeMs >= sinceMs)
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.file.localeCompare(b.file))
    .slice(0, options.scanLimit == null ? undefined : Number(options.scanLimit))
    .map((item) => item.file);
}

export async function ingestClaudeCodeSessions(app, options = {}) {
  const files = options.file ? [options.file] : await discoverClaudeCodeFiles(options);
  const results = [];
  for (const file of files) {
    results.push(await ingestClaudeCodeFile(app, { ...options, file }));
  }

  return {
    source: 'claude_code_sessions',
    projectsDir: path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir()),
    filesScanned: files.length,
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.filter((result) => result.checkpoint).length,
    fileResults: results,
  };
}

export async function ingestClaudeCodeRoutedSessions(app, options = {}) {
  const repos = await loadRepoRegistry(options);
  const files = options.file ? [options.file] : await discoverClaudeCodeFiles(options);
  const results = [];

  for (const file of files) {
    const parsed = await parseClaudeCodeFile(file, options);
    const matchedRepo = matchRepoForCwd(parsed.cwd, repos);
    if (!matchedRepo) {
      results.push({
        source: 'claude_code_jsonl',
        file,
        sessionId: parsed.sessionId,
        conversationId: parsed.conversationId,
        parsedEvents: parsed.events.length,
        appendedEvents: 0,
        skippedEvents: parsed.events.length,
        warnings: parsed.warnings,
        skipped: true,
        skippedReason: parsed.cwd ? 'unmatched_repo_cwd' : 'missing_cwd',
        cwd: parsed.cwd,
        matchedRepo: null,
        status: null,
        checkpoint: null,
      });
      continue;
    }

    const result = await ingestParsedClaudeCodeFile(app, parsed, {
      ...options,
      scope: 'repo',
      scopeKey: matchedRepo.scopeKey,
      repoPath: undefined,
      cwd: undefined,
    });
    results.push({
      source: 'claude_code_jsonl',
      file,
      sessionId: parsed.sessionId,
      conversationId: parsed.conversationId,
      warnings: parsed.warnings,
      matchedRepo: {
        name: matchedRepo.name,
        repoPath: matchedRepo.repoPath,
        scopeKey: matchedRepo.scopeKey,
      },
      ...result,
    });
  }

  return {
    source: 'claude_code_sessions_router',
    projectsDir: path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir()),
    registry: path.resolve(options.repoRegistry || options.registry || options.repoRegistryFile),
    repos: repos.map((repo) => ({
      name: repo.name,
      repoPath: repo.repoPath,
      scopeKey: repo.scopeKey,
    })),
    filesScanned: files.length,
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.filter((result) => result.checkpoint).length,
    routedFiles: results.filter((result) => result.matchedRepo).length,
    skippedFiles: results.filter((result) => result.skipped).length,
    fileResults: results,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarizeWatchResults(results) {
  return {
    filesScanned: results.reduce((total, result) => total + result.filesScanned, 0),
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.reduce((total, result) => total + result.checkpointsCreated, 0),
  };
}

export async function watchClaudeCodeSessions(app, options = {}) {
  const intervalMs =
    options.intervalMs == null ? DEFAULT_WATCH_INTERVAL_MS : Math.max(0, Number(options.intervalMs));
  const maxIterations = options.iterations == null ? null : Math.max(0, Number(options.iterations));
  const startedAt = new Date().toISOString();
  const results = [];
  let iterations = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopped && (maxIterations == null || iterations < maxIterations)) {
      iterations += 1;
      const result = await ingestClaudeCodeSessions(app, options);
      const iterationResult = {
        ...result,
        source: 'claude_code_sessions_watch_iteration',
        iteration: iterations,
        intervalMs,
        watchedAt: new Date().toISOString(),
      };
      results.push(iterationResult);
      if (options.onResult) {
        await options.onResult(iterationResult);
      }
      if (!stopped && (maxIterations == null || iterations < maxIterations)) {
        await sleep(intervalMs);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }

  return {
    source: 'claude_code_sessions_watch',
    projectsDir: path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir()),
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals: summarizeWatchResults(results),
    results,
  };
}

export async function watchClaudeCodeRoutedSessions(app, options = {}) {
  const intervalMs =
    options.intervalMs == null ? DEFAULT_WATCH_INTERVAL_MS : Math.max(0, Number(options.intervalMs));
  const maxIterations = options.iterations == null ? null : Math.max(0, Number(options.iterations));
  const startedAt = new Date().toISOString();
  const results = [];
  let iterations = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopped && (maxIterations == null || iterations < maxIterations)) {
      iterations += 1;
      const result = await ingestClaudeCodeRoutedSessions(app, options);
      const iterationResult = {
        ...result,
        source: 'claude_code_sessions_router_watch_iteration',
        iteration: iterations,
        intervalMs,
        watchedAt: new Date().toISOString(),
      };
      results.push(iterationResult);
      if (options.onResult) {
        await options.onResult(iterationResult);
      }
      if (!stopped && (maxIterations == null || iterations < maxIterations)) {
        await sleep(intervalMs);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }

  return {
    source: 'claude_code_sessions_router_watch',
    projectsDir: path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir()),
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals: summarizeWatchResults(results),
    results,
  };
}
