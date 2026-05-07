import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function isPathWithin(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizeAdapterList(adapters) {
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

export async function loadRepoRegistry(options = {}, { adapter, label = adapter } = {}) {
  const registryPath = options.repoRegistry || options.registry || options.repoRegistryFile;
  if (!registryPath) {
    throw new Error(`--repoRegistry is required for routed ${label} ingest.`);
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
    .filter((repo) => !repo.adapters || repo.adapters.includes(adapter));
}

export function matchRepoForCwd(cwd, repos) {
  if (!cwd) {
    return null;
  }
  const matches = repos.filter((repo) => isPathWithin(repo.repoPath, cwd));
  matches.sort((a, b) => b.repoPath.length - a.repoPath.length || a.name.localeCompare(b.name));
  return matches[0] || null;
}

export function shouldSkipOutsideRepo(parsed, options = {}) {
  return Boolean(options.repoPath && parsed.cwd && !isPathWithin(options.repoPath, parsed.cwd));
}

export async function shouldSkipRecentFailedAutoDistill(app, scopeOptions, sessionId, status) {
  const runs = await app.listDistillRuns({
    ...scopeOptions,
    sessionId,
  });
  const latest = runs.at(-1);
  if (!latest || latest.status !== 'failed') {
    return false;
  }
  const failedAt = Date.parse(latest.completedAt || latest.createdAt);
  if (!Number.isFinite(failedAt)) {
    return false;
  }
  return Date.now() - failedAt < status.thresholds.minIntervalMs;
}

export function truncate(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n[truncated]`, truncated: true };
}

export async function appendNewEvents(app, scopeOptions, parsed) {
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

export async function ingestParsedSession(app, parsed, options = {}, { missingSessionMessage }) {
  if (!parsed.sessionId) {
    throw new Error(missingSessionMessage);
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

export async function walkFiles(rootDir) {
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

export async function discoverFiles(rootDir, options = {}, predicate = () => true) {
  const files = (await walkFiles(rootDir)).filter(predicate);
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

export function resolveWatchStateDir(options = {}) {
  return path.resolve(
    options.watchStateDir ||
      process.env.CONTEXTFORGE_WATCH_STATE_DIR ||
      path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'contextforge', 'watch'),
  );
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export async function buildWatchStateDescriptor({ adapter, routed = false, rootDir, options = {}, registry = null }) {
  const root = path.resolve(rootDir);
  let registryFingerprint = null;
  if (routed) {
    const registryPath = path.resolve(options.repoRegistry || options.registry || options.repoRegistryFile);
    let registryText = '';
    try {
      registryText = await fs.readFile(registryPath, 'utf8');
    } catch {
      registryText = JSON.stringify(registry || []);
    }
    registryFingerprint = {
      path: registryPath,
      hash: digest(registryText).slice(0, 16),
    };
  }
  const scopeFingerprint = routed
    ? registryFingerprint
    : {
        scope: options.scope || null,
        scopeKey: options.scopeKey || null,
        repoPath: options.repoPath ? path.resolve(options.repoPath) : null,
      };
  const fingerprint = digest(JSON.stringify({ adapter, routed, root, scopeFingerprint })).slice(0, 24);
  const mode = routed ? 'routed' : 'direct';
  const fileName = `${adapter}-${mode}-${fingerprint}.json`;
  const stateDir = resolveWatchStateDir(options);
  return {
    adapter,
    routed,
    mode,
    rootDir: root,
    registry: registryFingerprint,
    scopeFingerprint,
    fingerprint,
    stateDir,
    stateFile: path.join(stateDir, fileName),
  };
}

export async function loadWatchState(descriptor) {
  let stateLoaded = false;
  let corruptFile = null;
  try {
    const text = await fs.readFile(descriptor.stateFile, 'utf8');
    const parsed = JSON.parse(text);
    if (
      parsed?.version !== 1 ||
      parsed.adapter !== descriptor.adapter ||
      parsed.mode !== descriptor.mode ||
      parsed.fingerprint !== descriptor.fingerprint ||
      !parsed.entries ||
      typeof parsed.entries !== 'object'
    ) {
      throw new Error('watch state descriptor mismatch');
    }
    stateLoaded = true;
    return { state: parsed, stateLoaded, corruptFile };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        state: {
          version: 1,
          adapter: descriptor.adapter,
          mode: descriptor.mode,
          rootDir: descriptor.rootDir,
          registry: descriptor.registry,
          scopeFingerprint: descriptor.scopeFingerprint,
          fingerprint: descriptor.fingerprint,
          entries: {},
          createdAt: new Date().toISOString(),
          updatedAt: null,
        },
        stateLoaded,
        corruptFile,
      };
    }
    await fs.mkdir(path.dirname(descriptor.stateFile), { recursive: true });
    corruptFile = `${descriptor.stateFile}.corrupt-${Date.now()}`;
    try {
      await fs.rename(descriptor.stateFile, corruptFile);
    } catch {
      corruptFile = null;
    }
    return {
      state: {
        version: 1,
        adapter: descriptor.adapter,
        mode: descriptor.mode,
        rootDir: descriptor.rootDir,
        registry: descriptor.registry,
        scopeFingerprint: descriptor.scopeFingerprint,
        fingerprint: descriptor.fingerprint,
        entries: {},
        createdAt: new Date().toISOString(),
        updatedAt: null,
      },
      stateLoaded,
      corruptFile,
    };
  }
}

export async function saveWatchState(descriptor, state) {
  await fs.mkdir(path.dirname(descriptor.stateFile), { recursive: true });
  const updated = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  const tempFile = `${descriptor.stateFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(updated, null, 2)}\n`);
  await fs.rename(tempFile, descriptor.stateFile);
  state.updatedAt = updated.updatedAt;
}

export async function readIncrementalJsonl(file, stateEntry = {}) {
  const stat = await fs.stat(file);
  const previousOffset = Number.isFinite(Number(stateEntry.offset)) ? Number(stateEntry.offset) : 0;
  const previousLineNumber = Number.isFinite(Number(stateEntry.lineNumber)) ? Number(stateEntry.lineNumber) : 0;
  const reset = stat.size < previousOffset;
  const readOffset = reset ? 0 : previousOffset;
  const startLineNumber = reset ? 0 : previousLineNumber;
  if (stat.size === readOffset) {
    return {
      file,
      stat,
      changed: false,
      reset,
      lines: [],
      completeBytes: 0,
      nextOffset: readOffset,
      nextLineNumber: startLineNumber,
      hasPartialLine: false,
      previousOffset,
    };
  }

  const handle = await fs.open(file, 'r');
  try {
    const length = stat.size - readOffset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, readOffset);
    const text = buffer.toString('utf8');
    const lastNewline = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    if (lastNewline < 0) {
      return {
        file,
        stat,
        changed: true,
        reset,
        lines: [],
        completeBytes: 0,
        nextOffset: readOffset,
        nextLineNumber: startLineNumber,
        hasPartialLine: text.length > 0,
        previousOffset,
      };
    }
    const completeText = text.slice(0, lastNewline + 1);
    const lines = completeText.split(/\r?\n/);
    if (lines.at(-1) === '') {
      lines.pop();
    }
    const completeBytes = Buffer.byteLength(completeText);
    return {
      file,
      stat,
      changed: true,
      reset,
      lines,
      completeBytes,
      nextOffset: readOffset + completeBytes,
      nextLineNumber: startLineNumber + lines.length,
      hasPartialLine: readOffset + completeBytes < stat.size,
      previousOffset,
    };
  } finally {
    await handle.close();
  }
}

export function createWatchSummary(result, options = {}) {
  const summary = {
    source: result.source,
    iteration: result.iteration,
    intervalMs: result.intervalMs,
    watchedAt: result.watchedAt,
    sessionsDir: result.sessionsDir,
    projectsDir: result.projectsDir,
    registry: result.registry,
    scope: result.scope,
    scopeKey: result.scopeKey,
    filesScanned: result.filesScanned || 0,
    filesChanged: result.filesChanged || 0,
    parsedEvents: result.parsedEvents || 0,
    appendedEvents: result.appendedEvents || 0,
    skippedEvents: result.skippedEvents || 0,
    checkpointsCreated: result.checkpointsCreated || 0,
    routedFiles: result.routedFiles || 0,
    skippedFiles: result.skippedFiles || 0,
    stateFile: result.stateFile,
    stateLoaded: Boolean(result.stateLoaded),
    stateUpdated: Boolean(result.stateUpdated),
  };
  if (result.corruptStateFile) {
    summary.corruptStateFile = result.corruptStateFile;
  }
  if (options.watchVerbose) {
    summary.fileResults = result.fileResults || [];
  }
  return summary;
}

export function createWatchTotals() {
  return {
    filesScanned: 0,
    filesChanged: 0,
    parsedEvents: 0,
    appendedEvents: 0,
    skippedEvents: 0,
    checkpointsCreated: 0,
    routedFiles: 0,
    skippedFiles: 0,
  };
}

export function addWatchTotals(totals, result = {}) {
  for (const key of Object.keys(totals)) {
    totals[key] += Number(result[key] || 0);
  }
  return totals;
}

export function summarizeResults(results) {
  return {
    filesScanned: results.reduce((total, result) => total + result.filesScanned, 0),
    filesChanged: results.reduce((total, result) => total + (result.filesChanged || 0), 0),
    parsedEvents: results.reduce((total, result) => total + result.parsedEvents, 0),
    appendedEvents: results.reduce((total, result) => total + result.appendedEvents, 0),
    skippedEvents: results.reduce((total, result) => total + result.skippedEvents, 0),
    checkpointsCreated: results.reduce((total, result) => total + result.checkpointsCreated, 0),
  };
}

export function createInterruptibleSleep() {
  let resolveSleep = null;
  return {
    stop() {
      if (resolveSleep) {
        resolveSleep();
        resolveSleep = null;
      }
    },
    sleep(ms) {
      return new Promise((resolve) => {
        if (ms <= 0) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          resolveSleep = null;
          resolve();
        }, ms);
        resolveSleep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}
