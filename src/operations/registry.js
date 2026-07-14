const REMOTE_OPERATION_ORDER = Object.freeze([
  'dbInfo', 'readiness', 'operationalMetrics', 'migrateScope', 'getRuntimeSettings', 'updateRuntimeSettings',
  'checkDistillProvider', 'upsertWorkspaceProfile', 'getWorkspaceProfile', 'listWorkspaceProfiles',
  'deleteWorkspaceProfile', 'deactivateWorkspaceProfile', 'upsertWorkspaceMember', 'removeWorkspaceMember',
  'upsertWorkspaceRoutingRule', 'removeWorkspaceRoutingRule', 'resolveWorkspace', 'listScopeKeys',
  'bootstrapContext', 'agentStart', 'agentCloseout', 'expandMemoryCluster', 'syncResumeContext', 'checkCodexExec',
  'beginSession', 'sessionStatus', 'submitDistillJob', 'submitAuditJob', 'getJob', 'listJobs', 'processJobs',
  'cancelJob', 'listDueDistillSessions', 'processDueDistills', 'listDueCandidateAudits',
  'processDueCandidateAudits', 'listDueCandidateWakeups', 'processDueCandidateWakeups',
  'listDueConsolidations', 'processConsolidations',
  'remember', 'promoteMemory', 'promoteMemoryCandidate', 'rejectMemoryCandidate', 'correctMemory',
  'snoozeMemoryCandidate', 'wakeMemoryCandidate',
  'deactivateMemory', 'listMemoryEvents', 'listMemoryCandidates', 'memoryCandidateBacklog',
  'listMemoryCandidateAuditAttempts', 'listPreferenceOccurrences',
  'listMemoryUpdateCandidates', 'auditMemoryDuplicates', 'applyMemoryUpdateCandidate',
  'rejectMemoryUpdateCandidate', 'skipMemoryUpdateCandidate', 'suggestMemoryPromotions', 'auditMemoryCandidates',
  'autoPromoteMemoryCandidates', 'reconcileMemory', 'getMemory', 'listMemories', 'search', 'embeddingInventory',
  'pruneEmbeddingArtifacts', 'rebuildEmbeddings', 'processEmbeddingJobs', 'listEmbeddingJobs', 'appendRaw',
  'listRawEvents', 'listCheckpoints', 'getWorkingSummary', 'getSessionWorkingContext',
  'upsertSessionWorkingContext', 'pruneRawEvents', 'distillCheckpoint', 'listDistillRuns', 'listRecentDistillRuns',
  'listLlmUsageEvents', 'llmUsageRollup', 'distillUsage',
]);

