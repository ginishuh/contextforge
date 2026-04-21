#!/usr/bin/env node
import { createContextForge } from './core.js';

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
    sessionId: options.sessionId,
    conversationId: options.conversationId,
    role: options.role,
    provider: options.provider,
    metadata: options.metadata ? JSON.parse(options.metadata) : {},
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
        'search',
        'getMemory',
        'appendRaw',
        'distillCheckpoint',
      ],
    });
    return;
  }

  const app = createContextForge();
  const coreOptions = toCoreOptions(options);

  if (command === 'dbInfo') {
    printJson(app.dbInfo());
  } else if (command === 'beginSession') {
    printJson(app.beginSession(coreOptions));
  } else if (command === 'remember') {
    printJson(app.remember(coreOptions));
  } else if (command === 'search') {
    printJson(app.search(coreOptions));
  } else if (command === 'getMemory') {
    printJson(app.getMemory(coreOptions));
  } else if (command === 'appendRaw') {
    printJson(app.appendRaw(coreOptions));
  } else if (command === 'distillCheckpoint') {
    printJson(await app.distillCheckpoint(coreOptions));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
