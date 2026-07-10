#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
const workspaceRuleJsonSchema = z.record(z.string(), z.array(z.string()));

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
  'At the start of non-trivial project work or after resume/compaction/agent transfer, call bootstrap_context with repoPath, cwd, or an explicit scopeKey and consultReason=startup/resume/compaction_recovery/agent_switch. It summarizes storage authority, vector readiness, query retrieval results, trust hints, and query-independent latest checkpoint handoff in one response.',
  'Do not call bootstrap_context merely to re-confirm current active-session intent. During uninterrupted work, prefer current conversation context; use search for targeted file/API/error/domain lookups and db_info/git/GitHub/health checks/service manager for mutable live state.',
  'bootstrap_context does not create a session. In Codex or Claude Code auto-ingest environments, preserve or recover the adapter session id such as codex:<native-session-id> or claude_code:<native-session-id> before session_status, distill_checkpoint, or closeout promotion. Use begin_session only for manual ContextForge evidence streams where the agent will call append_raw itself; do not create a fresh cf_... session at closeout to review candidates from an existing Codex/Claude session.',
  'Use db_info connection metadata for access path: prefer connection.summary, then connection.accessMode/accessPath and connection.serverRole. connection.mode is kept for compatibility. Top-level storageMode describes the responding ContextForge process; connection.server may describe the server-owned store behind a remote call.',
  'Read bootstrap_context.handoff.latestCheckpoints before durable memory only when the consult reason is startup, resume, compaction recovery, or agent switch. Durable memory is for reviewed stable facts, contracts, policies, and runbooks. Verify mutable checkpoint claims with git/GitHub/CI/runtime/migrations before final action.',
  'Search result types have different trust roles: memory is reviewed durable fact or decision; checkpoint is credible recent handoff state for continuity, planning, prior intent, recent decisions, and unfinished work, but mutable live-state claims must be verified with git/GitHub/CI/runtime/migrations before acting; memory_candidate is unreviewed promotion material and not durable truth.',
  'bootstrap_context returns a compact memoryMap separately from raw retrieval hits. Use the map for durable-memory orientation, then call expand_memory_cluster only for clusters whose atomic details are needed.',
  'For task start or loose continuation prompts such as "지난 환경 작업과 동기화", "어제 하던 거 이어서", "previous work", or "continue", call bootstrap_context first; it includes latest checkpoint handoff independent of search ranking. Use sync_resume_context only when you know the exact sessionId and need session working state or raw tail.',
  'For closeout distillation, pass auditTrigger to distill_checkpoint. Candidate audit automatically selects a bounded session batch after closeout triggers or once the configured threshold is reached, then invokes the provider once per selected candidate. Audit results are stored on candidates; automatic promotion only controls whether approved strict-safe results are written to durable memory.',
  'When an agent needs to inspect audited recommendations, call audit_memory_candidates with sessionId or checkpointId. It returns stored audit proposals and audits unaudited candidates in the same scoped selection batch when needed. It persists candidate audit metadata and usage events but never promotes or mutates durable memory.',
  'For strict closeout-scoped safe automatic promotion, call auto_promote_memory_candidates only when the user wants write-side automatic promotion and always include sessionId or checkpointId. By default use dryRun=true. Use dryRun=false only when CONTEXTFORGE_AUTO_PROMOTE_ENABLED=true is intentionally configured; never use scope-wide backlog fallback and never auto-promote preference candidates.',
  'Preference-like candidates are tracked as merged occurrences; use list_preference_occurrences to review repeated evidence and weakened corrections, but do not treat occurrence evidence alone as durable preference truth.',
  'For user corrections such as "너 잘못 알고 있잖아", "그거 아니야", "그건 X가 아니라 Y야", or "기억 수정해", call reconcile_memory. Show the basis for prior knowledge, assess conflicts, and only apply safe corrections when the user explicitly asks to fix memory.',
  'Use list_memory_update_candidates to review proposed durable-memory corrections, deactivations, duplicate merges, or corrective notes. reconcile_memory propose mode is read-only by default; pass createUpdateCandidates=true only when persistent review proposals are wanted. Apply or reject update candidates only after explicit user approval.',
  'When resuming a known session, pass sessionId to bootstrap_context or call get_working_summary and get_session_working_context to load latest rolling handoff state separately from durable memory and checkpoint search results.',
  'Embeddings are the supported retrieval-quality path. Successful distill_checkpoint calls may queue embedding jobs for the new checkpoint and memory candidates. Before calling process_embedding_jobs, inspect db_info embedding coverage/jobs or list_embedding_jobs. Only call process_embedding_jobs when pending or failed jobs exist, processing jobs are stale, or db_info reports stale vector sources. When failed jobs exist, call process_embedding_jobs with retryFailed=true. If pending=0, failed=0, processing=0, and staleSources=0, skip processing instead of treating lexical fallback as equivalent.',
  'If working on a repository while the MCP process cwd is elsewhere, pass repoPath or cwd so repo scope resolves to that checkout; repoPath takes precedence when both are provided.',
  'Treat scopeKey as the canonical repo memory key; pass an explicit normalized GitHub key when local paths differ across machines or the checkout cannot infer the right remote.',
  'Use remember for reviewed durable facts the user or assistant intentionally wants saved.',
  'At closeout after distill_checkpoint, keep the returned checkpointId and check memoryCandidateCount; if it is greater than zero, prefer suggest_memory_promotions with that checkpointId or the current sessionId, then promote only reviewed durable facts with promote_memory_candidate or reject unsuitable candidates with reject_memory_candidate.',
  'When session_status reports latestCheckpointMemoryCandidateCount at closeout, use suggest_memory_promotions or list_memory_candidates with the latest checkpoint id or same sessionId before deciding what should become durable memory.',
  'Keep local scope opt-in.',
].join(' ');

