import { liveStateTermsMatch, summarySnippet } from '../common.js';

// Pure formatters for the bootstrap_context operation: they shape stored rows
// into the response payload and decide what a consulting agent should trust.
// The operation itself stays in core.js because it needs the live store and
// config; everything here takes its inputs as arguments.

const RECOVERY_CONSULT_REASONS = new Set(['startup', 'resume', 'compaction_recovery', 'agent_switch']);
const ACTIVE_SESSION_CONSULT_REASONS = new Set(['active_session', 'targeted_search', 'live_state_check']);

export function bootstrapConsultPolicy({ consultReason, latestCheckpointLimit, sessionId }) {
  const warnings = [];
  // Machine-readable tokens used by API consumers; prose can use friendlier names.
  const recommendedTools = [];
  const handoffRecommended = RECOVERY_CONSULT_REASONS.has(consultReason);
  if (consultReason === 'unknown') {
    warnings.push({
      code: 'consult_reason_unknown',
      message:
        'Pass consultReason so agents can distinguish startup/resume recovery from active-session targeted lookup.',
    });
  }
  if (ACTIVE_SESSION_CONSULT_REASONS.has(consultReason)) {
    warnings.push({
      code: 'active_session_handoff_not_self_check',
      message:
        'Current uninterrupted session context should remain authoritative for current intent; do not use latest handoff as routine self-confirmation.',
    });
    if (latestCheckpointLimit > 0) {
      warnings.push({
        code: 'latest_handoff_returned_for_context_only',
        message:
          'latestHandoff is still returned for compatibility, but should be ignored unless this is actually resume, compaction recovery, or agent transfer.',
      });
    }
  }
  if (consultReason === 'targeted_search') {
    recommendedTools.push('search');
    warnings.push({
      code: 'prefer_search_for_targeted_lookup',
      message: 'Use targeted search for file/API/error/domain lookups during an active session instead of full handoff bootstrap.',
    });
  }
  if (consultReason === 'live_state_check') {
    recommendedTools.push('db_info', 'git', 'gh', 'healthz', 'service_manager');
    warnings.push({
      code: 'prefer_live_sources_for_mutable_state',
      message:
        'Use live sources for mutable DB/git/GitHub/CI/runtime/deployment state; checkpoints are compressed handoff notes.',
    });
  }
  if (consultReason === 'active_session') {
    recommendedTools.push('current_conversation', 'search');
  }
  if (sessionId && ACTIVE_SESSION_CONSULT_REASONS.has(consultReason)) {
    warnings.push({
      code: 'same_session_bootstrap_warning',
      message:
        'This bootstrap call includes a sessionId during active-session work; same-session bootstrap can inject stale compressed context.',
    });
  }
  return {
    reason: consultReason,
    handoffRecommended,
    latestHandoffUse: handoffRecommended
      ? 'Use latest handoff for continuity recovery, then verify mutable live state.'
      : 'Do not use latest handoff as routine self-confirmation while active session context is intact.',
    targetedSearchUse: 'Use search for active-session file/API/error/domain lookups.',
    liveStateUse: 'Use db_info, git, GitHub, health checks, service manager, SQL, or migrations for mutable state.',
    warnings,
    recommendedTools: [...new Set(recommendedTools)],
  };
}

function resultTextForVerification(result) {
  if (result.memory) {
    return [result.memory.key, result.memory.category, result.memory.content, ...(result.memory.tags || [])].join(' ');
  }
  if (result.checkpoint) {
    return [
      result.checkpoint.summaryShort,
      result.checkpoint.summaryText,
      ...(result.checkpoint.decisions || []),
      ...(result.checkpoint.todos || []),
      ...(result.checkpoint.openQuestions || []),
      structuredVerificationText(result.checkpoint.structured || result.checkpoint.metadata?.structured),
    ].join(' ');
  }
  if (result.candidate) {
    return [
      result.candidate.candidate.key,
      result.candidate.candidate.category,
      result.candidate.candidate.content,
      result.candidate.candidate.reason,
      ...(result.candidate.candidate.tags || []),
    ].join(' ');
  }
  return '';
}

function structuredVerificationText(structured) {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    return '';
  }
  const liveState = structured.liveState && typeof structured.liveState === 'object' ? structured.liveState : {};
  const values = [
    liveState.repo,
    liveState.branch,
    liveState.baseBranch,
    liveState.headCommit,
    liveState.prNumber == null || liveState.prNumber === '' ? '' : `PR #${liveState.prNumber}`,
    liveState.prUrl,
    liveState.ciStatus,
    liveState.worktreeStatus,
    liveState.runtimeStatus,
    liveState.deploymentStatus,
    ...(Array.isArray(liveState.staleReasons) ? liveState.staleReasons : []),
    ...(Array.isArray(liveState.verifyHints) ? liveState.verifyHints : []),
  ];
  return values.filter(Boolean).join(' ');
}

export function requiresLiveStateVerification(result) {
  return liveStateTermsMatch(resultTextForVerification(result));
}

