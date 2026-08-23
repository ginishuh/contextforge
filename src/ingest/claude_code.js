import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createInterruptibleSleep,
  addWatchTotals,
  buildWatchStateDescriptor,
  createWatchSummary,
  createWatchTotals,
  discoverFiles,
  ingestParsedSession,
  loadRepoRegistry,
  loadWatchState,
  matchRepoForCwdOrGitRemote,
  readIncrementalJsonl,
  saveWatchState,
  shouldSkipOutsideRepo,
  summarizeResults,
  truncate,
} from './common.js';

const DEFAULT_MAX_CONTENT_CHARS = 8000;
const DEFAULT_WATCH_INTERVAL_MS = 30000;
const CLAUDE_CODE_PROVENANCE = {
  sourceAgent: 'claude_code',
  sourceRuntime: 'claude_code_tui',
  sourceAdapter: 'claude_code_jsonl',
};

function incrementalClaudeCodeInitialContext(currentEntry = {}, chunk) {
  return {
    nativeSessionId: currentEntry.nativeSessionId,
    sessionId: currentEntry.sessionId,
    conversationId: currentEntry.conversationId,
    cwd: currentEntry.cwd,
    lineNumber: chunk.reset ? 0 : currentEntry.lineNumber || 0,
  };
}

function stripClaudeCodeSessionPrefix(sessionId) {
  const text = String(sessionId || '');
  return text.startsWith('claude_code:') ? text.slice('claude_code:'.length) : text;
}

function claudeCodeSessionId(nativeSessionId) {
  const native = stripClaudeCodeSessionPrefix(nativeSessionId);
  return native ? `claude_code:${native}` : null;
}

// Deliberately stricter than textFromContent() in ./common.js: Claude Code
// transcripts carry non-text parts that must not be flattened into content.
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
  const content = truncate(textFromContent(contentValue), options.maxContentChars || DEFAULT_MAX_CONTENT_CHARS);
  if (!content.text) {
    return null;
  }

  const native = context.nativeSessionId || stripClaudeCodeSessionPrefix(context.sessionId) || null;
  return {
    role,
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

export function parseClaudeCodeLines(filePath, lines, options = {}, initialContext = {}) {
  const nativeSessionId =
    initialContext.nativeSessionId ||
    (options.sessionId ? stripClaudeCodeSessionPrefix(options.sessionId) : null);
  const sessionId = initialContext.sessionId || (nativeSessionId ? claudeCodeSessionId(nativeSessionId) : null);
  const context = {
    filePath,
    nativeSessionId,
    sessionId,
    conversationId:
      initialContext.conversationId ||
      (options.conversationId ? claudeCodeSessionId(options.conversationId) : sessionId),
    cwd: initialContext.cwd || null,
    lineNumber: initialContext.lineNumber || 0,
  };
  const events = [];
  const warnings = [];

  for (const line of lines) {
    context.lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      if (!options.recoverMalformedJsonl) {
        throw error;
      }
      warnings.push({
        type: 'malformed_json_line',
        lineNumber: context.lineNumber,
        message: error.message,
      });
      continue;
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
    lineNumber: context.lineNumber,
    events,
    warnings,
  };
}

export async function parseClaudeCodeFile(filePath, options = {}) {
  const text = await fs.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const completeLines = [];
  const warnings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 || index === lines.length - 2) {
        warnings.push({
          type: 'partial_json_line',
          lineNumber: index + 1,
          message: error.message,
        });
        continue;
      }
      throw error;
    }
    completeLines.push(line);
  }
  const parsed = parseClaudeCodeLines(filePath, completeLines, options);

  return {
    nativeSessionId: parsed.nativeSessionId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    cwd: parsed.cwd,
    events: parsed.events,
    warnings,
  };
}

