#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z } from 'zod';
import { createContextForge } from './core.js';
import { CONTEXTFORGE_VERSION } from './version.js';

const scopeSchema = z.enum(['shared', 'repo', 'local']);
const workspaceModeSchema = z.enum(['off', 'auto', 'strict']);
const consultReasonSchema = z.enum([
  'startup',
  'resume',
  'compaction_recovery',
  'agent_switch',
  'targeted_search',
  'live_state_check',
  'active_session',
  'unknown',
]);
const metadataSchema = z.record(z.string(), z.unknown());
const optionalTags = z.array(z.string()).optional();
const pageSchema = {
  limit: z.number().int().positive().max(500).optional(),
  cursor: z.string().optional(),
  page: z.boolean().optional(),
};
const workspaceRuleJsonSchema = z.record(z.string(), z.array(z.string()));
const closeoutTriggerSchema = z.enum([
  'agent_merged_pr',
  'user_merged_then_synced',
  'user_declared_work_done',
  'manual_closeout',
]);

export const ALL_MCP_TOOL_NAMES = Object.freeze([
  'db_info',
  'migrate_scope',
  'get_runtime_settings',
  'list_workspaces',
  'get_workspace',
  'resolve_workspace',
  'upsert_workspace_profile',
  'deactivate_workspace_profile',
  'upsert_workspace_member',
  'remove_workspace_member',
  'upsert_workspace_routing_rule',
  'remove_workspace_routing_rule',
  'bootstrap_context',
  'expand_memory_cluster',
  'sync_resume_context',
  'begin_session',
  'session_status',
  'submit_distill_job',
  'submit_audit_job',
  'get_job',
  'list_jobs',
  'process_jobs',
  'cancel_job',
  'list_due_distill_sessions',
  'process_due_distills',
  'list_due_consolidations',
  'process_consolidations',
  'search',
  'embedding_inventory',
  'prune_embedding_artifacts',
  'rebuild_embeddings',
  'process_embedding_jobs',
  'list_embedding_jobs',
  'get_memory',
  'remember',
  'append_raw',
  'prune_raw_events',
  'get_working_summary',
  'list_checkpoints',
  'get_session_working_context',
  'upsert_session_working_context',
  'distill_checkpoint',
  'distill_usage',
  'list_llm_usage_events',
  'llm_usage_rollup',
  'list_memory_events',
  'list_memory_candidates',
  'list_preference_occurrences',
  'list_memory_update_candidates',
  'audit_memory_duplicates',
  'apply_memory_update_candidate',
  'reject_memory_update_candidate',
  'skip_memory_update_candidate',
  'suggest_memory_promotions',
  'auto_promote_memory_candidates',
  'audit_memory_candidates',
  'reconcile_memory',
  'promote_memory',
  'promote_memory_candidate',
  'reject_memory_candidate',
  'correct_memory',
  'deactivate_memory',
]);

const AGENT_CORE_TOOLS = Object.freeze([
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
  review: canonicalToolList([...AGENT_CORE_TOOLS, ...REVIEW_EXTRA_TOOLS]),
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

const scopedSchema = {
  scope: scopeSchema.optional(),
  scopeKey: z.string().optional(),
  cwd: z.string().optional(),
  repoPath: z.string().optional(),
};

function jsonResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: { result },
  };
}

const MCP_INSTRUCTIONS = [
  'Use ContextForge for scoped memory retrieval on demand.',
  'At non-trivial task start or resume, call bootstrap_context with repoPath/cwd or scopeKey and the matching consultReason. Use db_info to distinguish remote canonical storage from checkout-local context.',
  'Trust roles differ: memory is reviewed durable state, checkpoint is recent handoff that needs live-state verification, and memory_candidate is unreviewed. Verify mutable git, CI, runtime, and migration claims at their live source.',
  'bootstrap_context does not create sessions. Preserve adapter ids such as codex:<id> or claude_code:<id>; use begin_session only for manual append_raw streams. Keep local scope opt-in.',
  'Distill failure must not erase raw evidence. At closeout, retain checkpointId and review candidates before promotion. Audit persists review metadata but does not itself promote durable memory.',
  'Use durable submit/get job tools when provider work must survive disconnects; an operator must process queued jobs. Queued cancellation is guaranteed, running force-cancel is not, and candidate audit remains per-candidate rather than true provider batching.',
  'Embedding maintenance is operator-profile work; inspect db_info coverage before handing it to an operator.',
  'Profiles intentionally hide tools. Use the packaged contextforge-memory skill for detailed review, reconciliation, consolidation, embeddings, workspace administration, and closeout workflows.',
].join(' ');

function mcpSurfaceInfo(toolRegistrations, selection) {
  const measuredTools = toolRegistrations.map(({ name, config }) => {
    const inputSchemaSource =
      config.inputSchema && Object.keys(config.inputSchema).length === 0 ? z.object({}) : config.inputSchema;
    const normalizedInputSchema = normalizeObjectSchema(inputSchemaSource);
    const inputSchema = normalizedInputSchema
      ? toJsonSchemaCompat(normalizedInputSchema, { strictUnions: true, pipeStrategy: 'input' })
      : { type: 'object', properties: {} };
    const schema = {
      name,
      ...(config.title ? { title: config.title } : {}),
      ...(config.description ? { description: config.description } : {}),
      inputSchema,
      ...(config.annotations ? { annotations: config.annotations } : {}),
      execution: { taskSupport: 'forbidden' },
      ...(config._meta ? { _meta: config._meta } : {}),
    };
    const normalizedOutputSchema = normalizeObjectSchema(config.outputSchema);
    if (normalizedOutputSchema) {
      schema.outputSchema = toJsonSchemaCompat(normalizedOutputSchema, {
        strictUnions: true,
        pipeStrategy: 'output',
      });
    }
    return {
      schema,
      info: {
        name,
        descriptionBytes: Buffer.byteLength(config.description || '', 'utf8'),
        schemaBytes: Buffer.byteLength(JSON.stringify(schema), 'utf8'),
      },
    };
  });
  const tools = measuredTools.map(({ info }) => info);
  const instructionsBytes = Buffer.byteLength(MCP_INSTRUCTIONS, 'utf8');
  const toolSchemaBytes = Buffer.byteLength(
    JSON.stringify({ tools: measuredTools.map(({ schema }) => schema) }),
    'utf8',
  );
  const descriptionBytes = tools.reduce((total, tool) => total + tool.descriptionBytes, 0);
  return {
    ...selection,
    toolCount: tools.length,
    totalKnownToolCount: ALL_MCP_TOOL_NAMES.length,
    instructionsBytes,
    toolSchemaBytes,
    descriptionBytes,
    estimatedInitialTokens: Math.ceil((instructionsBytes + toolSchemaBytes) / 4),
    tools,
  };
}