const CAPABILITY_GROUPS = Object.freeze({
  read: [
    'dbInfo', 'readiness', 'getWorkspaceProfile', 'listWorkspaceProfiles', 'resolveWorkspace', 'listScopeKeys',
    'bootstrapContext', 'agentStart', 'expandMemoryCluster', 'syncResumeContext', 'sessionStatus', 'getJob',
    'listJobs', 'listDueDistillSessions', 'listDueConsolidations', 'getMemory', 'listMemories', 'search',
    'listMemoryEvents', 'listMemoryCandidates', 'listPreferenceOccurrences', 'listMemoryUpdateCandidates',
    'suggestMemoryPromotions', 'listEmbeddingJobs', 'listRawEvents', 'listCheckpoints', 'getWorkingSummary',
    'getSessionWorkingContext', 'listDistillRuns', 'listRecentDistillRuns', 'listLlmUsageEvents', 'llmUsageRollup',
    'distillUsage',
  ],
  write: [
    'beginSession', 'submitDistillJob', 'remember', 'appendRaw', 'upsertSessionWorkingContext', 'distillCheckpoint',
  ],
  review: [
    'agentCloseout', 'submitAuditJob', 'memoryCandidateBacklog', 'listMemoryCandidateAuditAttempts',
    'listDueCandidateAudits', 'listDueCandidateWakeups',
    'promoteMemory', 'promoteMemoryCandidate', 'rejectMemoryCandidate',
    'snoozeMemoryCandidate', 'wakeMemoryCandidate',
    'correctMemory', 'deactivateMemory', 'auditMemoryDuplicates', 'applyMemoryUpdateCandidate',
    'rejectMemoryUpdateCandidate', 'skipMemoryUpdateCandidate', 'auditMemoryCandidates',
    'autoPromoteMemoryCandidates', 'reconcileMemory',
  ],
  operator: [
    'operationalMetrics', 'migrateScope', 'getRuntimeSettings', 'updateRuntimeSettings', 'checkDistillProvider',
    'upsertWorkspaceProfile', 'deleteWorkspaceProfile', 'deactivateWorkspaceProfile', 'upsertWorkspaceMember',
    'removeWorkspaceMember', 'upsertWorkspaceRoutingRule', 'removeWorkspaceRoutingRule', 'checkCodexExec',
    'processJobs', 'cancelJob', 'processDueDistills', 'processDueCandidateAudits',
    'processDueCandidateWakeups', 'processConsolidations',
    'embeddingInventory',
    'pruneEmbeddingArtifacts', 'rebuildEmbeddings', 'processEmbeddingJobs', 'pruneRawEvents',
  ],
});

const SCOPE_MODE_GROUPS = Object.freeze({
  process: [
    'dbInfo', 'readiness', 'operationalMetrics', 'getRuntimeSettings', 'updateRuntimeSettings',
    'checkDistillProvider', 'checkCodexExec',
  ],
  all: ['listScopeKeys', 'listRecentDistillRuns', 'processJobs', 'pruneRawEvents'],
  workspace: [
    'upsertWorkspaceProfile', 'getWorkspaceProfile', 'listWorkspaceProfiles', 'deleteWorkspaceProfile',
    'deactivateWorkspaceProfile', 'upsertWorkspaceMember', 'removeWorkspaceMember', 'upsertWorkspaceRoutingRule',
    'removeWorkspaceRoutingRule', 'resolveWorkspace',
  ],
  optional: [
    'getJob', 'listJobs', 'cancelJob', 'listDueDistillSessions', 'processDueDistills',
    'listDueCandidateAudits', 'processDueCandidateAudits', 'embeddingInventory',
    'pruneEmbeddingArtifacts',
  ],
  migration: ['migrateScope'],
});

