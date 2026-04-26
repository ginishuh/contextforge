import fs from 'node:fs/promises';
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

export function summarizeResults(results) {
  return {
    filesScanned: results.reduce((total, result) => total + result.filesScanned, 0),
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
