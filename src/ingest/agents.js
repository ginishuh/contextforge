import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  addWatchTotals,
  createInterruptibleSleep,
  createWatchTotals,
  discoverFiles,
  ingestParsedSession,
  loadRepoRegistry,
  matchRepoForCwd,
  shouldSkipOutsideRepo,
  summarizeResults,
  truncate,
} from './common.js';
import { discoverClaudeCodeFiles, parseClaudeCodeFile } from './claude_code.js';
import { discoverCodexRolloutFiles, parseCodexRolloutFile } from './codex.js';

const DEFAULT_MAX_CONTENT_CHARS = 8000;

function stripSessionPrefix(prefix, sessionId) {
  const text = String(sessionId || '');
  return text.startsWith(`${prefix}:`) ? text.slice(prefix.length + 1) : text;
}

function prefixedSessionId(prefix, nativeSessionId) {
  const native = stripSessionPrefix(prefix, nativeSessionId);
  return native ? `${prefix}:${native}` : null;
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

function parseJsonLineFile(filePath, text, normalizeRecord, options = {}, initialContext = {}) {
  const lines = text.split(/\r?\n/);
  const events = [];
  const warnings = [];
  const context = {
    filePath,
    lineNumber: 0,
    ...initialContext,
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      // Agent CLIs often append JSONL records while a watcher is reading. Treat
      // only the trailing write window as partial; malformed earlier records
      // still fail loudly.
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
    context.lineNumber += 1;
    const event = normalizeRecord(record, context, options);
    if (event) {
      events.push(event);
    }
  }

  return { context, events, warnings };
}

function encodedCwdFromGrokChatHistory(filePath) {
  const sessionDir = path.dirname(filePath);
  const encodedCwd = path.basename(path.dirname(sessionDir));
  try {
    return decodeURIComponent(encodedCwd);
  } catch {
    return null;
  }
}

function normalizeGrokRecord(record, context, options = {}) {
  if (record.type !== 'user' && record.type !== 'assistant') {
    return null;
  }
  const content = truncate(textFromContent(record.content), options.maxContentChars || DEFAULT_MAX_CONTENT_CHARS);
  if (!content.text) {
    return null;
  }
  return {
    role: record.type,
    content: content.text,
    metadata: {
      source: 'grok_chat_history_jsonl',
      sourceAgent: 'grok',
      sourceRuntime: 'grok_cli',
      sourceAdapter: 'grok_chat_history_jsonl',
      nativeSessionId: context.nativeSessionId,
      ingestId: `grok:${context.nativeSessionId || 'unknown'}:${context.lineNumber}`,
      recordType: record.type,
      modelId: record.model_id || null,
      truncated: content.truncated,
      sourceFile: context.filePath,
    },
  };
}

export async function parseGrokChatHistoryFile(filePath, options = {}) {
  const text = await fs.readFile(filePath, 'utf8');
  const nativeSessionId = path.basename(path.dirname(filePath));
  const sessionId = prefixedSessionId('grok', options.sessionId || nativeSessionId);
  const parsed = parseJsonLineFile(filePath, text, normalizeGrokRecord, options, {
    nativeSessionId: stripSessionPrefix('grok', options.sessionId || nativeSessionId),
    sessionId,
    conversationId: sessionId,
    cwd: options.cwd || encodedCwdFromGrokChatHistory(filePath),
  });
  return {
    nativeSessionId: parsed.context.nativeSessionId,
    sessionId: parsed.context.sessionId,
    conversationId: parsed.context.conversationId,
    cwd: parsed.context.cwd,
    events: parsed.events,
    warnings: parsed.warnings,
  };
}

function defaultGrokSessionsDir() {
  return path.join(os.homedir(), '.grok', 'sessions');
}

export async function discoverGrokChatHistoryFiles(options = {}) {
  const sessionsDir = path.resolve(options.grokSessionsDir || options.sessionsDir || defaultGrokSessionsDir());
  return discoverFiles(sessionsDir, options, (file) => path.basename(file) === 'chat_history.jsonl');
}

function cursorProjectNameFromTranscript(filePath) {
  const marker = `${path.sep}agent-transcripts${path.sep}`;
  const index = filePath.indexOf(marker);
  if (index < 0) {
    return null;
  }
  return path.basename(filePath.slice(0, index)) || null;
}

function cursorProjectCwd(filePath, options = {}) {
  if (options.cwd) {
    return options.cwd;
  }
  return null;
}

function cursorProjectNameForRepoPath(repoPath) {
  return path
    .resolve(repoPath)
    .split(path.sep)
    .filter(Boolean)
    .join('-');
}

function matchCursorRepo(unit, parsed, repos) {
  const matched = matchRepoForCwd(parsed.cwd, repos);
  if (matched) {
    return matched;
  }
  const projectName = unit.cursorProjectName || (unit.file ? cursorProjectNameFromTranscript(unit.file) : null);
  if (!projectName) {
    return null;
  }
  const matches = repos.filter((repo) => cursorProjectNameForRepoPath(repo.repoPath) === projectName);
  matches.sort((a, b) => b.repoPath.length - a.repoPath.length || a.name.localeCompare(b.name));
  return matches[0] || null;
}

function normalizeCursorRecord(record, context, options = {}) {
  const role = record.role;
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }
  const content = truncate(textFromContent(record.message?.content ?? record.content), options.maxContentChars || DEFAULT_MAX_CONTENT_CHARS);
  if (!content.text) {
    return null;
  }
  return {
    role,
    content: content.text,
    metadata: {
      source: 'cursor_agent_transcript_jsonl',
      sourceAgent: 'cursor_cli',
      sourceRuntime: 'cursor_cli',
      sourceAdapter: 'cursor_agent_transcript_jsonl',
      nativeSessionId: context.nativeSessionId,
      ingestId: `cursor-cli:${context.nativeSessionId || 'unknown'}:${record.id || context.lineNumber}`,
      recordType: record.type || null,
      cursorRole: role,
      truncated: content.truncated,
      sourceFile: context.filePath,
    },
  };
}

