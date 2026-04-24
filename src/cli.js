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
    metadata: options.metadata ? JSON.parse(options.metadata) : {},
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
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  if (!command || command === 'help' || command === '--help') {
    printJson({
      commands: [
        'dbInfo',
        'beginSession',
        'remember',
        'promoteMemory',
        'correctMemory',
        'deactivateMemory',
        'listMemoryEvents',
        'listMemoryCandidates',
        'search',
        'getMemory',
        'appendRaw',
        'distillCheckpoint',
        'listDistillRuns',
        'serve',
      ],
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

  if (command === 'dbInfo') {
    printJson(await app.dbInfo());
  } else if (command === 'beginSession') {
    printJson(await app.beginSession(coreOptions));
  } else if (command === 'remember') {
    printJson(await app.remember(coreOptions));
  } else if (command === 'promoteMemory') {
    printJson(await app.promoteMemory(coreOptions));
  } else if (command === 'correctMemory') {
    printJson(await app.correctMemory(coreOptions));
  } else if (command === 'deactivateMemory') {
    printJson(await app.deactivateMemory(coreOptions));
  } else if (command === 'listMemoryEvents') {
    printJson(await app.listMemoryEvents(coreOptions));
  } else if (command === 'listMemoryCandidates') {
    printJson(await app.listMemoryCandidates(coreOptions));
  } else if (command === 'search') {
    printJson(await app.search(coreOptions));
  } else if (command === 'getMemory') {
    printJson(await app.getMemory(coreOptions));
  } else if (command === 'appendRaw') {
    printJson(await app.appendRaw(coreOptions));
  } else if (command === 'distillCheckpoint') {
    printJson(await app.distillCheckpoint(coreOptions));
  } else if (command === 'listDistillRuns') {
    printJson(await app.listDistillRuns(coreOptions));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
