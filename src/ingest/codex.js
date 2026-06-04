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
  matchRepoForCwd,
  readIncrementalJsonl,
  saveWatchState,
  shouldSkipOutsideRepo,
  summarizeResults,
  truncate,
} from './common.js';

const DEFAULT_MAX_CONTENT_CHARS = 8000;
const DEFAULT_WATCH_INTERVAL_MS = 30000;
const CODEX_AGENT_PROVENANCE = {
  sourceAgent: 'codex',
  sourceRuntime: 'codex_tui',
  sourceAdapter: 'codex_rollout_jsonl',
};

function stripCodexSessionPrefix(sessionId) {
  const text = String(sessionId || '');
  return text.startsWith('codex:') ? text.slice('codex:'.length) : text;
}

function codexSessionId(nativeSessionId) {
  const native = stripCodexSessionPrefix(nativeSessionId);
  return native ? `codex:${native}` : null;
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
      return item.text || item.input_text || item.output_text || '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function normalizeCodexRolloutRecord(record, context, options = {}) {
  if (record.type === 'session_meta') {
    const nativeSessionId = record.payload?.id;
    context.nativeSessionId = context.nativeSessionId || nativeSessionId;
    context.sessionId = context.sessionId || codexSessionId(nativeSessionId);
    context.conversationId = context.conversationId || codexSessionId(nativeSessionId);
    context.cwd = context.cwd || record.payload?.cwd || null;
    return null;
  }

  if (record.type !== 'response_item') {
    return null;
  }

  const payload = record.payload || {};
  let normalized = null;
  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    normalized = {
      role: payload.role,
      content: textFromContent(payload.content),
    };
  }

  if (!normalized?.content) {
    return null;
  }

  const content = truncate(normalized.content, options.maxContentChars || DEFAULT_MAX_CONTENT_CHARS);
  return {
    role: normalized.role,
    content: content.text,
    metadata: {
      source: 'codex_rollout_jsonl',
      ...CODEX_AGENT_PROVENANCE,
      nativeSessionId: context.nativeSessionId || stripCodexSessionPrefix(context.sessionId) || null,
      ingestId: `codex-rollout:${context.nativeSessionId || stripCodexSessionPrefix(context.sessionId) || 'unknown'}:${
        context.lineNumber
      }`,
      recordType: record.type,
      payloadType: payload.type || null,
      codexRole: payload.role || null,
      rolloutTimestamp: record.timestamp || null,
      truncated: content.truncated,
      sourceFile: context.filePath || null,
    },
  };
}

