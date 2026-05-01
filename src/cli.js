#!/usr/bin/env node
import { createContextForge } from './core.js';
import {
  ingestClaudeCodeFile,
  ingestClaudeCodeRoutedSessions,
  ingestClaudeCodeSessions,
  watchClaudeCodeRoutedSessions,
  watchClaudeCodeSessions,
} from './ingest/claude_code.js';
import {
  ingestCodexRolloutFile,
  ingestCodexRoutedSessions,
  ingestCodexSessions,
  watchCodexRoutedSessions,
  watchCodexSessions,
} from './ingest/codex.js';
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
    cwd: options.cwd,
    repoPath: options.repoPath,
    key: options.key,
    content: options.content,
    category: options.category,
    tags: Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',').filter(Boolean) : [],
    importance: options.importance == null ? 0 : Number(options.importance),
    query: options.query,
    limit: options.limit == null ? 10 : Number(options.limit),
    searchScopes: options.searchScopes,
    sharedScopeKey: options.sharedScopeKey,
    includeShared: options.includeShared === true || options.includeShared === 'true',
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
    candidateId: options.candidateId,
    checkpointId: options.checkpointId,
    status: options.status,
    candidateType: options.candidateType,
    promotionRecommendation: options.promotionRecommendation,
    sort: options.sort,
    allowWarnings: options.allowWarnings === true || options.allowWarnings === 'true',
    allowStatusOverride: options.allowStatusOverride === true || options.allowStatusOverride === 'true',
    reason: options.reason,
    live: options.live === true || options.live === 'true',
    minEvents: options.minEvents == null ? undefined : Number(options.minEvents),
    minIntervalMs: options.minIntervalMs == null ? undefined : Number(options.minIntervalMs),
    charMinIntervalMs: options.charMinIntervalMs == null ? undefined : Number(options.charMinIntervalMs),
    charThreshold: options.charThreshold == null ? undefined : Number(options.charThreshold),
    maxEvents: options.maxEvents == null ? undefined : Number(options.maxEvents),
    maxChars: options.maxChars == null ? undefined : Number(options.maxChars),
    ttlDays: options.ttlDays == null ? undefined : Number(options.ttlDays),
    file: options.file,
    repoRegistry: options.repoRegistry || options.registry || options.repoRegistryFile,
    sessionsDir: options.sessionsDir,
    projectsDir: options.projectsDir,
    distill: options.distill,
    maxContentChars: options.maxContentChars == null ? undefined : Number(options.maxContentChars),
    sinceMinutes: options.sinceMinutes == null ? undefined : Number(options.sinceMinutes),
    scanLimit: options.scanLimit == null ? undefined : Number(options.scanLimit),
    watch: options.watch === true || options.watch === 'true',
    intervalMs: options.intervalMs == null ? undefined : Number(options.intervalMs),
    iterations: options.iterations == null ? undefined : Number(options.iterations),
    charsPerToken: options.charsPerToken == null ? undefined : Number(options.charsPerToken),
    batchSize: options.batchSize == null ? undefined : Number(options.batchSize),
    force: options.force === true || options.force === 'true',
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  const commands = {
    dbInfo: (app) => app.dbInfo(),
    bootstrapContext: (app, coreOptions) => app.bootstrapContext(coreOptions),
    doctorCodexExec: (app, coreOptions) => app.checkCodexExec(coreOptions),
    beginSession: (app, coreOptions) => app.beginSession(coreOptions),
    sessionStatus: (app, coreOptions) => app.sessionStatus(coreOptions),
    remember: (app, coreOptions) => app.remember(coreOptions),
    promoteMemory: (app, coreOptions) => app.promoteMemory(coreOptions),
    promoteMemoryCandidate: (app, coreOptions) => app.promoteMemoryCandidate(coreOptions),
    rejectMemoryCandidate: (app, coreOptions) => app.rejectMemoryCandidate(coreOptions),
    correctMemory: (app, coreOptions) => app.correctMemory(coreOptions),
    deactivateMemory: (app, coreOptions) => app.deactivateMemory(coreOptions),
    listMemoryEvents: (app, coreOptions) => app.listMemoryEvents(coreOptions),
    listMemoryCandidates: (app, coreOptions) => app.listMemoryCandidates(coreOptions),
    search: (app, coreOptions) => app.search(coreOptions),
    rebuildEmbeddings: (app, coreOptions) => app.rebuildEmbeddings(coreOptions),
    getMemory: (app, coreOptions) => app.getMemory(coreOptions),
    appendRaw: (app, coreOptions) => app.appendRaw(coreOptions),
    listRawEvents: (app, coreOptions) => app.listRawEvents(coreOptions),
    pruneRawEvents: (app, coreOptions) => app.pruneRawEvents(coreOptions),
    distillCheckpoint: (app, coreOptions) => app.distillCheckpoint(coreOptions),
    listDistillRuns: (app, coreOptions) => app.listDistillRuns(coreOptions),
    distillUsage: (app, coreOptions) => app.distillUsage(coreOptions),
    ingestCodexRollout: (app, coreOptions) => ingestCodexRolloutFile(app, coreOptions),
    ingestCodexSessions: (app, coreOptions) =>
      coreOptions.watch
        ? watchCodexSessions(app, {
            ...coreOptions,
            onResult: (result) => {
              console.log(JSON.stringify(result));
            },
          })
        : ingestCodexSessions(app, coreOptions),
    ingestCodexRoutedSessions: (app, coreOptions) =>
      coreOptions.watch
        ? watchCodexRoutedSessions(app, {
            ...coreOptions,
            onResult: (result) => {
              console.log(JSON.stringify(result));
            },
          })
        : ingestCodexRoutedSessions(app, coreOptions),
    ingestClaudeCodeFile: (app, coreOptions) => ingestClaudeCodeFile(app, coreOptions),
    ingestClaudeCodeSessions: (app, coreOptions) =>
      coreOptions.watch
        ? watchClaudeCodeSessions(app, {
            ...coreOptions,
            onResult: (result) => {
              console.log(JSON.stringify(result));
            },
          })
        : ingestClaudeCodeSessions(app, coreOptions),
    ingestClaudeCodeRoutedSessions: (app, coreOptions) =>
      coreOptions.watch
        ? watchClaudeCodeRoutedSessions(app, {
            ...coreOptions,
            onResult: (result) => {
              console.log(JSON.stringify(result));
            },
          })
        : ingestClaudeCodeRoutedSessions(app, coreOptions),
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