async function ingestParsedClaudeCodeFile(app, parsed, options = {}) {
  return ingestParsedSession(app, parsed, options, {
    missingSessionMessage: 'Claude Code session id could not be determined.',
  });
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

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

export async function discoverClaudeCodeFiles(options = {}) {
  const projectsDir = path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir());
  return discoverFiles(projectsDir, options, (file) => file.endsWith('.jsonl'));
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
  const repos = await loadRepoRegistry(options, { adapter: 'claude_code', label: 'Claude Code' });
  const files = options.file ? [options.file] : await discoverClaudeCodeFiles(options);
  const results = [];

  for (const file of files) {
    const parsed = await parseClaudeCodeFile(file, options);
    const matchedRepo = await matchRepoForCwdOrGitRemote(parsed.cwd, repos, options);
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

async function processIncrementalClaudeCodeFile(app, file, options, state) {
  const currentEntry = state.entries[file] || {};
  const chunk = await readIncrementalJsonl(file, currentEntry);
  if (!chunk.changed) {
    return {
      result: {
        source: 'claude_code_jsonl',
        file,
        sessionId: currentEntry.sessionId || null,
        conversationId: currentEntry.conversationId || null,
        parsedEvents: 0,
        appendedEvents: 0,
        skippedEvents: 0,
        warnings: [],
        skipped: false,
        unchanged: true,
        checkpoint: null,
      },
      stateUpdated: false,
    };
  }
  if (chunk.lines.length === 0) {
    return {
      result: {
        source: 'claude_code_jsonl',
        file,
        sessionId: currentEntry.sessionId || null,
        conversationId: currentEntry.conversationId || null,
        parsedEvents: 0,
        appendedEvents: 0,
        skippedEvents: 0,
        warnings: chunk.hasPartialLine
          ? [{ type: 'partial_json_line', lineNumber: chunk.nextLineNumber + 1, message: 'Incomplete trailing JSONL record.' }]
          : [],
        skipped: false,
        checkpoint: null,
      },
      stateUpdated: false,
    };
  }
  const parsed = parseClaudeCodeLines(
    file,
    chunk.lines,
    { ...options, recoverMalformedJsonl: true },
    incrementalClaudeCodeInitialContext(currentEntry, chunk),
  );
  if (!parsed.sessionId) {
    throw new Error('Claude Code session id could not be determined.');
  }
  let result;
  if (shouldSkipOutsideRepo(parsed, options)) {
    result = {
      source: 'claude_code_jsonl',
      file,
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
  } else {
    result = {
      source: 'claude_code_jsonl',
      file,
      sessionId: parsed.sessionId,
      conversationId: parsed.conversationId,
      warnings: parsed.warnings,
      ...(await ingestParsedClaudeCodeFile(app, parsed, options)),
    };
  }
  state.entries[file] = {
    offset: chunk.nextOffset,
    lineNumber: chunk.nextLineNumber,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    nativeSessionId: parsed.nativeSessionId,
    cwd: parsed.cwd,
    size: chunk.stat.size,
    mtimeMs: chunk.stat.mtimeMs,
    updatedAt: new Date().toISOString(),
  };
  return { result, stateUpdated: true };
}

export async function ingestClaudeCodeSessionsIncremental(app, options = {}) {
  const projectsDir = path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir());
  const descriptor = await buildWatchStateDescriptor({ adapter: 'claude_code', rootDir: projectsDir, options });
  const { state, stateLoaded, corruptFile } = await loadWatchState(descriptor);
  const files = options.file ? [options.file] : await discoverClaudeCodeFiles(options);
  const results = [];
  let stateUpdated = false;
  for (const file of files) {
    const processed = await processIncrementalClaudeCodeFile(app, file, options, state);
    results.push(processed.result);
    stateUpdated = stateUpdated || processed.stateUpdated;
  }
  if (stateUpdated) {
    await saveWatchState(descriptor, state);
  }
  return {
    source: 'claude_code_sessions',
    projectsDir,
    scope: options.scope,
    scopeKey: options.scopeKey,
    filesScanned: files.length,
    filesChanged: results.filter((result) => !result.unchanged).length,
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.filter((result) => result.checkpoint).length,
    stateFile: descriptor.stateFile,
    stateLoaded,
    stateUpdated,
    corruptStateFile: corruptFile,
    fileResults: results,
  };
}

async function processIncrementalRoutedClaudeCodeFile(app, file, options, repos, state) {
  const currentEntry = state.entries[file] || {};
  const chunk = await readIncrementalJsonl(file, currentEntry);
  if (!chunk.changed) {
    return {
      result: {
        source: 'claude_code_jsonl',
        file,
        sessionId: currentEntry.sessionId || null,
        conversationId: currentEntry.conversationId || null,
        parsedEvents: 0,
        appendedEvents: 0,
        skippedEvents: 0,
        warnings: [],
        skipped: false,
        unchanged: true,
        matchedRepo: currentEntry.matchedRepo || null,
        checkpoint: null,
      },
      stateUpdated: false,
    };
  }
  if (chunk.lines.length === 0) {
    return {
      result: {
        source: 'claude_code_jsonl',
        file,
        sessionId: currentEntry.sessionId || null,
        conversationId: currentEntry.conversationId || null,
        parsedEvents: 0,
        appendedEvents: 0,
        skippedEvents: 0,
        warnings: chunk.hasPartialLine
          ? [{ type: 'partial_json_line', lineNumber: chunk.nextLineNumber + 1, message: 'Incomplete trailing JSONL record.' }]
          : [],
        skipped: false,
        matchedRepo: currentEntry.matchedRepo || null,
        checkpoint: null,
      },
      stateUpdated: false,
    };
  }
  const parsed = parseClaudeCodeLines(
    file,
    chunk.lines,
    { ...options, recoverMalformedJsonl: true },
    incrementalClaudeCodeInitialContext(currentEntry, chunk),
  );
  const matchedRepo = await matchRepoForCwdOrGitRemote(parsed.cwd, repos, options);
  let result;
  if (!matchedRepo) {
    result = {
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
    };
  } else {
    result = {
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
      ...(await ingestParsedClaudeCodeFile(app, parsed, {
        ...options,
        scope: 'repo',
        scopeKey: matchedRepo.scopeKey,
        repoPath: undefined,
        cwd: undefined,
      })),
    };
  }
  state.entries[file] = {
    offset: chunk.nextOffset,
    lineNumber: chunk.nextLineNumber,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    nativeSessionId: parsed.nativeSessionId,
    cwd: parsed.cwd,
    size: chunk.stat.size,
    mtimeMs: chunk.stat.mtimeMs,
    matchedRepo: result.matchedRepo || null,
    updatedAt: new Date().toISOString(),
  };
  return { result, stateUpdated: true };
}

export async function ingestClaudeCodeRoutedSessionsIncremental(app, options = {}) {
  const repos = await loadRepoRegistry(options, { adapter: 'claude_code', label: 'Claude Code' });
  const projectsDir = path.resolve(options.projectsDir || options.sessionsDir || defaultProjectsDir());
  const descriptor = await buildWatchStateDescriptor({
    adapter: 'claude_code',
    routed: true,
    rootDir: projectsDir,
    options,
    registry: repos,
  });
  const { state, stateLoaded, corruptFile } = await loadWatchState(descriptor);
  const files = options.file ? [options.file] : await discoverClaudeCodeFiles(options);
  const results = [];
  let stateUpdated = false;
  for (const file of files) {
    const processed = await processIncrementalRoutedClaudeCodeFile(app, file, options, repos, state);
    results.push(processed.result);
    stateUpdated = stateUpdated || processed.stateUpdated;
  }
  if (stateUpdated) {
    await saveWatchState(descriptor, state);
  }
  return {
    source: 'claude_code_sessions_router',
    projectsDir,
    registry: path.resolve(options.repoRegistry || options.registry || options.repoRegistryFile),
    repos: repos.map((repo) => ({ name: repo.name, repoPath: repo.repoPath, scopeKey: repo.scopeKey })),
    filesScanned: files.length,
    filesChanged: results.filter((result) => !result.unchanged).length,
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.filter((result) => result.checkpoint).length,
    routedFiles: results.filter((result) => result.matchedRepo).length,
    skippedFiles: results.filter((result) => result.skipped).length,
    stateFile: descriptor.stateFile,
    stateLoaded,
    stateUpdated,
    corruptStateFile: corruptFile,
    fileResults: results,
  };
}

export async function watchClaudeCodeSessions(app, options = {}) {
  if (options.watchFullScan) {
    return watchClaudeCodeSessionsFullScan(app, options);
  }
  const intervalMs =
    options.intervalMs == null ? DEFAULT_WATCH_INTERVAL_MS : Math.max(0, Number(options.intervalMs));
  const maxIterations = options.iterations == null ? null : Math.max(0, Number(options.iterations));
  const startedAt = new Date().toISOString();
  const results = [];
  const totals = createWatchTotals();
  let iterations = 0;
  let stopped = false;
  const sleeper = createInterruptibleSleep();

  const stop = () => {
    stopped = true;
    sleeper.stop();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopped && (maxIterations == null || iterations < maxIterations)) {
      iterations += 1;
      const result = await ingestClaudeCodeSessionsIncremental(app, options);
      const iterationResult = createWatchSummary(
        {
          ...result,
          source: 'claude_code_sessions_watch_iteration',
          iteration: iterations,
          intervalMs,
          watchedAt: new Date().toISOString(),
        },
        options,
      );
      addWatchTotals(totals, iterationResult);
      if (maxIterations != null) {
        results.push(iterationResult);
      }
      if (options.onResult) {
        await options.onResult(iterationResult);
      }
      if (!stopped && (maxIterations == null || iterations < maxIterations)) {
        await sleeper.sleep(intervalMs);
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
    totals,
    results,
  };
}

async function watchClaudeCodeSessionsFullScan(app, options = {}) {
  const intervalMs =
    options.intervalMs == null ? DEFAULT_WATCH_INTERVAL_MS : Math.max(0, Number(options.intervalMs));
  const maxIterations = options.iterations == null ? null : Math.max(0, Number(options.iterations));
  const startedAt = new Date().toISOString();
  const results = [];
  let iterations = 0;
  let stopped = false;
  const sleeper = createInterruptibleSleep();

  const stop = () => {
    stopped = true;
    sleeper.stop();
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
        await sleeper.sleep(intervalMs);
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
    totals: summarizeResults(results),
    results,
  };
}

export async function watchClaudeCodeRoutedSessions(app, options = {}) {
  if (options.watchFullScan) {
    return watchClaudeCodeRoutedSessionsFullScan(app, options);
  }
  const intervalMs =
    options.intervalMs == null ? DEFAULT_WATCH_INTERVAL_MS : Math.max(0, Number(options.intervalMs));
  const maxIterations = options.iterations == null ? null : Math.max(0, Number(options.iterations));
  const startedAt = new Date().toISOString();
  const results = [];
  const totals = createWatchTotals();
  let iterations = 0;
  let stopped = false;
  const sleeper = createInterruptibleSleep();

  const stop = () => {
    stopped = true;
    sleeper.stop();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopped && (maxIterations == null || iterations < maxIterations)) {
      iterations += 1;
      const result = await ingestClaudeCodeRoutedSessionsIncremental(app, options);
      const iterationResult = createWatchSummary(
        {
          ...result,
          source: 'claude_code_sessions_router_watch_iteration',
          iteration: iterations,
          intervalMs,
          watchedAt: new Date().toISOString(),
        },
        options,
      );
      addWatchTotals(totals, iterationResult);
      if (maxIterations != null) {
        results.push(iterationResult);
      }
      if (options.onResult) {
        await options.onResult(iterationResult);
      }
      if (!stopped && (maxIterations == null || iterations < maxIterations)) {
        await sleeper.sleep(intervalMs);
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
    totals,
    results,
  };
}

async function watchClaudeCodeRoutedSessionsFullScan(app, options = {}) {
  const intervalMs =
    options.intervalMs == null ? DEFAULT_WATCH_INTERVAL_MS : Math.max(0, Number(options.intervalMs));
  const maxIterations = options.iterations == null ? null : Math.max(0, Number(options.iterations));
  const startedAt = new Date().toISOString();
  const results = [];
  let iterations = 0;
  let stopped = false;
  const sleeper = createInterruptibleSleep();

  const stop = () => {
    stopped = true;
    sleeper.stop();
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
        await sleeper.sleep(intervalMs);
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
    totals: summarizeResults(results),
    results,
  };
}