const MCP_METHODS = Object.freeze({
  db_info: 'dbInfo',
  migrate_scope: 'migrateScope',
  get_runtime_settings: 'getRuntimeSettings',
  list_workspaces: 'listWorkspaceProfiles',
  get_workspace: 'getWorkspaceProfile',
  resolve_workspace: 'resolveWorkspace',
  upsert_workspace_profile: 'upsertWorkspaceProfile',
  deactivate_workspace_profile: 'deactivateWorkspaceProfile',
  upsert_workspace_member: 'upsertWorkspaceMember',
  remove_workspace_member: 'removeWorkspaceMember',
  upsert_workspace_routing_rule: 'upsertWorkspaceRoutingRule',
  remove_workspace_routing_rule: 'removeWorkspaceRoutingRule',
  bootstrap_context: 'bootstrapContext',
  expand_memory_cluster: 'expandMemoryCluster',
  sync_resume_context: 'syncResumeContext',
  begin_session: 'beginSession',
  session_status: 'sessionStatus',
  submit_distill_job: 'submitDistillJob',
  submit_audit_job: 'submitAuditJob',
  get_job: 'getJob',
  list_jobs: 'listJobs',
  process_jobs: 'processJobs',
  cancel_job: 'cancelJob',
  list_due_distill_sessions: 'listDueDistillSessions',
  process_due_distills: 'processDueDistills',
  list_due_candidate_audits: 'listDueCandidateAudits',
  process_due_candidate_audits: 'processDueCandidateAudits',
  list_due_candidate_wakeups: 'listDueCandidateWakeups',
  process_due_candidate_wakeups: 'processDueCandidateWakeups',
  list_due_consolidations: 'listDueConsolidations',
  process_consolidations: 'processConsolidations',
  search: 'search',
  embedding_inventory: 'embeddingInventory',
  prune_embedding_artifacts: 'pruneEmbeddingArtifacts',
  rebuild_embeddings: 'rebuildEmbeddings',
  process_embedding_jobs: 'processEmbeddingJobs',
  list_embedding_jobs: 'listEmbeddingJobs',
  get_memory: 'getMemory',
  remember: 'remember',
  append_raw: 'appendRaw',
  prune_raw_events: 'pruneRawEvents',
  get_working_summary: 'getWorkingSummary',
  list_checkpoints: 'listCheckpoints',
  get_session_working_context: 'getSessionWorkingContext',
  upsert_session_working_context: 'upsertSessionWorkingContext',
  distill_checkpoint: 'distillCheckpoint',
  distill_usage: 'distillUsage',
  list_llm_usage_events: 'listLlmUsageEvents',
  llm_usage_rollup: 'llmUsageRollup',
  list_memory_events: 'listMemoryEvents',
  list_memory_candidates: 'listMemoryCandidates',
  list_preference_occurrences: 'listPreferenceOccurrences',
  list_memory_update_candidates: 'listMemoryUpdateCandidates',
  audit_memory_duplicates: 'auditMemoryDuplicates',
  apply_memory_update_candidate: 'applyMemoryUpdateCandidate',
  reject_memory_update_candidate: 'rejectMemoryUpdateCandidate',
  skip_memory_update_candidate: 'skipMemoryUpdateCandidate',
  suggest_memory_promotions: 'suggestMemoryPromotions',
  auto_promote_memory_candidates: 'autoPromoteMemoryCandidates',
  audit_memory_candidates: 'auditMemoryCandidates',
  reconcile_memory: 'reconcileMemory',
  promote_memory: 'promoteMemory',
  promote_memory_candidate: 'promoteMemoryCandidate',
  reject_memory_candidate: 'rejectMemoryCandidate',
  snooze_memory_candidate: 'snoozeMemoryCandidate',
  wake_memory_candidate: 'wakeMemoryCandidate',
  correct_memory: 'correctMemory',
  deactivate_memory: 'deactivateMemory',
});

const MCP_MUTATING_METHODS = new Set([
  'migrateScope', 'upsertWorkspaceProfile', 'deactivateWorkspaceProfile', 'upsertWorkspaceMember',
  'removeWorkspaceMember', 'upsertWorkspaceRoutingRule', 'removeWorkspaceRoutingRule', 'beginSession',
  'submitDistillJob', 'submitAuditJob', 'processJobs', 'cancelJob', 'processDueDistills',
  'processDueCandidateAudits', 'processDueCandidateWakeups',
  'processConsolidations', 'pruneEmbeddingArtifacts', 'rebuildEmbeddings', 'processEmbeddingJobs', 'remember',
  'appendRaw', 'pruneRawEvents', 'upsertSessionWorkingContext', 'distillCheckpoint', 'auditMemoryDuplicates',
  'applyMemoryUpdateCandidate', 'rejectMemoryUpdateCandidate', 'skipMemoryUpdateCandidate',
  'suggestMemoryPromotions', 'autoPromoteMemoryCandidates', 'auditMemoryCandidates', 'reconcileMemory',
  'promoteMemory', 'promoteMemoryCandidate', 'rejectMemoryCandidate', 'snoozeMemoryCandidate',
  'wakeMemoryCandidate', 'correctMemory', 'deactivateMemory',
]);

