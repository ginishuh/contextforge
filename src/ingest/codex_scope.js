import { matchRepoForCwdOrGitRemote } from './common.js';

export function rewindForPendingCodexUser(chunk, currentEntry, parsed) {
  if (!parsed.pendingUserLineNumber) return null;
  const startLine = chunk.reset ? 0 : Number(currentEntry.lineNumber || 0);
  const pendingIndex = parsed.pendingUserLineNumber - startLine - 1;
  if (pendingIndex < 0 || pendingIndex >= chunk.lines.length) return null;
  const consumedBytes = chunk.lineByteLengths
    ? chunk.lineByteLengths.slice(0, pendingIndex).reduce((total, length) => total + length, 0)
    : Buffer.byteLength(`${chunk.lines.slice(0, pendingIndex).join('\n')}${pendingIndex ? '\n' : ''}`);
  return {
    offset: (chunk.reset ? 0 : chunk.previousOffset) + consumedBytes,
    lineNumber: parsed.pendingUserLineNumber - 1,
  };
}

function repoResult(repo) {
  return {
    name: repo.name,
    repoPath: repo.repoPath,
    scopeKey: repo.scopeKey,
  };
}

export async function splitCodexEventsByRepo(parsed, repos, options = {}) {
  const groups = new Map();
  const matches = new Map();
  let unroutedEvents = 0;
  for (const event of parsed.events) {
    const cwd = event.metadata?.cwd || null;
    const cacheKey = cwd || '';
    if (!matches.has(cacheKey)) {
      matches.set(cacheKey, matchRepoForCwdOrGitRemote(cwd, repos, options));
    }
    const repo = await matches.get(cacheKey);
    if (!repo) {
      unroutedEvents += 1;
      continue;
    }
    const key = repo.scopeKey;
    const group = groups.get(key) || {
      parsed: {
        ...parsed,
        cwd,
        events: [],
      },
      matchedRepo: repoResult(repo),
    };
    group.parsed.events.push(event);
    groups.set(key, group);
  }
  return { groups: [...groups.values()], unroutedEvents };
}

export function aggregateCodexScopeResults(scopeResults, unroutedEvents = 0) {
  return {
    parsedEvents: scopeResults.reduce((total, item) => total + item.parsedEvents, 0) + unroutedEvents,
    appendedEvents: scopeResults.reduce((total, item) => total + item.appendedEvents, 0),
    skippedEvents: scopeResults.reduce((total, item) => total + item.skippedEvents, 0) + unroutedEvents,
    checkpointsCreated: scopeResults.filter((item) => item.checkpoint).length,
    unroutedEvents,
  };
}