export function parseCodexRolloutLines(filePath, lines, options = {}, initialContext = {}) {
  const nativeSessionId =
    initialContext.nativeSessionId || (options.sessionId ? stripCodexSessionPrefix(options.sessionId) : null);
  const sessionId = initialContext.sessionId || (nativeSessionId ? codexSessionId(nativeSessionId) : null);
  const context = {
    filePath,
    nativeSessionId,
    sessionId,
    conversationId:
      initialContext.conversationId || (options.conversationId ? codexSessionId(options.conversationId) : sessionId),
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
    const event = normalizeCodexRolloutRecord(record, context, options);
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

export async function parseCodexRolloutFile(filePath, options = {}) {
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
  const parsed = parseCodexRolloutLines(filePath, completeLines, options);

  return {
    nativeSessionId: parsed.nativeSessionId,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    cwd: parsed.cwd,
    events: parsed.events,
    warnings,
  };
}

async function ingestParsedCodexRollout(app, parsed, options = {}) {
  return ingestParsedSession(app, parsed, options, {
    missingSessionMessage: 'Codex rollout session id could not be determined.',
  });
}

export async function ingestCodexRolloutFile(app, options = {}) {
  if (!options.file) {
    throw new Error('file is required.');
  }
  const parsed = await parseCodexRolloutFile(options.file, options);
  if (!parsed.sessionId) {
    throw new Error('Codex rollout session id could not be determined.');
  }
  if (shouldSkipOutsideRepo(parsed, options)) {
    return {
      source: 'codex_rollout_jsonl',
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
  const result = await ingestParsedCodexRollout(app, parsed, options);

  return {
    source: 'codex_rollout_jsonl',
    file: options.file,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    warnings: parsed.warnings,
    ...result,
  };
}

function defaultSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export async function discoverCodexRolloutFiles(options = {}) {
  const sessionsDir = path.resolve(options.sessionsDir || defaultSessionsDir());
  return discoverFiles(
    sessionsDir,
    options,
    (file) => path.basename(file).startsWith('rollout-') && file.endsWith('.jsonl'),
  );
}

export async function ingestCodexSessions(app, options = {}) {
  const files = options.file ? [options.file] : await discoverCodexRolloutFiles(options);
  const results = [];
  for (const file of files) {
    results.push(await ingestCodexRolloutFile(app, { ...options, file }));
  }

  return {
    source: 'codex_sessions',
    sessionsDir: path.resolve(options.sessionsDir || defaultSessionsDir()),
    filesScanned: files.length,
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.filter((result) => result.checkpoint).length,
    fileResults: results,
  };
}

export async function ingestCodexRoutedSessions(app, options = {}) {
  const repos = await loadRepoRegistry(options, { adapter: 'codex', label: 'Codex' });
  const files = options.file ? [options.file] : await discoverCodexRolloutFiles(options);
  const results = [];

  for (const file of files) {
    const parsed = await parseCodexRolloutFile(file, options);
    const matchedRepo = matchRepoForCwd(parsed.cwd, repos);
    if (!matchedRepo) {
      results.push({
        source: 'codex_rollout_jsonl',
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

    const result = await ingestParsedCodexRollout(app, parsed, {
      ...options,
      scope: 'repo',
      scopeKey: matchedRepo.scopeKey,
      repoPath: undefined,
      cwd: undefined,
    });
    results.push({
      source: 'codex_rollout_jsonl',
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
    source: 'codex_sessions_router',
    sessionsDir: path.resolve(options.sessionsDir || defaultSessionsDir()),
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

async function processIncrementalCodexFile(app, file, options, state) {
  const currentEntry = state.entries[file] || {};
  const chunk = await readIncrementalJsonl(file, currentEntry);
  if (!chunk.changed) {
    return {
      result: {
        source: 'codex_rollout_jsonl',
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
        source: 'codex_rollout_jsonl',
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

  const parsed = parseCodexRolloutLines(
    file,
    chunk.lines,
    options,
    chunk.reset
      ? { lineNumber: 0 }
      : {
          nativeSessionId: currentEntry.nativeSessionId,
          sessionId: currentEntry.sessionId,
          conversationId: currentEntry.conversationId,
          cwd: currentEntry.cwd,
          lineNumber: currentEntry.lineNumber || 0,
        },
  );

  if (!parsed.sessionId) {
    throw new Error('Codex rollout session id could not be determined.');
  }

  let result;
  if (shouldSkipOutsideRepo(parsed, options)) {
    result = {
      source: 'codex_rollout_jsonl',
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
      source: 'codex_rollout_jsonl',
      file,
      sessionId: parsed.sessionId,
      conversationId: parsed.conversationId,
      warnings: parsed.warnings,
      ...(await ingestParsedCodexRollout(app, parsed, options)),
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

export async function ingestCodexSessionsIncremental(app, options = {}) {
  const sessionsDir = path.resolve(options.sessionsDir || defaultSessionsDir());
  const descriptor = await buildWatchStateDescriptor({ adapter: 'codex', rootDir: sessionsDir, options });
  const { state, stateLoaded, corruptFile } = await loadWatchState(descriptor);
  const files = options.file ? [options.file] : await discoverCodexRolloutFiles(options);
  const results = [];
  let stateUpdated = false;

  for (const file of files) {
    const processed = await processIncrementalCodexFile(app, file, options, state);
    results.push(processed.result);
    stateUpdated = stateUpdated || processed.stateUpdated;
  }
  if (stateUpdated) {
    await saveWatchState(descriptor, state);
  }

  return {
    source: 'codex_sessions',
    sessionsDir,
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

async function processIncrementalRoutedCodexFile(app, file, options, repos, state) {
  const currentEntry = state.entries[file] || {};
  const chunk = await readIncrementalJsonl(file, currentEntry);
  if (!chunk.changed) {
    return {
      result: {
        source: 'codex_rollout_jsonl',
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
        source: 'codex_rollout_jsonl',
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
  const parsed = parseCodexRolloutLines(
    file,
    chunk.lines,
    options,
    chunk.reset
      ? { lineNumber: 0 }
      : {
          nativeSessionId: currentEntry.nativeSessionId,
          sessionId: currentEntry.sessionId,
          conversationId: currentEntry.conversationId,
          cwd: currentEntry.cwd,
          lineNumber: currentEntry.lineNumber || 0,
        },
  );
  const matchedRepo = matchRepoForCwd(parsed.cwd, repos);
  let result;
  if (!matchedRepo) {
    result = {
      source: 'codex_rollout_jsonl',
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
      source: 'codex_rollout_jsonl',
      file,
      sessionId: parsed.sessionId,
      conversationId: parsed.conversationId,
      warnings: parsed.warnings,
      matchedRepo: {
        name: matchedRepo.name,
        repoPath: matchedRepo.repoPath,
        scopeKey: matchedRepo.scopeKey,
      },
      ...(await ingestParsedCodexRollout(app, parsed, {
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

export async function ingestCodexRoutedSessionsIncremental(app, options = {}) {
  const repos = await loadRepoRegistry(options, { adapter: 'codex', label: 'Codex' });
  const sessionsDir = path.resolve(options.sessionsDir || defaultSessionsDir());
  const descriptor = await buildWatchStateDescriptor({
    adapter: 'codex',
    routed: true,
    rootDir: sessionsDir,
    options,
    registry: repos,
  });
  const { state, stateLoaded, corruptFile } = await loadWatchState(descriptor);
  const files = options.file ? [options.file] : await discoverCodexRolloutFiles(options);
  const results = [];
  let stateUpdated = false;
  for (const file of files) {
    const processed = await processIncrementalRoutedCodexFile(app, file, options, repos, state);
    results.push(processed.result);
    stateUpdated = stateUpdated || processed.stateUpdated;
  }
  if (stateUpdated) {
    await saveWatchState(descriptor, state);
  }
  return {
    source: 'codex_sessions_router',
    sessionsDir,
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

export async function watchCodexSessions(app, options = {}) {
  if (options.watchFullScan) {
    return watchCodexSessionsFullScan(app, options);
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
      const result = await ingestCodexSessionsIncremental(app, options);
      const iterationResult = createWatchSummary(
        {
          ...result,
          source: 'codex_sessions_watch_iteration',
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
    source: 'codex_sessions_watch',
    sessionsDir: path.resolve(options.sessionsDir || defaultSessionsDir()),
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals,
    results,
  };
}

async function watchCodexSessionsFullScan(app, options = {}) {
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
      const result = await ingestCodexSessions(app, options);
      const iterationResult = {
        ...result,
        source: 'codex_sessions_watch_iteration',
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
    source: 'codex_sessions_watch',
    sessionsDir: path.resolve(options.sessionsDir || defaultSessionsDir()),
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals: summarizeResults(results),
    results,
  };
}

export async function watchCodexRoutedSessions(app, options = {}) {
  if (options.watchFullScan) {
    return watchCodexRoutedSessionsFullScan(app, options);
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
      const result = await ingestCodexRoutedSessionsIncremental(app, options);
      const iterationResult = createWatchSummary(
        {
          ...result,
          source: 'codex_sessions_router_watch_iteration',
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
    source: 'codex_sessions_router_watch',
    sessionsDir: path.resolve(options.sessionsDir || defaultSessionsDir()),
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals,
    results,
  };
}

async function watchCodexRoutedSessionsFullScan(app, options = {}) {
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
      const result = await ingestCodexRoutedSessions(app, options);
      const iterationResult = {
        ...result,
        source: 'codex_sessions_router_watch_iteration',
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
    source: 'codex_sessions_router_watch',
    sessionsDir: path.resolve(options.sessionsDir || defaultSessionsDir()),
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals: summarizeResults(results),
    results,
  };
}