export function bootstrapTrustForType(type) {
  if (type === 'memory') {
    return 'reviewed_durable';
  }
  if (type === 'checkpoint') {
    return 'credible_recent_handoff';
  }
  if (type === 'memory_candidate') {
    return 'review_material';
  }
  return 'context_candidate';
}

export function bootstrapUseHint(result) {
  if (result.type === 'memory') {
    return 'Reviewed durable state; use for decisions, but verify drift-prone facts against live sources.';
  }
  if (result.type === 'checkpoint') {
    return 'Credible recent handoff state; use actively for continuity and planning, but verify mutable live state before acting.';
  }
  if (result.type === 'memory_candidate') {
    return 'Unreviewed promotion candidate; useful context and review material, not canonical truth.';
  }
  return 'Context candidate; verify before acting.';
}

export function bootstrapResultSummary(result) {
  if (result.memory) {
    return {
      key: result.memory.key,
      category: result.memory.category,
      content: summarySnippet(result.memory.content),
    };
  }
  if (result.checkpoint) {
    return {
      key: result.checkpoint.id,
      category: 'checkpoint',
      content: summarySnippet(result.checkpoint.summaryText || result.checkpoint.summaryShort),
      sessionId: result.checkpoint.sessionId,
      level: result.checkpoint.level,
      createdAt: result.checkpoint.createdAt,
    };
  }
  if (result.candidate) {
    const sourceProvenance = result.candidate.source?.sourceProvenance || null;
    return {
      key: result.candidate.candidate.key,
      category: result.candidate.candidate.category,
      content: summarySnippet(result.candidate.candidate.content),
      candidateId: result.candidate.id,
      status: result.candidate.status,
      checkpointId: result.candidate.checkpointId,
      sourceAgent: sourceProvenance?.sourceAgent || result.candidate.source?.sourceAgent || null,
      sourceProvenance,
    };
  }
  return {
    key: null,
    category: null,
    content: '',
  };
}

export function bootstrapWorkingSummary(summary) {
  if (!summary) {
    return null;
  }
  const checkpointInsertFailed = Boolean(summary.metadata?.checkpointInsertFailed);
  // Keep bootstrap small and avoid leaking provider metadata; expose only handoff-safe state flags.
  return {
    type: 'working_summary',
    id: summary.id,
    sessionId: summary.sessionId,
    conversationId: summary.conversationId,
    content: summarySnippet(summary.summaryText, 1200),
    summaryShort: summary.summaryShort,
    sourceCheckpointId: summary.sourceCheckpointId,
    distillRunId: summary.distillRunId,
    sourceEventCount: summary.sourceEventCount,
    degraded: checkpointInsertFailed,
    checkpointInsertFailed,
    updatedAt: summary.updatedAt,
    trust: 'live_continuity',
    verificationRequired: true,
    whyUse:
      'Latest rolling session state for handoff; useful for live continuation, but not reviewed durable memory.',
  };
}

export function bootstrapSessionWorkingContext(context) {
  if (!context) {
    return null;
  }
  return {
    type: 'session_working_context',
    id: context.id,
    sessionId: context.sessionId,
    conversationId: context.conversationId,
    mode: context.mode,
    currentTask: context.currentTask,
    currentUserIntent: context.currentUserIntent,
    targetSubject: context.targetSubject,
    sourceSubject: context.sourceSubject,
    lastUserCorrection: context.lastUserCorrection,
    openQuestion: context.openQuestion,
    nonGoals: context.nonGoals,
    avoidMisreadings: context.avoidMisreadings,
    confidence: context.confidence,
    sourceCheckpointId: context.sourceCheckpointId,
    distillRunId: context.distillRunId,
    updatedAt: context.updatedAt,
    trust: 'mutable_session_state',
    verificationRequired: true,
    whyUse:
      'Structured live session state for resume handoff; useful for current task framing, but not reviewed durable memory.',
  };
}

export function bootstrapRawTailEvent(event) {
  return {
    id: event.id,
    role: event.role,
    content: summarySnippet(event.content, 800),
    metadata: event.metadata,
    createdAt: event.createdAt,
  };
}

export function bootstrapResult(result, group) {
  const summary = bootstrapResultSummary(result);
  const verificationRequired =
    result.type !== 'memory'
      ? true
      : requiresLiveStateVerification(result);
  return {
    group,
    type: result.type,
    key: summary.key,
    category: summary.category,
    content: summary.content,
    trust: bootstrapTrustForType(result.type),
    verificationRequired,
    whyUse: bootstrapUseHint(result),
    why: result.why,
    source: result.source,
    retrieval: result.retrieval,
    ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
    ...(summary.level != null ? { level: summary.level } : {}),
    ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
    ...(summary.candidateId ? { candidateId: summary.candidateId } : {}),
    ...(summary.status ? { status: summary.status } : {}),
    ...(summary.checkpointId ? { checkpointId: summary.checkpointId } : {}),
    ...(summary.sourceAgent ? { sourceAgent: summary.sourceAgent } : {}),
    ...(summary.sourceProvenance ? { sourceProvenance: summary.sourceProvenance } : {}),
  };
}