export async function parseCursorTranscriptFile(filePath, options = {}) {
  const text = await fs.readFile(filePath, 'utf8');
  const nativeSessionId = path.basename(path.dirname(filePath)) || path.basename(filePath, '.jsonl');
  const sessionId = prefixedSessionId('cursor_cli', options.sessionId || nativeSessionId);
  const parsed = parseJsonLineFile(filePath, text, normalizeCursorRecord, options, {
    nativeSessionId: stripSessionPrefix('cursor_cli', options.sessionId || nativeSessionId),
    sessionId,
    conversationId: sessionId,
    cwd: cursorProjectCwd(filePath, options),
    cursorProjectName: cursorProjectNameFromTranscript(filePath),
  });
  return {
    nativeSessionId: parsed.context.nativeSessionId,
    sessionId: parsed.context.sessionId,
    conversationId: parsed.context.conversationId,
    cwd: parsed.context.cwd,
    cursorProjectName: parsed.context.cursorProjectName,
    events: parsed.events,
    warnings: parsed.warnings,
  };
}

function defaultCursorProjectsDir() {
  return path.join(os.homedir(), '.cursor', 'projects');
}

export async function discoverCursorTranscriptFiles(options = {}) {
  const projectsDir = path.resolve(options.cursorProjectsDir || options.projectsDir || defaultCursorProjectsDir());
  return discoverFiles(projectsDir, options, (file) => file.endsWith('.jsonl') && file.includes(`${path.sep}agent-transcripts${path.sep}`));
}

function defaultOpenCodeDbPath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function parseMaybeJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function opencodeMessageCwd(sessionRow, messageData) {
  return messageData?.path?.cwd || messageData?.path?.root || sessionRow.directory || sessionRow.path || null;
}

function textFromOpenCodeParts(parts) {
  return parts
    .map((part) => parseMaybeJson(part.data, {}))
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n\n');
}

export async function discoverOpenCodeSessions(options = {}) {
  const dbPath = path.resolve(options.opencodeDb || options.db || defaultOpenCodeDbPath());
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const sinceMs = options.sinceMinutes == null ? null : Date.now() - Number(options.sinceMinutes) * 60 * 1000;
    const limitSql = options.scanLimit == null ? '' : ' limit ?';
    const params = sinceMs == null ? [] : [sinceMs];
    const rows = db
      .prepare(
        `select id, directory, title, agent, model, time_created, time_updated from session${
          sinceMs == null ? '' : ' where time_updated >= ?'
        } order by time_updated asc${limitSql}`,
      )
      .all(...(options.scanLimit == null ? params : [...params, Number(options.scanLimit)]));
    return rows.map((row) => ({
      dbPath,
      nativeSessionId: row.id,
      cwd: row.directory || null,
      title: row.title || null,
    }));
  } finally {
    db.close();
  }
}

