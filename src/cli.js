#!/usr/bin/env node
import { createContextForge } from './core.js';
import { startContextForgeServer } from './server.js';

function parseArgs(argv) {
  const command = argv[2];
  const options = {};
  const positionals = [];

  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      options[name] = true;
    } else if (options[name] == null) {
      options[name] = next;
      i += 1;
    } else if (Array.isArray(options[name])) {
      options[name].push(next);
      i += 1;
    } else {
      options[name] = [options[name], next];
      i += 1;
    }
  }

  return { command, options, positionals };
}

function toCoreOptions(options) {
  const tags = options.tag || options.tags;
  let metadata = {};
  if (options.metadata) {
    try {
      metadata = JSON.parse(options.metadata);
    } catch (error) {
      throw new Error(`Invalid --metadata JSON: ${error.message}`);
    }
  }
  return {
    scope: options.scope,
    scopeKey: options.scopeKey,
    key: options.key,
    content: options.content,
    category: options.category,
    tags: Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',').filter(Boolean) : [],
    importance: options.importance == null ? 0 : Number(options.importance),
    query: options.query,
    limit: options.limit == null ? 10 : Number(options.limit),
    searchScopes: options.searchScopes,
    sharedScopeKey: options.sharedScopeKey,
    sessionId: options.sessionId,
    conversationId: options.conversationId,
    role: options.role,
    provider: options.provider,
    metadata,
    sourceCheckpointId: options.sourceCheckpointId,
    sourceSessionId: options.sourceSessionId,
    sourceRawEventIds: options.sourceRawEventIds
      ? String(options.sourceRawEventIds)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
    sourceCandidateIndex: options.sourceCandidateIndex == null ? undefined : Number(options.sourceCandidateIndex),
    checkpointId: options.checkpointId,
    reason: options.reason,
    live: options.live === true || options.live === 'true',
    minEvents: options.minEvents == null ? undefined : Number(options.minEvents),
    minIntervalMs: options.minIntervalMs == null ? undefined : Number(options.minIntervalMs),
    charThreshold: options.charThreshold == null ? undefined : Number(options.charThreshold),
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  const commands = {
    dbInfo: (app) => app.dbInfo(),
    doctorCodexExec: (app, coreOptions) => app.checkCodexExec(coreOptions),
    beginSession: (app, coreOptions) => app.beginSession(coreOptions),
    sessionStatus: (app, coreOptions) => app.sessionStatus(coreOptions),
    remember: (app, coreOptions) => app.remember(coreOptions),
    promoteMemory: (app, coreOptions) => app.promoteMemory(coreOptions),
    correctMemory: (app, coreOptions) => app.correctMemory(coreOptions),
    deactivateMemory: (app, coreOptions) => app.deactivateMemory(coreOptions),
    listMemoryEvents: (app, coreOptions) => app.listMemoryEvents(coreOptions),
    listMemoryCandidates: (app, coreOptions) => app.listMemoryCandidates(coreOptions),
    search: (app, coreOptions) => app.search(coreOptions),
    getMemory: (app, coreOptions) => app.getMemory(coreOptions),
    appendRaw: (app, coreOptions) => app.appendRaw(coreOptions),
    distillCheckpoint: (app, coreOptions) => app.distillCheckpoint(coreOptions),
    listDistillRuns: (app, coreOptions) => app.listDistillRuns(coreOptions),
  };

  if (!command || command === 'help' || command === '--help') {
    printJson({
      commands: [...Object.keys(commands), 'serve'],
    });
    return;
  }

  if (command === 'serve') {
    const host = options.host || process.env.CONTEXTFORGE_REMOTE_HOST || '127.0.0.1';
    const port = options.port == null ? Number(process.env.CONTEXTFORGE_REMOTE_PORT || 8765) : Number(options.port);
    const server = await startContextForgeServer({ host, port });
    printJson({ listening: server.url });
    return;
  }

  const app = createContextForge();
  const coreOptions = toCoreOptions(options);
  const handler = commands[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }
  printJson(await handler(app, coreOptions));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