export function getContextForgeMcpSurfaceInfo(server) {
  return server.contextForgeSurface;
}

export function createContextForgeMcpServer({
  app = null,
  env = process.env,
  profile = null,
  tools = null,
} = {}) {
  const selection = resolveMcpToolSelection({ env, profile, tools });
  app ||= createContextForge({ env });
  const enabledTools = new Set(selection.enabledToolNames);
  const server = new McpServer(
    {
      name: 'contextforge',
      version: CONTEXTFORGE_VERSION,
    },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );
  const toolDefinitions = [];
  const toolRegistrations = [];
  const sdkRegisterTool = server.registerTool.bind(server);
  const registerTool = (name, config, handler) => {
    toolDefinitions.push(name);
    if (!enabledTools.has(name)) return null;
    toolRegistrations.push({ name, config });
    return sdkRegisterTool(name, config, handler);
  };

  registerTool(
    'db_info',
    {
      title: 'Database Info',
      description:
        'Inspect ContextForge connection metadata, storage backend, table counts, raw retention, and sqlite-vec/embeddings readiness. Prefer connection.summary and accessMode/accessPath for caller access path; top-level storageMode describes the responding process.',
      inputSchema: {},
      annotations: {
        title: 'Database Info',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => jsonResult(await app.dbInfo()),
  );

  registerTool(
    'migrate_scope',
    {
      title: 'Migrate Scope',
      description:
        'Move existing rows from one explicit scope key to another after a repository rename or transfer. Defaults to dryRun=true and reports row counts plus conflicts; use dryRun=false only after reviewing the dry-run result. The from scope is treated as the raw stored scope and is not alias-canonicalized.',
      inputSchema: {
        fromScope: scopeSchema.optional(),
        fromScopeType: scopeSchema.optional(),
        fromScopeKey: z.string(),
        toScope: scopeSchema.optional(),
        toScopeType: scopeSchema.optional(),
        toScopeKey: z.string(),
        dryRun: z.boolean().optional(),
      },
      annotations: {
        title: 'Migrate Scope',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.migrateScope(args)),
  );

  registerTool(
    'get_runtime_settings',
    {
      title: 'Get Runtime Settings',
      description:
        'Inspect effective ContextForge runtime settings, including distill provider, distill policy, provider model settings, presets, and secret-present flags. Secret values are never returned.',
      inputSchema: {},
      annotations: {
        title: 'Get Runtime Settings',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => jsonResult(await app.getRuntimeSettings()),
  );

  registerTool(
    'list_workspaces',
    {
      title: 'List Workspaces',
      description:
        'List ContextForge workspace profiles. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        status: z.enum(['active', 'inactive', 'all']).optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'List Workspaces',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listWorkspaceProfiles(args)),
  );

  registerTool(
    'get_workspace',
    {
      title: 'Get Workspace',
      description:
        'Read one ContextForge workspace profile with members and routing rules. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
        includeInactive: z.boolean().optional(),
      },
      annotations: {
        title: 'Get Workspace',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.getWorkspaceProfile(args)),
  );

  registerTool(
    'resolve_workspace',
    {
      title: 'Resolve Workspace',
      description:
        'Resolve a workspace scope plan for a primary scope and query. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
        workspaceMode: workspaceModeSchema.optional(),
        mode: workspaceModeSchema.optional(),
        primaryScope: scopeSchema.optional(),
        primaryScopeType: scopeSchema.optional(),
        primaryScopeKey: z.string().optional(),
        scope: scopeSchema.optional(),
        scopeKey: z.string().optional(),
        query: z.string().optional(),
        consultReason: consultReasonSchema.optional(),
        includeShared: z.boolean().optional(),
      },
      annotations: {
        title: 'Resolve Workspace',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.resolveWorkspace(args)),
  );

  registerTool(
    'upsert_workspace_profile',
    {
      title: 'Upsert Workspace Profile',
      description:
        'Create, update, or reactivate a ContextForge workspace profile. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
        displayName: z.string().optional(),
        canonicalScope: scopeSchema.optional(),
        canonicalScopeType: scopeSchema.optional(),
        canonicalScopeKey: z.string().optional(),
        status: z.enum(['active', 'inactive']).optional(),
        metadata: metadataSchema.optional(),
      },
      annotations: {
        title: 'Upsert Workspace Profile',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.upsertWorkspaceProfile(args)),
  );

  registerTool(
    'deactivate_workspace_profile',
    {
      title: 'Deactivate Workspace Profile',
      description:
        'Soft-delete a ContextForge workspace profile by marking it inactive. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
      },
      annotations: {
        title: 'Deactivate Workspace Profile',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.deactivateWorkspaceProfile(args)),
  );

  registerTool(
    'upsert_workspace_member',
    {
      title: 'Upsert Workspace Member',
      description:
        'Create or update a member scope in a ContextForge workspace profile. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
        name: z.string(),
        scope: scopeSchema.optional(),
        scopeType: scopeSchema.optional(),
        scopeKey: z.string(),
        role: z.string().optional(),
        priority: z.number().int().optional(),
        includeByDefault: z.boolean().optional(),
        allowLocal: z.boolean().optional(),
        metadata: metadataSchema.optional(),
      },
      annotations: {
        title: 'Upsert Workspace Member',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.upsertWorkspaceMember(args)),
  );

  registerTool(
    'remove_workspace_member',
    {
      title: 'Remove Workspace Member',
      description:
        'Remove one member scope from a ContextForge workspace profile. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
        name: z.string().optional(),
        memberName: z.string().optional(),
        scope: scopeSchema.optional(),
        scopeType: scopeSchema.optional(),
        scopeKey: z.string().optional(),
      },
      annotations: {
        title: 'Remove Workspace Member',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.removeWorkspaceMember(args)),
  );

  registerTool(
    'upsert_workspace_routing_rule',
    {
      title: 'Upsert Workspace Routing Rule',
      description:
        'Create or update a routing rule for a ContextForge workspace profile. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
        ruleKey: z.string(),
        priority: z.number().int().optional(),
        match: workspaceRuleJsonSchema.optional(),
        include: workspaceRuleJsonSchema.optional(),
        exclude: workspaceRuleJsonSchema.optional(),
        includeShared: z.boolean().optional(),
        status: z.enum(['active', 'inactive']).optional(),
        metadata: metadataSchema.optional(),
      },
      annotations: {
        title: 'Upsert Workspace Routing Rule',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.upsertWorkspaceRoutingRule(args)),
  );

  registerTool(
    'remove_workspace_routing_rule',
    {
      title: 'Remove Workspace Routing Rule',
      description:
        'Remove one routing rule from a ContextForge workspace profile. Workspace profiles do not change storage mode. They define which existing scopes are consulted together.',
      inputSchema: {
        workspaceKey: z.string(),
        ruleKey: z.string(),
      },
      annotations: {
        title: 'Remove Workspace Routing Rule',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.removeWorkspaceRoutingRule(args)),
  );

  registerTool(
    'bootstrap_context',
    {
      title: 'Bootstrap Context',
      description:
        'Resolve scoped ContextForge memory for startup/resume/compaction recovery in one call. Includes query-independent latest checkpoint handoff (default 1, max 3) before search results, plus a compact memoryMap for progressive durable-memory navigation. Pass workspaceKey to add a separate bounded workspace federation block; workspace profiles define which existing scopes are consulted together and do not change storage mode. Pass consultReason to distinguish startup/resume/compaction_recovery/agent_switch from active_session, targeted_search, or live_state_check. During active work, prefer search for file/API/error/domain lookups and live sources for mutable state. Does not create a session; pass a known Codex/Claude/ContextForge sessionId to load session working state. rawTailLimit defaults to 0; set a positive value to include raw tail.',
      inputSchema: {
        ...scopedSchema,
        query: z.string(),
        consultReason: consultReasonSchema.optional(),
        sessionId: z.string().optional(),
        rawTailLimit: z.number().int().nonnegative().optional(),
        latestCheckpointLimit: z.number().int().min(0).max(3).optional(),
        relatedScopeKeys: z.array(z.string()).optional(),
        includeShared: z.boolean().optional(),
        workspaceKey: z.string().optional(),
        workspaceMode: workspaceModeSchema.optional(),
        workspaceResultLimit: z.number().int().positive().optional(),
        workspacePerScopeLimit: z.number().int().positive().optional(),
        includeWorkspaceHandoffs: z.boolean().optional(),
        includePrimaryInWorkspaceResults: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        memoryMapLimit: z.number().int().positive().max(20).optional(),
        memoryMapClusterSize: z.number().int().positive().max(20).optional(),
        sharedScopeKey: z.string().optional(),
      },
      annotations: {
        title: 'Bootstrap Context',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.bootstrapContext(args)),
  );

  registerTool(
    'expand_memory_cluster',
    {
      title: 'Expand Memory Cluster',
      description:
        'Expand one durable-memory map cluster on demand. Pass clusterId from bootstrap_context.memoryMap or a query to select the top matching cluster. Keeps provenance disabled by default; set includeProvenance only when the evidence trail is needed.',
      inputSchema: {
        ...scopedSchema,
        clusterId: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().positive().max(20).optional(),
        memoryMapLimit: z.number().int().positive().max(20).optional(),
        memoryMapClusterSize: z.number().int().positive().max(20).optional(),
        includeProvenance: z.boolean().optional(),
        sharedScopeKey: z.string().optional(),
      },
      annotations: {
        title: 'Expand Memory Cluster',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.expandMemoryCluster(args)),
  );

  registerTool(
    'sync_resume_context',
    {
      title: 'Sync Resume Context',
      description:
        'Build a resume/compaction/agent-transfer handoff package for continuing work across machines or agent environments. Use checkpoints as credible recent handoff notes, durable memories as canonical long-term context, and memory candidates only as review material. Do not use this as routine active-session self-confirmation. rawTailLimit defaults to 0; set a positive value to include raw tail. This tool must not propose or perform durable memory promotion.',
      inputSchema: {
        ...scopedSchema,
        query: z.string(),
        consultReason: consultReasonSchema.optional(),
        sessionId: z.string().optional(),
        includeShared: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        rawTailLimit: z.number().int().nonnegative().optional(),
        sharedScopeKey: z.string().optional(),
      },
      annotations: {
        title: 'Sync Resume Context',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.syncResumeContext(args)),
  );

  registerTool(
    'begin_session',
    {
      title: 'Begin Session',
      description:
        'Create a ContextForge session id for a scoped agent run. Pass repoPath or cwd when the active repository differs from the MCP process cwd; repoPath takes precedence. Pass scopeKey to pin the canonical repo memory key.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        conversationId: z.string().optional(),
      },
      annotations: {
        title: 'Begin Session',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.beginSession(args)),
  );

  registerTool(
    'session_status',
    {
      title: 'Session Status',
      description:
        'Inspect raw evidence and checkpoint thresholds for a session before deciding whether to distill. At closeout, use latestCheckpointId/latestCheckpointMemoryCandidateCount with suggest_memory_promotions or list_memory_candidates for the same session.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
        minEvents: z.number().int().positive().optional(),
        minIntervalMs: z.number().int().positive().optional(),
        charMinIntervalMs: z.number().int().positive().optional(),
        charThreshold: z.number().int().positive().optional(),
        maxEvents: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'Session Status',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.sessionStatus(args)),
  );

  registerTool(
    'submit_distill_job',
    {
      title: 'Submit Distill Job',
      description:
        'Durably queue a checkpoint distillation and return immediately. Duplicate submissions for the same scoped source window and policy reuse one job unless an explicit idempotencyKey is supplied.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
        conversationId: z.string().optional(),
        provider: z.string().optional(),
        maxEvents: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
        level: z.number().int().nonnegative().optional(),
        auditTrigger: closeoutTriggerSchema.optional(),
        idempotencyKey: z.string().optional(),
        maxAttempts: z.number().int().positive().optional(),
        priority: z.number().int().optional(),
        retryFailed: z.boolean().optional(),
        submittedBy: z.string().optional(),
      },
      annotations: {
        title: 'Submit Distill Job',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.submitDistillJob(args)),
  );

  registerTool(
    'submit_audit_job',
    {
      title: 'Submit Candidate Audit Job',
      description:
        'Durably queue closeout-scoped candidate audits and return immediately. The current worker invokes the configured provider once per selected candidate; true provider batching is not implied.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        checkpointId: z.string().optional(),
        trigger: closeoutTriggerSchema,
        limit: z.number().int().positive().optional(),
        scanLimit: z.number().int().positive().optional(),
        minConfidence: z.number().optional(),
        minStability: z.number().optional(),
        allowedCategories: z.array(z.string()).optional(),
        promotionRecommendation: z.string().optional(),
        force: z.boolean().optional(),
        idempotencyKey: z.string().optional(),
        maxAttempts: z.number().int().positive().optional(),
        priority: z.number().int().optional(),
        retryFailed: z.boolean().optional(),
        submittedBy: z.string().optional(),
      },
      annotations: {
        title: 'Submit Candidate Audit Job',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.submitAuditJob(args)),
  );

  registerTool(
    'get_job',
    {
      title: 'Get Operation Job',
      description: 'Read one durable distill or candidate-audit job, including state, attempts, lease, result, and failure details.',
      inputSchema: {
        ...scopedSchema,
        jobId: z.string(),
      },
      annotations: {
        title: 'Get Operation Job',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.getJob(args)),
  );

  registerTool(
    'list_jobs',
    {
      title: 'List Operation Jobs',
      description: 'List bounded durable distill and candidate-audit jobs, optionally narrowed by scope, operation, state, session, or checkpoint.',
      inputSchema: {
        ...scopedSchema,
        operation: z.enum(['distill_checkpoint', 'audit_memory_candidates']).optional(),
        status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
        sessionId: z.string().optional(),
        checkpointId: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
      annotations: {
        title: 'List Operation Jobs',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listJobs(args)),
  );

  registerTool(
    'process_jobs',
    {
      title: 'Process Operation Jobs',
      description:
        'Claim and execute one bounded durable job batch as an operator worker. Expired leases are recovered before claims. This call waits for claimed provider work to finish.',
      inputSchema: {
        operation: z.enum(['distill_checkpoint', 'audit_memory_candidates']).optional(),
        operations: z.array(z.enum(['distill_checkpoint', 'audit_memory_candidates'])).optional(),
        limit: z.number().int().positive().max(25).optional(),
        leaseMs: z.number().int().min(1000).optional(),
        workerId: z.string().optional(),
      },
      annotations: {
        title: 'Process Operation Jobs',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => jsonResult(await app.processJobs(args)),
  );

  registerTool(
    'cancel_job',
    {
      title: 'Cancel Queued Operation Job',
      description:
        'Cancel a queued durable operation job. Running provider calls are reported as running_not_interruptible and are not force-terminated.',
      inputSchema: {
        ...scopedSchema,
        jobId: z.string(),
        reason: z.string().optional(),
      },
      annotations: {
        title: 'Cancel Queued Operation Job',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.cancelJob(args)),
  );

  registerTool(
    'list_due_distill_sessions',
    {
      title: 'List Due Distill Sessions',
      description:
        'Scan for sessions with raw evidence after the latest checkpoint coverage that are due for distillation. This is read-only and bounded by limit/scanLimit; idleMs avoids active sessions.',
      inputSchema: {
        ...scopedSchema,
        limit: z.number().int().positive().optional(),
        scanLimit: z.number().int().positive().optional(),
        idleMs: z.number().int().nonnegative().optional(),
        activeRunMaxAgeMs: z.number().int().nonnegative().optional(),
        order: z.enum(['asc', 'desc']).optional(),
        minEvents: z.number().int().positive().optional(),
        minIntervalMs: z.number().int().positive().optional(),
        charMinIntervalMs: z.number().int().positive().optional(),
        charThreshold: z.number().int().positive().optional(),
        maxEvents: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'List Due Distill Sessions',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listDueDistillSessions(args)),
  );

  registerTool(
    'process_due_distills',
    {
      title: 'Process Due Distills',
      description:
        'Run a small catch-up batch of due session distillations. Use dryRun=true to inspect first; limit defaults to 5 and idleMs avoids active sessions.',
      inputSchema: {
        ...scopedSchema,
        limit: z.number().int().positive().optional(),
        scanLimit: z.number().int().positive().optional(),
        idleMs: z.number().int().nonnegative().optional(),
        activeRunMaxAgeMs: z.number().int().nonnegative().optional(),
        order: z.enum(['asc', 'desc']).optional(),
        provider: z.string().optional(),
        dryRun: z.boolean().optional(),
        minEvents: z.number().int().positive().optional(),
        minIntervalMs: z.number().int().positive().optional(),
        charMinIntervalMs: z.number().int().positive().optional(),
        charThreshold: z.number().int().positive().optional(),
        maxEvents: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'Process Due Distills',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.processDueDistills(args)),
  );

  const consolidationSchema = {
    ...scopedSchema,
    sessionId: z.string().optional(),
    target: z.enum(['thread', 'repo']).optional(),
    windowKind: z.enum(['daily', 'custom']).optional(),
    day: z.string().optional(),
    coversFrom: z.string().optional(),
    coversTo: z.string().optional(),
    source: z.enum(['distill', 'daily_consolidation', 'weekly_consolidation', 'topic_batch', 'manual']).optional(),
    sourceRef: z.string().optional(),
    provider: z.string().optional(),
    maxCheckpoints: z.number().int().positive().optional(),
    minCheckpoints: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
  };

  registerTool(
    'list_due_consolidations',
    {
      title: 'List Due Consolidations',
      description:
        'Dry-run checkpoint consolidation for a thread or repo time window. Consolidation recompresses short checkpoint streams by scope and time window so bootstrap_context can include period context without dumping raw evidence.',
      inputSchema: consolidationSchema,
      annotations: {
        title: 'List Due Consolidations',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listDueConsolidations(args)),
  );

  registerTool(
    'process_consolidations',
    {
      title: 'Process Consolidations',
      description:
        'Create checkpoint consolidation records for a thread or repo time window. Use dryRun=true first; created consolidation checkpoints are handoff context, not durable memory, and rawTail remains opt-in.',
      inputSchema: {
        ...consolidationSchema,
        dryRun: z.boolean().optional(),
      },
      annotations: {
        title: 'Process Consolidations',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.processConsolidations(args)),
  );

  registerTool(
    'search',
    {
      title: 'Search Memory',
      description:
        'Search bounded indexed memory/checkpoint/memory_candidate results. includeDiagnostics preserves zero-hit metrics. Window=min(max(limit*4,50),candidateLimit), capped at 500; results at 100. legacyFullScan is diagnostic only. Use scope or workspaceKey for bounded workspace federation.',
      inputSchema: {
        ...scopedSchema,
        query: z.string(),
        limit: z.number().int().positive().optional(),
        candidateLimit: z.number().int().positive().optional(),
        legacyFullScan: z.boolean().optional(),
        includeDiagnostics: z.boolean().optional(),
        searchScopes: z.enum(['scope', 'repo', 'shared', 'repo+shared', 'local']).optional(),
        sharedScopeKey: z.string().optional(),
        workspaceKey: z.string().optional(),
        workspaceMode: workspaceModeSchema.optional(),
        workspaceResultLimit: z.number().int().positive().optional(),
        workspacePerScopeLimit: z.number().int().positive().optional(),
        includeWorkspaceHandoffs: z.boolean().optional(),
        includePrimaryInWorkspaceResults: z.boolean().optional(),
        consultReason: consultReasonSchema.optional(),
      },
      annotations: {
        title: 'Search Memory',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.search(args)),
  );

  registerTool(
    'embedding_inventory',
    {
      title: 'Embedding Maintenance Inventory',
      description: 'Inspect orphaned, inactive, stale-hash, retired-model, and old terminal embedding artifacts without deleting them.',
      inputSchema: {
        ...scopedSchema,
        scanLimit: z.number().int().positive().max(50000).optional(),
        completedJobRetentionDays: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'Embedding Maintenance Inventory',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.embeddingInventory(args)),
  );

  registerTool(
    'prune_embedding_artifacts',
    {
      title: 'Prune Embedding Artifacts',
      description: 'Dry-run by default, then delete one bounded batch of eligible derived vector/index/job artifacts after backup and worker quiescence.',
      inputSchema: {
        ...scopedSchema,
        scanLimit: z.number().int().positive().max(50000).optional(),
        completedJobRetentionDays: z.number().int().positive().optional(),
        batchSize: z.number().int().positive().max(500).optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
      annotations: {
        title: 'Prune Embedding Artifacts',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.pruneEmbeddingArtifacts(args)),
  );

  registerTool(
    'rebuild_embeddings',
    {
      title: 'Rebuild Embeddings',
      description:
        'Backfill or rebuild the derived sqlite-vec embedding index for durable memories, checkpoints, and memory candidates. Requires an embeddings provider such as OpenAI to be configured. Pass force=true only when intentionally resetting the index after an embedding dimension change.',
      inputSchema: {
        ...scopedSchema,
        batchSize: z.number().int().positive().optional(),
        force: z.boolean().optional(),
      },
      annotations: {
        title: 'Rebuild Embeddings',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.rebuildEmbeddings(args)),
  );

  registerTool(
    'process_embedding_jobs',
    {
      title: 'Process Embedding Jobs',
      description:
        'Process queued embedding jobs for durable memories, checkpoints, and memory candidates. Use to retry stale or failed vector index work independently from writes.',
      inputSchema: {
        ...scopedSchema,
        batchSize: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        retryFailed: z.boolean().optional(),
        staleAfterMs: z.number().int().positive().optional(),
        force: z.boolean().optional(),
      },
      annotations: {
        title: 'Process Embedding Jobs',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.processEmbeddingJobs(args)),
  );

  registerTool(
    'list_embedding_jobs',
    {
      title: 'List Embedding Jobs',
      description:
        'List queued embedding job state. Jobs record source type/id, attempts, last error, status, and completion time.',
      inputSchema: {
        ...scopedSchema,
        status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
        ...pageSchema,
      },
      annotations: {
        title: 'List Embedding Jobs',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listEmbeddingJobs(args)),
  );

  registerTool(
    'get_memory',
    {
      title: 'Get Memory',
      description: 'Fetch one durable memory by key from a specific scope.',
      inputSchema: {
        ...scopedSchema,
        key: z.string(),
      },
      annotations: {
        title: 'Get Memory',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.getMemory(args)),
  );

  registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        'Create or update an intentional durable memory in the requested scope; use for important facts, decisions, preferences, or runbook notes that should outlive the session.',
      inputSchema: {
        ...scopedSchema,
        key: z.string(),
        content: z.string(),
        category: z.string().optional(),
        tags: optionalTags,
        importance: z.number().int().optional(),
      },
      annotations: {
        title: 'Remember',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.remember(args)),
  );

  registerTool(
    'append_raw',
    {
      title: 'Append Raw Evidence',
      description: 'Append raw scoped evidence for later distillation and debugging.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
        conversationId: z.string().optional(),
        role: z.enum(['user', 'assistant']),
        content: z.string(),
        metadata: metadataSchema.optional(),
      },
      annotations: {
        title: 'Append Raw Evidence',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.appendRaw(args)),
  );

  registerTool(
    'prune_raw_events',
    {
      title: 'Prune Raw Evidence',
      description:
        'Delete only raw evidence older than the configured TTL that is covered by a successful level-0 checkpoint. Sessions without successful coverage or with a latest failed/incomplete distill run are blocked. Use dryRun to inspect session-level eligibility; force explicitly restores age-only deletion.',
      inputSchema: {
        ttlDays: z.number().int().positive().optional(),
        dryRun: z.boolean().optional(),
        force: z.boolean().optional(),
      },
      annotations: {
        title: 'Prune Raw Evidence',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.pruneRawEvents(args)),
  );

  registerTool(
    'get_working_summary',
    {
      title: 'Get Working Summary',
      description:
        'Fetch the latest rolling working summary for one scoped session. This is live continuation state, not reviewed durable memory.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
      },
      annotations: {
        title: 'Get Working Summary',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.getWorkingSummary(args)),
  );

  registerTool(
    'list_checkpoints',
    {
      title: 'List Checkpoints',
      description:
        'List scoped checkpoints, optionally filtered by sessionId and checkpoint level. Level 0 is the default session distill level.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        level: z.number().int().nonnegative().optional(),
        ...pageSchema,
      },
      annotations: {
        title: 'List Checkpoints',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listCheckpoints(args)),
  );

  registerTool(
    'get_session_working_context',
    {
      title: 'Get Session Working Context',
      description:
        'Fetch structured mutable working context for one scoped session. This is live resume state, not durable canonical memory.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
      },
      annotations: {
        title: 'Get Session Working Context',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.getSessionWorkingContext(args)),
  );

  registerTool(
    'upsert_session_working_context',
    {
      title: 'Upsert Session Working Context',
      description:
        'Create or update structured mutable working context for the current scoped session. Use for live task state only, not durable memory.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
        conversationId: z.string().optional(),
        mode: z.string().optional(),
        currentTask: z.string().optional(),
        currentUserIntent: z.string().optional(),
        targetSubject: z.string().optional(),
        sourceSubject: z.string().optional(),
        lastUserCorrection: z.string().optional(),
        openQuestion: z.string().optional(),
        nonGoals: z.array(z.string()).optional(),
        avoidMisreadings: z.array(z.string()).optional(),
        confidence: z.number().optional(),
        metadata: metadataSchema.optional(),
      },
      annotations: {
        title: 'Upsert Session Working Context',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.upsertSessionWorkingContext(args)),
  );

  registerTool(
    'distill_checkpoint',
    {
      title: 'Distill Checkpoint',
      description:
        'Distill raw session evidence into a checkpoint with the configured provider. Returns checkpointId and memoryCandidateCount. Candidate audit runs automatically in scoped batches when auditTrigger is supplied or the batch threshold is reached; automatic promotion only writes approved strict-safe audit results when enabled. Periodic checkpoint consolidation is handled by process_consolidations.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
        conversationId: z.string().optional(),
        provider: z.string().optional(),
        maxEvents: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
        level: z.number().int().nonnegative().optional(),
        coversFrom: z.string().optional(),
        coversTo: z.string().optional(),
        source: z.enum(['distill', 'daily_consolidation', 'weekly_consolidation', 'topic_batch', 'manual']).optional(),
        sourceRef: z.string().optional(),
        auditTrigger: z
          .enum(['agent_merged_pr', 'user_merged_then_synced', 'user_declared_work_done', 'manual_closeout'])
          .optional(),
      },
      annotations: {
        title: 'Distill Checkpoint',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.distillCheckpoint(args)),
  );

  registerTool(
    'distill_usage',
    {
      title: 'Distill Usage',
      description:
        'Summarize distillation run usage for one session, including selected raw-event characters, estimated input tokens, actual provider usage when recorded, status counts, and elapsed time.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
        charsPerToken: z.number().positive().optional(),
      },
      annotations: {
        title: 'Distill Usage',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.distillUsage(args)),
  );

  registerTool(
    'list_llm_usage_events',
    {
      title: 'List LLM Usage Events',
      description:
        'List persisted normalized LLM usage events for a scope, optionally filtered by session, durable job, distill run, checkpoint, candidate, operation, or provider.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        distillRunId: z.string().optional(),
        checkpointId: z.string().optional(),
        candidateId: z.string().optional(),
        jobId: z.string().optional(),
        operation: z.string().optional(),
        provider: z.string().optional(),
        ...pageSchema,
        order: z.enum(['asc', 'desc']).optional(),
      },
      annotations: {
        title: 'List LLM Usage Events',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listLlmUsageEvents(args)),
  );

  registerTool(
    'llm_usage_rollup',
    {
      title: 'LLM Usage Rollup',
      description:
        'Report persisted LLM usage totals by operation, provider/model, and provider/model/operation for a scope.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        distillRunId: z.string().optional(),
        checkpointId: z.string().optional(),
        candidateId: z.string().optional(),
        jobId: z.string().optional(),
        operation: z.string().optional(),
        provider: z.string().optional(),
        limit: z.number().int().positive().optional(),
        order: z.enum(['asc', 'desc']).optional(),
        includeEvents: z.boolean().optional(),
      },
      annotations: {
        title: 'LLM Usage Rollup',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.llmUsageRollup(args)),
  );

  registerTool(
    'list_memory_events',
    {
      title: 'List Memory Events',
      description: 'List provenance events for one durable memory key.',
      inputSchema: {
        ...scopedSchema,
        key: z.string(),
        ...pageSchema,
      },
      annotations: {
        title: 'List Memory Events',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listMemoryEvents(args)),
  );

  registerTool(
    'list_memory_candidates',
    {
      title: 'List Memory Candidates',
      description:
        'List memory candidates saved on distilled checkpoints without promoting them. At closeout, pass the same sessionId or checkpointId used for the current work; omitting both reviews the broader scope queue rather than the current closeout source.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        checkpointId: z.string().optional(),
        status: z.enum(['pending', 'promoted', 'rejected', 'stale', 'snoozed']).optional(),
        candidateType: z.string().optional(),
        promotionRecommendation: z.string().optional(),
        sort: z.enum(['created', 'recommendation']).optional(),
        ...pageSchema,
      },
      annotations: {
        title: 'List Memory Candidates',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listMemoryCandidates(args)),
  );

  registerTool(
    'list_preference_occurrences',
    {
      title: 'List Preference Occurrences',
      description:
        'List merged preference occurrence evidence tracked from preference-like memory candidates. Use for review; do not auto-promote preferences solely from this output.',
      inputSchema: {
        ...scopedSchema,
        status: z.enum(['active', 'weakened', 'superseded', 'rejected']).optional(),
        ...pageSchema,
      },
      annotations: {
        title: 'List Preference Occurrences',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listPreferenceOccurrences(args)),
  );

  registerTool(
    'list_memory_update_candidates',
    {
      title: 'List Memory Update Candidates',
      description:
        'List pending or reviewed candidates for updating existing durable memory. These are review proposals only and do not mutate memory.',
      inputSchema: {
        ...scopedSchema,
        status: z.enum(['pending', 'applied', 'rejected', 'skipped']).optional(),
        action: z
          .enum(['correct_memory', 'deactivate_memory', 'merge_duplicate_memories', 'add_corrective_note'])
          .optional(),
        ...pageSchema,
      },
      annotations: {
        title: 'List Memory Update Candidates',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listMemoryUpdateCandidates(args)),
  );

  registerTool(
    'audit_memory_duplicates',
    {
      title: 'Audit Memory Duplicates',
      description:
        'Detect overlapping active durable memories in a scope and optionally persist merge_duplicate_memories update candidates. Read-only unless createUpdateCandidates=true.',
      inputSchema: {
        ...scopedSchema,
        minOverlap: z.number().min(0).max(1).optional(),
        scanLimit: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        createUpdateCandidates: z.boolean().optional(),
      },
      annotations: {
        title: 'Audit Memory Duplicates',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.auditMemoryDuplicates(args)),
  );

  registerTool(
    'apply_memory_update_candidate',
    {
      title: 'Apply Memory Update Candidate',
      description:
        'Apply a reviewed memory update candidate by correcting, deactivating, or adding a corrective durable memory note. Use only after explicit user approval.',
      inputSchema: {
        ...scopedSchema,
        candidateId: z.string(),
        key: z.string().optional(),
        mergeTargetKey: z.string().optional(),
        content: z.string().optional(),
        category: z.string().optional(),
        tags: optionalTags,
        importance: z.number().int().optional(),
        reason: z.string().optional(),
        allowStatusOverride: z.boolean().optional(),
      },
      annotations: {
        title: 'Apply Memory Update Candidate',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.applyMemoryUpdateCandidate(args)),
  );

  registerTool(
    'reject_memory_update_candidate',
    {
      title: 'Reject Memory Update Candidate',
      description: 'Reject a reviewed memory update candidate without mutating durable memory.',
      inputSchema: {
        ...scopedSchema,
        candidateId: z.string(),
        reason: z.string(),
        allowStatusOverride: z.boolean().optional(),
      },
      annotations: {
        title: 'Reject Memory Update Candidate',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.rejectMemoryUpdateCandidate(args)),
  );

  registerTool(
    'skip_memory_update_candidate',
    {
      title: 'Skip Memory Update Candidate',
      description: 'Mark a memory update candidate skipped without mutating durable memory.',
      inputSchema: {
        ...scopedSchema,
        candidateId: z.string(),
        reason: z.string().optional(),
        allowStatusOverride: z.boolean().optional(),
      },
      annotations: {
        title: 'Skip Memory Update Candidate',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.skipMemoryUpdateCandidate(args)),
  );

  registerTool(
    'suggest_memory_promotions',
    {
      title: 'Suggest Memory Promotions',
      description:
        'Suggest at most 1-3 high-signal durable memory promotion candidates at closeout triggers only. Provide sessionId or checkpointId for current-session review; without them the tool returns a missing_closeout_source warning unless allowScopeFallback=true is intentionally used with trigger=manual_closeout. Never promote automatically.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        checkpointId: z.string().optional(),
        trigger: z.enum([
          'agent_merged_pr',
          'user_merged_then_synced',
          'user_declared_work_done',
          'manual_closeout',
        ]),
        limit: z.number().int().positive().optional(),
        scanLimit: z.number().int().positive().optional(),
        promotionRecommendation: z.string().optional(),
        includeWarnings: z.boolean().optional(),
        allowScopeFallback: z.boolean().optional(),
        createUpdateCandidates: z.boolean().optional(),
      },
      annotations: {
        title: 'Suggest Memory Promotions',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.suggestMemoryPromotions(args)),
  );

  registerTool(
    'auto_promote_memory_candidates',
    {
      title: 'Auto Promote Memory Candidates',
      description:
        'Dry-run or, when CONTEXTFORGE_AUTO_PROMOTE_ENABLED=true and dryRun=false, automatically promote only strict closeout-scoped safe memory candidates. Requires sessionId or checkpointId; returns missing_closeout_source without one and never scans the scope backlog.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        checkpointId: z.string().optional(),
        trigger: z.enum([
          'agent_merged_pr',
          'user_merged_then_synced',
          'user_declared_work_done',
          'manual_closeout',
        ]),
        dryRun: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        scanLimit: z.number().int().positive().optional(),
        minConfidence: z.number().optional(),
        minStability: z.number().optional(),
        allowedCategories: z.array(z.string()).optional(),
      },
      annotations: {
        title: 'Auto Promote Memory Candidates',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.autoPromoteMemoryCandidates(args)),
  );

  registerTool(
    'audit_memory_candidates',
    {
      title: 'Audit Memory Candidates',
      description:
        'Return stored audited recommendations and run the configured audit provider once per selected unaudited closeout-scoped pending memory candidate when needed. Requires sessionId or checkpointId, never scans scope fallback, and never promotes or changes candidate status. Persists candidate review metadata and audit usage events.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        checkpointId: z.string().optional(),
        trigger: z.enum([
          'agent_merged_pr',
          'user_merged_then_synced',
          'user_declared_work_done',
          'manual_closeout',
        ]),
        limit: z.number().int().positive().optional(),
        scanLimit: z.number().int().positive().optional(),
        minConfidence: z.number().optional(),
        minStability: z.number().optional(),
        allowedCategories: z.array(z.string()).optional(),
        promotionRecommendation: z.string().optional(),
      },
      annotations: {
        title: 'Audit Memory Candidates',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => jsonResult(await app.auditMemoryCandidates(args)),
  );

  registerTool(
    'reconcile_memory',
    {
      title: 'Reconcile Memory',
      description:
        'Search relevant durable memories, checkpoints, and memory candidates for a user correction; explain the basis for existing knowledge, assess conflicts, and optionally apply safe memory corrections only when explicitly requested. Default mode=propose is read-only unless createUpdateCandidates=true persists review proposals; mode=apply_safe may correct durable memory or reject candidates when the correction is unambiguous.',
      inputSchema: {
        ...scopedSchema,
        query: z.string().optional(),
        correction: z.string(),
        mode: z.enum(['propose', 'apply_safe']).optional(),
        sessionId: z.string().optional(),
        createUpdateCandidates: z.boolean().optional(),
        includeShared: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        candidateLimit: z.number().int().positive().optional(),
        sharedScopeKey: z.string().optional(),
      },
      annotations: {
        title: 'Reconcile Memory',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.reconcileMemory(args)),
  );

  registerTool(
    'promote_memory',
    {
      title: 'Promote Memory',
      description:
        'Promote a checkpoint candidate or reviewed fact into intentional durable memory with provenance metadata. Prefer promote_memory_candidate when promoting an existing candidate; use sourceSessionId/sourceCheckpointId/sourceCandidateIndex when writing a corrected durable fact from reviewed checkpoint evidence.',
      inputSchema: {
        ...scopedSchema,
        key: z.string(),
        content: z.string(),
        category: z.string().optional(),
        tags: optionalTags,
        importance: z.number().int().optional(),
        sourceCheckpointId: z.string().optional(),
        sourceSessionId: z.string().optional(),
        sourceRawEventIds: z.array(z.string()).optional(),
        sourceCandidateIndex: z.number().int().optional(),
        reason: z.string().optional(),
      },
      annotations: {
        title: 'Promote Memory',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.promoteMemory(args)),
  );

  registerTool(
    'promote_memory_candidate',
    {
      title: 'Promote Memory Candidate',
      description:
        'Promote a reviewed checkpoint memory candidate into intentional durable memory without copying candidate fields manually. Prefer candidateId from suggest_memory_promotions/list_memory_candidates; checkpointId plus sourceCandidateIndex is the legacy fallback. Review warnings before using allowWarnings.',
      inputSchema: {
        ...scopedSchema,
        candidateId: z.string().optional(),
        checkpointId: z.string().optional(),
        sourceCandidateIndex: z.number().int().optional(),
        sessionId: z.string().optional(),
        key: z.string().optional(),
        content: z.string().optional(),
        category: z.string().optional(),
        tags: optionalTags,
        importance: z.number().int().optional(),
        sourceRawEventIds: z.array(z.string()).optional(),
        allowWarnings: z.boolean().optional(),
        allowStatusOverride: z.boolean().optional(),
        reason: z.string().optional(),
      },
      annotations: {
        title: 'Promote Memory Candidate',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.promoteMemoryCandidate(args)),
  );

  registerTool(
    'reject_memory_candidate',
    {
      title: 'Reject Memory Candidate',
      description: 'Reject a reviewed checkpoint memory candidate without promoting it into durable memory.',
      inputSchema: {
        ...scopedSchema,
        candidateId: z.string(),
        reason: z.string(),
      },
      annotations: {
        title: 'Reject Memory Candidate',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.rejectMemoryCandidate(args)),
  );

  registerTool(
    'correct_memory',
    {
      title: 'Correct Memory',
      description: 'Correct an existing durable memory while preserving prior content in provenance metadata.',
      inputSchema: {
        ...scopedSchema,
        key: z.string(),
        content: z.string(),
        category: z.string().optional(),
        tags: optionalTags,
        importance: z.number().int().optional(),
        reason: z.string().optional(),
      },
      annotations: {
        title: 'Correct Memory',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.correctMemory(args)),
  );

  registerTool(
    'deactivate_memory',
    {
      title: 'Deactivate Memory',
      description: 'Mark a durable memory inactive without deleting its provenance.',
      inputSchema: {
        ...scopedSchema,
        key: z.string(),
        reason: z.string().optional(),
      },
      annotations: {
        title: 'Deactivate Memory',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.deactivateMemory(args)),
  );

  const duplicateDefinitions = toolDefinitions.filter((name, index) => toolDefinitions.indexOf(name) !== index);
  const missingDefinitions = ALL_MCP_TOOL_NAMES.filter((name) => !toolDefinitions.includes(name));
  const unknownDefinitions = toolDefinitions.filter((name) => !ALL_MCP_TOOL_NAMES.includes(name));
  if (duplicateDefinitions.length > 0 || missingDefinitions.length > 0 || unknownDefinitions.length > 0) {
    throw new Error(
      `ContextForge MCP tool registry mismatch. Duplicate: ${duplicateDefinitions.join(', ') || 'none'}; missing: ${missingDefinitions.join(', ') || 'none'}; unknown: ${unknownDefinitions.join(', ') || 'none'}.`,
    );
  }
  const registeredToolNames = toolRegistrations.map(({ name }) => name);
  const missingTools = selection.enabledToolNames.filter((name) => !registeredToolNames.includes(name));
  if (missingTools.length > 0) {
    throw new Error(`ContextForge MCP profile references unregistered tool(s): ${missingTools.join(', ')}.`);
  }
  server.contextForgeSurface = mcpSurfaceInfo(toolRegistrations, selection);
  return server;
}

export async function startContextForgeMcpServer({ app, env = process.env, profile = null, tools = null } = {}) {
  const server = createContextForgeMcpServer({ app, env, profile, tools });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function mcpCliOptions(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--describe-surface') {
      options.describeSurface = true;
      continue;
    }
    if (token === '--profile' || token === '--tools') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value.`);
      options[token.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown MCP option: ${token}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  Promise.resolve().then(async () => {
    const options = mcpCliOptions(process.argv);
    if (options.describeSurface) {
      const server = createContextForgeMcpServer({ profile: options.profile, tools: options.tools });
      console.log(JSON.stringify(getContextForgeMcpSurfaceInfo(server), null, 2));
      await server.close().catch(() => {});
      return;
    }
    await startContextForgeMcpServer({ profile: options.profile, tools: options.tools });
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