export async function parseOpenCodeSession(unit, options = {}) {
  const db = new Database(unit.dbPath, { readonly: true, fileMustExist: true });
  try {
    const sessionRow = db.prepare('select * from session where id = ?').get(unit.nativeSessionId);
    if (!sessionRow) {
      throw new Error(`OpenCode session not found: ${unit.nativeSessionId}`);
    }
    const nativeSessionId = stripSessionPrefix('opencode', options.sessionId || sessionRow.id);
    const sessionId = prefixedSessionId('opencode', nativeSessionId);
    const messageRows = db
      .prepare('select id, data, time_created, time_updated from message where session_id = ? order by time_created asc, id asc')
      .all(sessionRow.id);
    const partStmt = db.prepare('select data from part where message_id = ? order by time_created asc, id asc');
    const events = [];
    let cwd = options.cwd || sessionRow.directory || sessionRow.path || null;

    for (const messageRow of messageRows) {
      const messageData = parseMaybeJson(messageRow.data, {});
      const role = messageData.role;
      if (role !== 'user' && role !== 'assistant') {
        continue;
      }
      cwd = cwd || opencodeMessageCwd(sessionRow, messageData);
      const content = truncate(textFromOpenCodeParts(partStmt.all(messageRow.id)), options.maxContentChars || DEFAULT_MAX_CONTENT_CHARS);
      if (!content.text) {
        continue;
      }
      events.push({
        role,
        content: content.text,
        metadata: {
          source: 'opencode_sqlite',
          sourceAgent: 'opencode',
          sourceRuntime: 'opencode_cli',
          sourceAdapter: 'opencode_sqlite',
          nativeSessionId,
          ingestId: `opencode:${nativeSessionId}:${messageRow.id}`,
          messageId: messageRow.id,
          agent: messageData.agent || sessionRow.agent || null,
          modelId: messageData.modelID || parseMaybeJson(sessionRow.model, {})?.id || null,
          providerId: messageData.providerID || parseMaybeJson(sessionRow.model, {})?.providerID || null,
          truncated: content.truncated,
          sourceFile: unit.dbPath,
        },
      });
    }

    return {
      nativeSessionId,
      sessionId,
      conversationId: sessionId,
      cwd,
      events,
      warnings: [],
    };
  } finally {
    db.close();
  }
}

