import { MCP_OPERATION_TOOL_NAMES } from '../operations/registry.js';

export const ALL_MCP_TOOL_NAMES = MCP_OPERATION_TOOL_NAMES;
const AGENT_CORE_TOOLS = Object.freeze([
  'db_info', 'bootstrap_context', 'search', 'get_memory', 'remember',
  'list_checkpoints', 'list_memory_candidates', 'distill_checkpoint',
  'correct_memory', 'deactivate_memory',
]);
const AGENT_WORKFLOW_TOOLS = Object.freeze([
  'db_info',
  'bootstrap_context',
  'expand_memory_cluster',
  'resolve_workspace',
  'sync_resume_context',
  'begin_session',
  'session_status',
  'search',
  'get_memory',
  'remember',
  'append_raw',
  'get_working_summary',
  'list_checkpoints',
  'get_session_working_context',
  'upsert_session_working_context',
  'distill_checkpoint',
  'submit_distill_job',
  'get_job',
  'distill_usage',
  'list_memory_candidates',
  'suggest_memory_promotions',
  'promote_memory_candidate',
  'reject_memory_candidate',
  'reconcile_memory',
]);
const REVIEW_EXTRA_TOOLS = Object.freeze([
  'submit_audit_job',
  'plan_memory_candidate_backlog_audit', 'route_audited_memory_candidates',
  'list_due_candidate_audits',
  'list_due_candidate_stale_transitions',
  'list_due_candidate_wakeups',
  'snooze_memory_candidate',
  'wake_memory_candidate',
  'reopen_stale_memory_candidate',
  'list_memory_events',
  'list_preference_occurrences',
  'list_memory_update_candidates',
  'audit_memory_duplicates',
  'apply_memory_update_candidate',
  'reject_memory_update_candidate',
  'skip_memory_update_candidate',
  'auto_promote_memory_candidates',
  'audit_memory_candidates',
  'promote_memory',
  'correct_memory',
  'deactivate_memory',
]);
const WORKSPACE_ADMIN_TOOLS = Object.freeze([
  'db_info',
  'migrate_scope',
  'list_workspaces',
  'get_workspace',
  'resolve_workspace',
  'upsert_workspace_profile',
  'deactivate_workspace_profile',
  'upsert_workspace_member',
  'remove_workspace_member',
  'upsert_workspace_routing_rule',
  'remove_workspace_routing_rule',
]);

const WORKSPACE_MUTATION_TOOLS = new Set([
  'upsert_workspace_profile',
  'deactivate_workspace_profile',
  'upsert_workspace_member',
  'remove_workspace_member',
  'upsert_workspace_routing_rule',
  'remove_workspace_routing_rule',
]);
const canonicalToolList = (names) => {
  const selected = new Set(names);
  return Object.freeze(ALL_MCP_TOOL_NAMES.filter((name) => selected.has(name)));
};

export const MCP_TOOL_PROFILES = Object.freeze({
  'agent-core': canonicalToolList(AGENT_CORE_TOOLS),
  review: canonicalToolList([...AGENT_CORE_TOOLS, ...AGENT_WORKFLOW_TOOLS, ...REVIEW_EXTRA_TOOLS]),
  operator: Object.freeze(ALL_MCP_TOOL_NAMES.filter((name) => !WORKSPACE_MUTATION_TOOLS.has(name))),
  'workspace-admin': canonicalToolList(WORKSPACE_ADMIN_TOOLS),
  all: ALL_MCP_TOOL_NAMES,
});
function normalizeToolAllowlist(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(values.map((item) => String(item).trim()).filter(Boolean)));
}

export function resolveMcpToolSelection({ env = process.env, profile = null, tools = null } = {}) {
  const explicitTools = normalizeToolAllowlist(tools ?? env.CONTEXTFORGE_MCP_TOOLS);
  const requestedProfile = profile || env.CONTEXTFORGE_MCP_PROFILE || 'agent-core';
  const knownProfile = Object.hasOwn(MCP_TOOL_PROFILES, requestedProfile);
  if (!knownProfile && explicitTools.length === 0) {
    throw new Error(
      `Unknown ContextForge MCP profile: ${requestedProfile}. Available profiles: ${Object.keys(MCP_TOOL_PROFILES).join(', ')}.`,
    );
  }
  const selectedToolNames = explicitTools.length > 0 ? explicitTools : [...MCP_TOOL_PROFILES[requestedProfile]];
  const unknownTools = selectedToolNames.filter((name) => !ALL_MCP_TOOL_NAMES.includes(name));
  if (unknownTools.length > 0) {
    throw new Error(`Unknown ContextForge MCP tool(s): ${unknownTools.join(', ')}.`);
  }
  const enabledToolNames = canonicalToolList(selectedToolNames);
  return {
    profile: explicitTools.length > 0 ? 'custom' : requestedProfile,
    requestedProfile,
    explicitAllowlist: explicitTools.length > 0,
    warnings: !knownProfile
      ? [`Ignored unknown MCP profile ${requestedProfile} because an explicit tool allowlist was provided.`]
      : [],
    enabledToolNames,
    disabledToolNames: ALL_MCP_TOOL_NAMES.filter((name) => !enabledToolNames.includes(name)),
  };
}

