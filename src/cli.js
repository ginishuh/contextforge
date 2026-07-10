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
import {
  ingestAgentRoutedSessions,
  ingestAgentSessions,
  listAgentAdapters,
  watchAgentRoutedSessions,
} from './ingest/agents.js';
import { runRetrievalEval } from './eval/retrieval.js';
import { startContextForgeServer } from './server.js';
import { CONTEXTFORGE_VERSION } from './version.js';

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

function cliBooleanOption(value, name) {
  if (value == null) {
    return undefined;
  }
  if (value === true || value === false) {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  throw new Error(`--${name} must be true, false, 1, 0, yes, or no.`);
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
    fromScope: options.fromScope,
    fromScopeType: options.fromScopeType,
    fromScopeKey: options.fromScopeKey,
    toScope: options.toScope,
    toScopeType: options.toScopeType,
    toScopeKey: options.toScopeKey,
    workspaceKey: options.workspaceKey,
    workspaceMode: options.workspaceMode,
    primaryScope: options.primaryScope,
    primaryScopeType: options.primaryScopeType,
    primaryScopeKey: options.primaryScopeKey,
    displayName: options.displayName,
    canonicalScope: options.canonicalScope,
    canonicalScopeType: options.canonicalScopeType,
    canonicalScopeKey: options.canonicalScopeKey,
    memberName: options.memberName,
    name: options.name,
    ruleKey: options.ruleKey,
    matchJson: options.matchJson,
    includeJson: options.includeJson,
    excludeJson: options.excludeJson,
    includeByDefault: options.includeByDefault === true || options.includeByDefault === 'true',
    includeShared: options.includeShared === true || options.includeShared === 'true',
    allowLocal: options.allowLocal === true || options.allowLocal === 'true',
    cwd: options.cwd,
    repoPath: options.repoPath,
    key: options.key,
    content: options.content,
    category: options.category,
    tags: Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',').filter(Boolean) : [],
    importance: options.importance == null ? 0 : Number(options.importance),
    query: options.query,
    clusterId: options.clusterId,
    consultReason: options.consultReason,
    limit: options.limit == null ? 10 : Number(options.limit),
    memoryMapLimit: options.memoryMapLimit == null ? undefined : Number(options.memoryMapLimit),
    memoryMapClusterSize: options.memoryMapClusterSize == null ? undefined : Number(options.memoryMapClusterSize),
    workspaceResultLimit: options.workspaceResultLimit == null ? undefined : Number(options.workspaceResultLimit),
    workspacePerScopeLimit: options.workspacePerScopeLimit == null ? undefined : Number(options.workspacePerScopeLimit),
    includeWorkspaceHandoffs: options.includeWorkspaceHandoffs === true || options.includeWorkspaceHandoffs === 'true',
    includePrimaryInWorkspaceResults:
      options.includePrimaryInWorkspaceResults === true || options.includePrimaryInWorkspaceResults === 'true',
    searchScopes: options.searchScopes,
    sharedScopeKey: options.sharedScopeKey,
    includeProvenance: options.includeProvenance === true || options.includeProvenance === 'true',
    sessionId: options.sessionId,
    conversationId: options.conversationId,
    role: options.role,
    priority: options.priority == null ? undefined : Number(options.priority),
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
    distillRunId: options.distillRunId,
    operation: options.operation,
    status: options.status,
    candidateType: options.candidateType,
    promotionRecommendation: options.promotionRecommendation,
    trigger: options.trigger,
    dryRun: cliBooleanOption(options.dryRun, 'dryRun'),
    audit: cliBooleanOption(options.audit, 'audit'),
    suggest: cliBooleanOption(options.suggest, 'suggest'),
    autoPromote: cliBooleanOption(options.autoPromote, 'autoPromote'),
    minConfidence: options.minConfidence == null ? undefined : Number(options.minConfidence),
    minStability: options.minStability == null ? undefined : Number(options.minStability),
    minOverlap: options.minOverlap == null ? undefined : Number(options.minOverlap),
    allowedCategories: options.allowedCategories
      ? String(options.allowedCategories)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    sort: options.sort,
    order: options.order,
    allowWarnings: options.allowWarnings === true || options.allowWarnings === 'true',
    allowStatusOverride: options.allowStatusOverride === true || options.allowStatusOverride === 'true',
    createUpdateCandidates: options.createUpdateCandidates === true || options.createUpdateCandidates === 'true',
    reason: options.reason,
    live: options.live === true || options.live === 'true',
    minEvents: options.minEvents == null ? undefined : Number(options.minEvents),
    minIntervalMs: options.minIntervalMs == null ? undefined : Number(options.minIntervalMs),
    charMinIntervalMs: options.charMinIntervalMs == null ? undefined : Number(options.charMinIntervalMs),
    charThreshold: options.charThreshold == null ? undefined : Number(options.charThreshold),
    maxEvents: options.maxEvents == null ? undefined : Number(options.maxEvents),
    maxChars: options.maxChars == null ? undefined : Number(options.maxChars),
    level: options.level == null ? undefined : Number(options.level),
    coversFrom: options.coversFrom,
    coversTo: options.coversTo,
    source: options.source,
    sourceRef: options.sourceRef,
    target: options.target,
    windowKind: options.windowKind || options.window,
    day: options.day,
    maxCheckpoints: options.maxCheckpoints == null ? undefined : Number(options.maxCheckpoints),
    minCheckpoints: options.minCheckpoints == null ? undefined : Number(options.minCheckpoints),
    ttlDays: options.ttlDays == null ? undefined : Number(options.ttlDays),
    file: options.file,
    fixture: options.fixture,
    repoRegistry: options.repoRegistry || options.registry || options.repoRegistryFile,
    agent: options.agent,
    adapter: options.adapter,
    adapters: options.adapters || options.adapter,
    sessionsDir: options.sessionsDir,
    codexSessionsDir: options.codexSessionsDir,
    grokSessionsDir: options.grokSessionsDir,
    projectsDir: options.projectsDir,
    claudeCodeProjectsDir: options.claudeCodeProjectsDir,
    cursorProjectsDir: options.cursorProjectsDir,
    opencodeDb: options.opencodeDb || options.db,
    distill: options.distill,
    maxContentChars: options.maxContentChars == null ? undefined : Number(options.maxContentChars),
    sinceMinutes: options.sinceMinutes == null ? undefined : Number(options.sinceMinutes),
    scanLimit: options.scanLimit == null ? undefined : Number(options.scanLimit),
    watch: options.watch === true || options.watch === 'true',
    watchFullScan: options.watchFullScan === true || options.watchFullScan === 'true',
    watchVerbose: options.watchVerbose === true || options.watchVerbose === 'true',
    watchStateDir: options.watchStateDir || process.env.CONTEXTFORGE_WATCH_STATE_DIR,
    intervalMs: options.intervalMs == null ? undefined : Number(options.intervalMs),
    iterations: options.iterations == null ? undefined : Number(options.iterations),
    idleMs: options.idleMs == null ? undefined : Number(options.idleMs),
    activeRunMaxAgeMs: options.activeRunMaxAgeMs == null ? undefined : Number(options.activeRunMaxAgeMs),
    charsPerToken: options.charsPerToken == null ? undefined : Number(options.charsPerToken),
    rawTailLimit: options.rawTailLimit == null ? undefined : Number(options.rawTailLimit),
    latestCheckpointLimit: options.latestCheckpointLimit == null ? undefined : Number(options.latestCheckpointLimit),
    relatedScopeKeys: options.relatedScopeKeys
      ? String(options.relatedScopeKeys)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    settings: options.settings ? JSON.parse(options.settings) : undefined,
    values: options.values ? JSON.parse(options.values) : undefined,
    secrets: options.secrets ? JSON.parse(options.secrets) : undefined,
    openAiCompatibleApiKey: options.openAiCompatibleApiKey,
    clearOpenAiCompatibleApiKey:
      options.clearOpenAiCompatibleApiKey === true || options.clearOpenAiCompatibleApiKey === 'true',
    mode: options.mode,
    currentTask: options.currentTask,
    currentUserIntent: options.currentUserIntent,
    targetSubject: options.targetSubject,
    sourceSubject: options.sourceSubject,
    lastUserCorrection: options.lastUserCorrection,
    openQuestion: options.openQuestion,
    nonGoals: options.nonGoals
      ? String(options.nonGoals)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    avoidMisreadings: options.avoidMisreadings
      ? String(options.avoidMisreadings)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    confidence: options.confidence == null ? undefined : Number(options.confidence),
    batchSize: options.batchSize == null ? undefined : Number(options.batchSize),
    force: options.force === true || options.force === 'true',
    includeEvents: options.includeEvents === true || options.includeEvents === 'true',
    retryFailed: options.retryFailed === true || options.retryFailed === 'true',
    staleAfterMs: options.staleAfterMs == null ? undefined : Number(options.staleAfterMs),
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function preserveCoreLimitDefault(coreOptions, rawOptions) {
  if (rawOptions.limit != null) {
    return coreOptions;
  }
  const { limit, ...withoutLimit } = coreOptions;
  return withoutLimit;
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  const commands = {
    dbInfo: (app) => app.dbInfo(),
    migrateScope: (app, coreOptions) => app.migrateScope(coreOptions),
    getRuntimeSettings: (app) => app.getRuntimeSettings(),
    updateRuntimeSettings: (app, coreOptions) => app.updateRuntimeSettings(coreOptions),
    checkDistillProvider: (app, coreOptions) => app.checkDistillProvider(coreOptions),
    workspaceList: (app, coreOptions) => app.listWorkspaceProfiles(coreOptions),
    workspaceGet: (app, coreOptions) => app.getWorkspaceProfile(coreOptions),
    workspaceUpsert: (app, coreOptions) => app.upsertWorkspaceProfile(coreOptions),
    workspaceDelete: (app, coreOptions) => app.deleteWorkspaceProfile(coreOptions),
    workspaceDeactivate: (app, coreOptions) => app.deactivateWorkspaceProfile(coreOptions),
    workspaceMemberUpsert: (app, coreOptions) => app.upsertWorkspaceMember(coreOptions),
    workspaceMemberRemove: (app, coreOptions) => app.removeWorkspaceMember(coreOptions),
    workspaceRuleUpsert: (app, coreOptions) => app.upsertWorkspaceRoutingRule(coreOptions),
    workspaceRuleRemove: (app, coreOptions) => app.removeWorkspaceRoutingRule(coreOptions),
    workspaceResolve: (app, coreOptions) => app.resolveWorkspace(coreOptions),
    bootstrapContext: (app, coreOptions) => app.bootstrapContext(coreOptions),
    agentStart: (app, coreOptions) => app.agentStart(coreOptions),
    agentCloseout: (app, coreOptions) => app.agentCloseout(coreOptions),
    expandMemoryCluster: (app, coreOptions) => app.expandMemoryCluster(coreOptions),
    doctorCodexExec: (app, coreOptions) => app.checkCodexExec(coreOptions),
    beginSession: (app, coreOptions) => app.beginSession(coreOptions),
    sessionStatus: (app, coreOptions) => app.sessionStatus(coreOptions),
    listDueDistillSessions: (app, coreOptions, rawOptions) =>
      app.listDueDistillSessions(preserveCoreLimitDefault(coreOptions, rawOptions)),
    processDueDistills: (app, coreOptions, rawOptions) =>
      app.processDueDistills(preserveCoreLimitDefault(coreOptions, rawOptions)),
    listDueConsolidations: (app, coreOptions) => app.listDueConsolidations(coreOptions),
    processConsolidations: (app, coreOptions) => app.processConsolidations(coreOptions),
    remember: (app, coreOptions) => app.remember(coreOptions),
    promoteMemory: (app, coreOptions) => app.promoteMemory(coreOptions),
    promoteMemoryCandidate: (app, coreOptions) => app.promoteMemoryCandidate(coreOptions),
    rejectMemoryCandidate: (app, coreOptions) => app.rejectMemoryCandidate(coreOptions),
    correctMemory: (app, coreOptions) => app.correctMemory(coreOptions),
    deactivateMemory: (app, coreOptions) => app.deactivateMemory(coreOptions),
    listMemoryEvents: (app, coreOptions) => app.listMemoryEvents(coreOptions),
    listMemoryCandidates: (app, coreOptions) => app.listMemoryCandidates(coreOptions),
    listPreferenceOccurrences: (app, coreOptions) => app.listPreferenceOccurrences(coreOptions),
    listMemoryUpdateCandidates: (app, coreOptions) => app.listMemoryUpdateCandidates(coreOptions),
    auditMemoryDuplicates: (app, coreOptions) => app.auditMemoryDuplicates(coreOptions),
    applyMemoryUpdateCandidate: (app, coreOptions) => app.applyMemoryUpdateCandidate(coreOptions),
    rejectMemoryUpdateCandidate: (app, coreOptions) => app.rejectMemoryUpdateCandidate(coreOptions),
    skipMemoryUpdateCandidate: (app, coreOptions) => app.skipMemoryUpdateCandidate(coreOptions),
    auditMemoryCandidates: (app, coreOptions) => app.auditMemoryCandidates(coreOptions),
    autoPromoteMemoryCandidates: (app, coreOptions) => app.autoPromoteMemoryCandidates(coreOptions),
    search: (app, coreOptions) => app.search(coreOptions),
    rebuildEmbeddings: (app, coreOptions) => app.rebuildEmbeddings(coreOptions),
    processEmbeddingJobs: (app, coreOptions) => app.processEmbeddingJobs(coreOptions),
    evalRetrieval: (_app, coreOptions) => runRetrievalEval(coreOptions),
    listEmbeddingJobs: (app, coreOptions) => app.listEmbeddingJobs(coreOptions),
    listScopeKeys: (app, coreOptions) => app.listScopeKeys(coreOptions),
    getMemory: (app, coreOptions) => app.getMemory(coreOptions),
    listMemories: (app, coreOptions) => app.listMemories(coreOptions),
    appendRaw: (app, coreOptions) => app.appendRaw(coreOptions),
    listRawEvents: (app, coreOptions) => app.listRawEvents(coreOptions),
    listCheckpoints: (app, coreOptions) => app.listCheckpoints(coreOptions),
    getWorkingSummary: (app, coreOptions) => app.getWorkingSummary(coreOptions),
    getSessionWorkingContext: (app, coreOptions) => app.getSessionWorkingContext(coreOptions),
    upsertSessionWorkingContext: (app, coreOptions) => app.upsertSessionWorkingContext(coreOptions),
    pruneRawEvents: (app, coreOptions) => app.pruneRawEvents(coreOptions),
    distillCheckpoint: (app, coreOptions) => app.distillCheckpoint(coreOptions),
    listDistillRuns: (app, coreOptions) => app.listDistillRuns(coreOptions),
    listLlmUsageEvents: (app, coreOptions) => app.listLlmUsageEvents(coreOptions),
    llmUsageRollup: (app, coreOptions) => app.llmUsageRollup(coreOptions),
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
    listAgentAdapters: () => listAgentAdapters(),
    ingestAgentSessions: (app, coreOptions) => ingestAgentSessions(app, coreOptions),
    ingestAgentRoutedSessions: (app, coreOptions) =>
      coreOptions.watch
        ? watchAgentRoutedSessions(app, {
            ...coreOptions,
            onResult: (result) => {
              console.log(JSON.stringify(result));
            },
          })
        : ingestAgentRoutedSessions(app, coreOptions),
  };

  if (command === '--version' || command === 'version') {
    console.log(CONTEXTFORGE_VERSION);
    return;
  }

  if (!command || command === 'help' || command === '--help') {
    printJson({
      name: 'contextforge',
      version: CONTEXTFORGE_VERSION,
      commands: [...Object.keys(commands), 'serve', 'version'],
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
  const result = await handler(app, coreOptions, options);
  printJson(result);
  if (result?.kind === 'retrieval_eval' && Number(result.failed || 0) > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