export const AGENT_ADAPTERS = Object.freeze({
  codex: {
    id: 'codex',
    displayName: 'Codex',
    source: 'codex_rollout_jsonl',
    summarySource: 'codex_sessions',
    routerSource: 'codex_sessions_router',
    rootSummaryKey: 'sessionsDir',
    rootPath: (options = {}) => path.resolve(options.codexSessionsDir || options.sessionsDir || path.join(os.homedir(), '.codex', 'sessions')),
    discover: async (options = {}) => (await discoverCodexRolloutFiles({ ...options, sessionsDir: options.codexSessionsDir || options.sessionsDir })).map((file) => ({ file })),
    parse: (unit, options = {}) => parseCodexRolloutFile(unit.file, options),
    missingSessionMessage: 'Codex rollout session id could not be determined.',
  },
  claude_code: {
    id: 'claude_code',
    displayName: 'Claude Code',
    source: 'claude_code_jsonl',
    summarySource: 'claude_code_sessions',
    routerSource: 'claude_code_sessions_router',
    rootSummaryKey: 'projectsDir',
    rootPath: (options = {}) => path.resolve(options.claudeCodeProjectsDir || options.projectsDir || options.sessionsDir || path.join(os.homedir(), '.claude', 'projects')),
    discover: async (options = {}) =>
      (await discoverClaudeCodeFiles({ ...options, projectsDir: options.claudeCodeProjectsDir || options.projectsDir || options.sessionsDir })).map((file) => ({ file })),
    parse: (unit, options = {}) => parseClaudeCodeFile(unit.file, options),
    missingSessionMessage: 'Claude Code session id could not be determined.',
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    source: 'opencode_sqlite',
    summarySource: 'opencode_sessions',
    routerSource: 'opencode_sessions_router',
    rootSummaryKey: 'dbPath',
    rootPath: (options = {}) => path.resolve(options.opencodeDb || options.db || defaultOpenCodeDbPath()),
    discover: discoverOpenCodeSessions,
    parse: parseOpenCodeSession,
    missingSessionMessage: 'OpenCode session id could not be determined.',
  },
  grok: {
    id: 'grok',
    displayName: 'Grok',
    source: 'grok_chat_history_jsonl',
    summarySource: 'grok_sessions',
    routerSource: 'grok_sessions_router',
    rootSummaryKey: 'sessionsDir',
    rootPath: (options = {}) => path.resolve(options.grokSessionsDir || options.sessionsDir || defaultGrokSessionsDir()),
    discover: async (options = {}) => (await discoverGrokChatHistoryFiles(options)).map((file) => ({ file })),
    parse: (unit, options = {}) => parseGrokChatHistoryFile(unit.file, options),
    missingSessionMessage: 'Grok session id could not be determined.',
  },
  cursor_cli: {
    id: 'cursor_cli',
    displayName: 'Cursor CLI',
    source: 'cursor_agent_transcript_jsonl',
    summarySource: 'cursor_cli_sessions',
    routerSource: 'cursor_cli_sessions_router',
    rootSummaryKey: 'projectsDir',
    rootPath: (options = {}) => path.resolve(options.cursorProjectsDir || options.projectsDir || defaultCursorProjectsDir()),
    discover: async (options = {}) =>
      (await discoverCursorTranscriptFiles(options)).map((file) => ({
        file,
        cursorProjectName: cursorProjectNameFromTranscript(file),
      })),
    parse: (unit, options = {}) => parseCursorTranscriptFile(unit.file, options),
    matchRepo: matchCursorRepo,
    missingSessionMessage: 'Cursor CLI session id could not be determined.',
  },
});

export function listAgentAdapters() {
  return Object.values(AGENT_ADAPTERS).map((adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    source: adapter.source,
    summarySource: adapter.summarySource,
  }));
}