export function bootstrapSummary(results) {
  if (results.length === 0) {
    return 'No relevant ContextForge results found for this bootstrap query.';
  }
  const counts = results.reduce((acc, result) => {
    acc[result.type] = (acc[result.type] || 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  return `Found ${results.length} relevant ContextForge result(s): ${parts}. Treat them as context candidates and verify live state before acting.`;
}

function queryContainsAny(query, terms) {
  const text = String(query || '').toLowerCase();
  return terms.some((term) => text.includes(term));
}

function workspaceRoleBoost(role, query) {
  if (
    role === 'api-domain-ssot' &&
    queryContainsAny(query, ['endpoint', 'schema', 'permission', 'migration', 'openapi'])
  ) {
    return 350;
  }
  if (
    role === 'cross-repo-contract' &&
    queryContainsAny(query, ['rfc', 'e2e', 'contract', 'release', 'consumer'])
  ) {
    return 320;
  }
  if (
    ['consumer', 'mobile-consumer', 'desktop-web-consumer'].includes(role) &&
    queryContainsAny(query, ['frontend', 'mobile', 'desktop', 'flutter', 'react', 'electron', 'client'])
  ) {
    return 220;
  }
  return 0;
}

function workspaceTypeBoost(type) {
  if (type === 'memory') return 600;
  if (type === 'checkpoint') return 120;
  if (type === 'memory_candidate') return 60;
  return 0;
}

export function workspaceResultSortScore(result, member, query) {
  return (
    workspaceTypeBoost(result.type) +
    workspaceRoleBoost(member.role, query) +
    Number(member.priority || 0) +
    Math.min(500, Number(result.score || 0))
  );
}

export function workspaceBootstrapResult(result, member, workspaceKey, query) {
  const compact = bootstrapResult(result, 'workspace');
  const scope = {
    scope: member.scopeType,
    scopeType: member.scopeType,
    scopeKey: member.scopeKey,
    workspaceKey,
    memberName: member.memberName,
    role: member.role,
  };
  return {
    ...compact,
    scope,
    source: {
      ...(compact.source || {}),
      ...scope,
    },
    includedBecause: member.includedBecause || [],
    workspaceRank: workspaceResultSortScore(result, member, query),
  };
}

export function compactAgentBootstrap(bootstrap) {
  return {
    scope: bootstrap.scope,
    storage: bootstrap.storage,
    consult: bootstrap.consult,
    handoff: {
      latestHandoffId: bootstrap.handoff?.latestHandoff?.id || null,
      latestHandoffAt: bootstrap.handoff?.latestHandoff?.createdAt || null,
      latestCheckpointCount: bootstrap.handoff?.latestCheckpoints?.length || 0,
      latestByAgent: Object.fromEntries(
        Object.entries(bootstrap.handoff?.latestByAgent || {}).map(([agent, checkpoint]) => [
          agent,
          {
            id: checkpoint.id,
            createdAt: checkpoint.createdAt,
            sessionId: checkpoint.sessionId,
          },
        ]),
      ),
    },
    resultCount: bootstrap.results?.length || 0,
    memoryMapClusters: bootstrap.memoryMap?.clusters?.length || 0,
    workspace: bootstrap.workspace
      ? {
          enabled: bootstrap.workspace.enabled,
          workspaceKey: bootstrap.workspace.scopePlan?.workspace?.workspaceKey || null,
          includedScopeCount: bootstrap.workspace.scopePlan?.includedScopes?.length || 0,
          resultCount: bootstrap.workspace.results?.length || 0,
          warnings: bootstrap.workspace.warnings || [],
        }
      : null,
  };
}

export function storageBootstrapInfo(config, info) {
  const vectorReady = Boolean(info.vector?.sqliteVecAvailable && info.embeddings?.enabled);
  const staleSources = Number(info.embeddings?.coverage?.staleSources || 0);
  const pendingJobs = Number(info.embeddings?.jobs?.pending || 0);
  const failedJobs = Number(info.embeddings?.jobs?.failed || 0);
  return {
    mode: config.storageMode,
    authority: config.storageMode === 'remote' ? 'canonical' : config.storageMode === 'local' ? 'local' : 'project-local',
    vectorReady,
    vectorState: vectorReady && staleSources === 0 && failedJobs === 0 ? 'ready' : 'degraded',
    vectorStaleSources: staleSources,
    vectorPendingJobs: pendingJobs,
    vectorFailedJobs: failedJobs,
    sqliteVecAvailable: Boolean(info.vector?.sqliteVecAvailable),
    sqliteVecVersion: info.vector?.sqliteVecVersion || null,
    embeddingProvider: info.embeddings?.provider || 'none',
    connection: info.connection || null,
  };
}

export function compactBootstrapCandidate(result) {
  return {
    candidateId: result.candidateId || null,
    key: result.key || null,
    category: result.category || null,
    content: summarySnippet(result.content, 240),
    status: result.status || null,
    checkpointId: result.checkpointId || null,
    sourceAgent: result.sourceAgent || null,
    sourceProvenance: result.sourceProvenance || null,
    trust: 'review_material',
    useHint: 'Useful context and review material, not durable truth or a promotion proposal.',
  };
}