export function createContextForgeMcpServer({ app = createContextForge() } = {}) {
  const server = new McpServer(
    {
      name: 'contextforge',
      version: CONTEXTFORGE_VERSION,
    },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'search',
    {
      title: 'Search Memory',
      description:
        'Search scoped ContextForge retrieval results. Results may include type=memory reviewed durable facts, type=checkpoint credible recent handoff state, and type=memory_candidate unreviewed promotion candidates. Pass repoPath or cwd to retrieve repo results for a checkout outside the MCP process cwd; repoPath takes precedence. Pass scopeKey to pin the canonical repo memory key. Pass workspaceKey to add bounded workspace federation over existing scopes; workspace profiles do not change storage mode.',
      inputSchema: {
        ...scopedSchema,
        query: z.string(),
        limit: z.number().int().positive().optional(),
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'list_embedding_jobs',
    {
      title: 'List Embedding Jobs',
      description:
        'List queued embedding job state. Jobs record source type/id, attempts, last error, status, and completion time.',
      inputSchema: {
        ...scopedSchema,
        status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'List Embedding Jobs',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listEmbeddingJobs(args)),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'list_checkpoints',
    {
      title: 'List Checkpoints',
      description:
        'List scoped checkpoints, optionally filtered by sessionId and checkpoint level. Level 0 is the default session distill level.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        level: z.number().int().nonnegative().optional(),
      },
      annotations: {
        title: 'List Checkpoints',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listCheckpoints(args)),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'list_llm_usage_events',
    {
      title: 'List LLM Usage Events',
      description:
        'List persisted normalized LLM usage events for a scope, optionally filtered by session, distill run, checkpoint, candidate, operation, or provider.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string().optional(),
        distillRunId: z.string().optional(),
        checkpointId: z.string().optional(),
        candidateId: z.string().optional(),
        operation: z.string().optional(),
        provider: z.string().optional(),
        limit: z.number().int().positive().optional(),
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

  server.registerTool(
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

  server.registerTool(
    'list_memory_events',
    {
      title: 'List Memory Events',
      description: 'List provenance events for one durable memory key.',
      inputSchema: {
        ...scopedSchema,
        key: z.string(),
      },
      annotations: {
        title: 'List Memory Events',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listMemoryEvents(args)),
  );

  server.registerTool(
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
        limit: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'List Memory Candidates',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listMemoryCandidates(args)),
  );

  server.registerTool(
    'list_preference_occurrences',
    {
      title: 'List Preference Occurrences',
      description:
        'List merged preference occurrence evidence tracked from preference-like memory candidates. Use for review; do not auto-promote preferences solely from this output.',
      inputSchema: {
        ...scopedSchema,
        status: z.enum(['active', 'weakened', 'superseded', 'rejected']).optional(),
        limit: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'List Preference Occurrences',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listPreferenceOccurrences(args)),
  );

  server.registerTool(
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
        limit: z.number().int().positive().optional(),
      },
      annotations: {
        title: 'List Memory Update Candidates',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.listMemoryUpdateCandidates(args)),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  return server;
}

export async function startContextForgeMcpServer({ app } = {}) {
  const server = createContextForgeMcpServer({ app });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  startContextForgeMcpServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