export function normalizeAgentAdapterIds(value) {
  if (value == null || value === true) {
    return Object.keys(AGENT_ADAPTERS);
  }
  const items = Array.isArray(value) ? value : String(value).split(',');
  const ids = [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
  for (const id of ids) {
    if (!AGENT_ADAPTERS[id]) {
      throw new Error(`Unknown agent adapter: ${id}`);
    }
  }
  return ids;
}

async function ingestParsedForAdapter(app, adapter, unit, parsed, options = {}) {
  if (!parsed.sessionId) {
    throw new Error(adapter.missingSessionMessage);
  }
  if (shouldSkipOutsideRepo(parsed, options)) {
    return {
      source: adapter.source,
      file: unit.file,
      dbPath: unit.dbPath,
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
  const result = await ingestParsedSession(app, parsed, options, {
    missingSessionMessage: adapter.missingSessionMessage,
  });
  return {
    source: adapter.source,
    file: unit.file,
    dbPath: unit.dbPath,
    sessionId: parsed.sessionId,
    conversationId: parsed.conversationId,
    warnings: parsed.warnings,
    ...result,
  };
}

function summarizeAdapterResult(adapter, rootPath, results) {
  return {
    source: adapter.summarySource,
    adapter: adapter.id,
    [adapter.rootSummaryKey]: rootPath,
    filesScanned: results.length,
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.filter((result) => result.checkpoint).length,
    fileResults: results,
  };
}

export async function ingestAgentSessions(app, options = {}) {
  const adapterIds = normalizeAgentAdapterIds(options.adapters || options.adapter);
  const adapterResults = [];
  for (const adapterId of adapterIds) {
    const adapter = AGENT_ADAPTERS[adapterId];
    if (options.file && adapter.rootSummaryKey !== 'sessionsDir' && adapter.rootSummaryKey !== 'projectsDir') {
      throw new Error(`--file is not supported for ${adapter.id}; use the adapter-specific root option instead.`);
    }
    const rootPath = adapter.rootPath(options);
    const units = options.file ? [{ file: options.file }] : await adapter.discover(options);
    const results = [];
    for (const unit of units) {
      const parsed = await adapter.parse(unit, options);
      results.push(await ingestParsedForAdapter(app, adapter, unit, parsed, options));
    }
    adapterResults.push(summarizeAdapterResult(adapter, rootPath, results));
  }
  const totals = summarizeResults(adapterResults);
  return {
    source: 'agent_sessions',
    adapters: adapterIds,
    adapterResults,
    ...totals,
    checkpointsCreated: adapterResults.reduce((total, result) => total + result.checkpointsCreated, 0),
  };
}

async function ingestRoutedAdapter(app, adapter, options = {}) {
  const repos = await loadRepoRegistry(options, { adapter: adapter.id, label: adapter.displayName });
  const rootPath = adapter.rootPath(options);
  if (options.file && adapter.rootSummaryKey !== 'sessionsDir' && adapter.rootSummaryKey !== 'projectsDir') {
    throw new Error(`--file is not supported for ${adapter.id}; use the adapter-specific root option instead.`);
  }
  const units = options.file ? [{ file: options.file }] : await adapter.discover(options);
  const results = [];
  for (const unit of units) {
    const parsed = await adapter.parse(unit, options);
    const matchedRepo = adapter.matchRepo ? adapter.matchRepo(unit, parsed, repos) : matchRepoForCwd(parsed.cwd, repos);
    if (!matchedRepo) {
      results.push({
        source: adapter.source,
        file: unit.file,
        dbPath: unit.dbPath,
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
    const result = await ingestParsedSession(
      app,
      parsed,
      {
        ...options,
        scope: 'repo',
        scopeKey: matchedRepo.scopeKey,
        repoPath: undefined,
        cwd: undefined,
      },
      { missingSessionMessage: adapter.missingSessionMessage },
    );
    results.push({
      source: adapter.source,
      file: unit.file,
      dbPath: unit.dbPath,
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
    source: adapter.routerSource,
    adapter: adapter.id,
    [adapter.rootSummaryKey]: rootPath,
    registry: path.resolve(options.repoRegistry || options.registry || options.repoRegistryFile),
    repos: repos.map((repo) => ({
      name: repo.name,
      repoPath: repo.repoPath,
      scopeKey: repo.scopeKey,
    })),
    filesScanned: units.length,
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.filter((result) => result.checkpoint).length,
    routedFiles: results.filter((result) => result.matchedRepo).length,
    skippedFiles: results.filter((result) => result.skipped).length,
    fileResults: results,
  };
}

export async function ingestAgentRoutedSessions(app, options = {}) {
  const adapterIds = normalizeAgentAdapterIds(options.adapters || options.adapter);
  const adapterResults = [];
  for (const adapterId of adapterIds) {
    adapterResults.push(await ingestRoutedAdapter(app, AGENT_ADAPTERS[adapterId], options));
  }
  return {
    source: 'agent_sessions_router',
    adapters: adapterIds,
    registry: path.resolve(options.repoRegistry || options.registry || options.repoRegistryFile),
    adapterResults,
    filesScanned: adapterResults.reduce((total, result) => total + result.filesScanned, 0),
    parsedEvents: adapterResults.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: adapterResults.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: adapterResults.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: adapterResults.reduce((total, result) => total + result.checkpointsCreated, 0),
    routedFiles: adapterResults.reduce((total, result) => total + result.routedFiles, 0),
    skippedFiles: adapterResults.reduce((total, result) => total + result.skippedFiles, 0),
  };
}

export async function watchAgentRoutedSessions(app, options = {}) {
  const intervalMs = options.intervalMs == null ? 30000 : Math.max(0, Number(options.intervalMs));
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
      const result = await ingestAgentRoutedSessions(app, options);
      const iterationResult = {
        ...result,
        source: 'agent_sessions_router_watch_iteration',
        iteration: iterations,
        intervalMs,
        watchedAt: new Date().toISOString(),
      };
      addWatchTotals(totals, iterationResult);
      if (maxIterations != null) {
        results.push(options.watchVerbose ? iterationResult : { ...iterationResult, adapterResults: undefined });
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
    source: 'agent_sessions_router_watch',
    adapters: normalizeAgentAdapterIds(options.adapters || options.adapter),
    intervalMs,
    iterations,
    stopped,
    startedAt,
    completedAt: new Date().toISOString(),
    totals,
    results,
  };
}