function uniqueEntries(groups, label) {
  const entries = Object.entries(groups).flatMap(([value, names]) => names.map((name) => [name, value]));
  const duplicates = entries.map(([name]) => name).filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicates.length) {
    throw new Error(`${label} assigns multiple values to: ${[...new Set(duplicates)].join(', ')}.`);
  }
  return new Map(entries);
}

const capabilityByName = uniqueEntries(CAPABILITY_GROUPS, 'Operation capability registry');
const scopeModeByName = uniqueEntries(SCOPE_MODE_GROUPS, 'Operation scope-mode registry');
const missingCapabilities = REMOTE_OPERATION_ORDER.filter((name) => !capabilityByName.has(name));
const unknownCapabilities = [...capabilityByName.keys()].filter((name) => !REMOTE_OPERATION_ORDER.includes(name));
const operationNames = [...REMOTE_OPERATION_ORDER];
const unknownScopeMethods = [...scopeModeByName.keys()].filter((name) => !capabilityByName.has(name));
const unknownMcpMethods = Object.values(MCP_METHODS).filter((name) => !capabilityByName.has(name));
const duplicateMcpMethods = Object.values(MCP_METHODS).filter(
  (name, index, names) => names.indexOf(name) !== index,
);
if (
  missingCapabilities.length ||
  unknownCapabilities.length ||
  unknownScopeMethods.length ||
  unknownMcpMethods.length ||
  duplicateMcpMethods.length
) {
  throw new Error(
    `Operation registry drifted (missing capabilities: ${missingCapabilities.join(', ') || 'none'}; ` +
      `unknown capabilities: ${unknownCapabilities.join(', ') || 'none'}; ` +
      `unknown scope methods: ${unknownScopeMethods.join(', ') || 'none'}; ` +
      `unknown MCP methods: ${unknownMcpMethods.join(', ') || 'none'}; duplicate MCP methods: ${duplicateMcpMethods.join(', ') || 'none'}).`,
  );
}

const mcpToolByMethod = new Map(Object.entries(MCP_METHODS).map(([tool, method]) => [method, tool]));

export const OPERATION_REGISTRY = Object.freeze(
  operationNames.map((name) => {
    const scopeMode = scopeModeByName.get(name) || 'scoped';
    const mcpTool = mcpToolByMethod.get(name) || null;
    return Object.freeze({
      name,
      capability: capabilityByName.get(name),
      scopeMode,
      remoteDispatch: ['process', 'all', 'workspace', 'migration'].includes(scopeMode)
        ? 'unscoped'
        : scopeMode === 'optional'
          ? 'optional'
          : 'scoped',
      mcp: mcpTool
        ? Object.freeze({
            tool: mcpTool,
            annotations: Object.freeze({ readOnlyHint: !MCP_MUTATING_METHODS.has(name) }),
          })
        : null,
    });
  }),
);

const byName = new Map(OPERATION_REGISTRY.map((operation) => [operation.name, operation]));
const byMcpTool = new Map(
  OPERATION_REGISTRY.filter((operation) => operation.mcp).map((operation) => [operation.mcp.tool, operation]),
);

export const REMOTE_OPERATION_NAMES = Object.freeze(OPERATION_REGISTRY.map((operation) => operation.name));
export const UNSCOPED_REMOTE_OPERATION_NAMES = Object.freeze(
  OPERATION_REGISTRY.filter((operation) => operation.remoteDispatch === 'unscoped').map((operation) => operation.name),
);
export const OPTIONALLY_SCOPED_REMOTE_OPERATION_NAMES = Object.freeze(
  OPERATION_REGISTRY.filter((operation) => operation.remoteDispatch === 'optional').map((operation) => operation.name),
);
export const MCP_OPERATION_TOOL_NAMES = Object.freeze(
  Object.keys(MCP_METHODS),
);

export function operationByName(name) {
  return byName.get(name) || null;
}

export function operationByMcpTool(tool) {
  return byMcpTool.get(tool) || null;
}
