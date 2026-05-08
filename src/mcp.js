#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createContextForge } from './core.js';

const scopeSchema = z.enum(['shared', 'repo', 'local']);
const metadataSchema = z.record(z.string(), z.unknown());
const optionalTags = z.array(z.string()).optional();

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
  'At the start of non-trivial project work, call bootstrap_context with repoPath, cwd, or an explicit scopeKey. It summarizes storage authority, vector readiness, repo semantic retrieval results, and trust hints in one response.',
  'bootstrap_context does not create a session. In Codex or Claude Code auto-ingest environments, preserve or recover the adapter session id such as codex:<native-session-id> or claude_code:<native-session-id> before session_status, distill_checkpoint, or closeout promotion. Use begin_session only for manual ContextForge evidence streams where the agent will call append_raw itself; do not create a fresh cf_... session at closeout to review candidates from an existing Codex/Claude session.',
  'Use db_info connection metadata to see whether the tool is a direct local process, an HTTP server, or a remote-client wrapper. Do not treat a remote server reporting its own local SQLite store as proof that the consuming repo is local-only.',
  'Search result types have different trust roles: memory is reviewed durable fact or decision; checkpoint is credible recent handoff state for continuity, planning, prior intent, recent decisions, and unfinished work, but mutable live-state claims must be verified with git/GitHub/CI/runtime/migrations before acting; memory_candidate is unreviewed promotion material and not durable truth.',
  'For start/resume requests such as "지난 환경 작업과 동기화", "어제 하던 거 이어서", "previous work", or "continue", call sync_resume_context. Use checkpoints actively as handoff notes, then verify mutable state with git/GitHub/CI/runtime/migrations. Do not propose memory promotions during resume sync.',
  'For closeout triggers only, call suggest_memory_promotions with the current sessionId or the checkpointId returned by distill_checkpoint: after this agent merges a PR, after the user says they merged and the agent syncs main/cleans branches, or when the user explicitly says today\'s work is done. Suggest at most 1-3 durable memory promotions and never promote automatically.',
  'For strict closeout-scoped safe automatic promotion, call auto_promote_memory_candidates only when the user wants automatic promotion and always include sessionId or checkpointId. By default use dryRun=true. Use dryRun=false only when CONTEXTFORGE_AUTO_PROMOTE_ENABLED=true is intentionally configured; never use scope-wide backlog fallback and never auto-promote preference candidates.',
  'Preference-like candidates are tracked as merged occurrences; use list_preference_occurrences to review repeated evidence and weakened corrections, but do not treat occurrence evidence alone as durable preference truth.',
  'For user corrections such as "너 잘못 알고 있잖아", "그거 아니야", "그건 X가 아니라 Y야", or "기억 수정해", call reconcile_memory. Show the basis for prior knowledge, assess conflicts, and only apply safe corrections when the user explicitly asks to fix memory.',
  'Use list_memory_update_candidates to review proposed durable-memory corrections, deactivations, duplicate merges, or corrective notes. reconcile_memory propose mode is read-only by default; pass createUpdateCandidates=true only when persistent review proposals are wanted. Apply or reject update candidates only after explicit user approval.',
  'When resuming a known session, pass sessionId to bootstrap_context or call get_working_summary and get_session_working_context to load latest rolling handoff state separately from durable memory and checkpoint search results.',
  'Embeddings are the supported retrieval-quality path. Successful distill_checkpoint calls queue embedding jobs for the new checkpoint and memory candidates; process queued jobs with process_embedding_jobs. If db_info or bootstrap_context reports stale vector sources or failed embedding jobs, call list_embedding_jobs and process_embedding_jobs instead of treating lexical fallback as equivalent.',
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
      version: '0.0.0',
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
        'Inspect ContextForge connection metadata, storage backend, table counts, raw retention, and sqlite-vec/embeddings readiness. Remote servers may report their own local SQLite store; use the connection metadata and repo AGENTS guidance to distinguish external remote-client usage from local-only storage.',
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
    'bootstrap_context',
    {
      title: 'Bootstrap Context',
      description:
        'Resolve scoped ContextForge memory for a task in one call. Searches repo scope semantically across memory, checkpoint, and memory_candidate results, optionally includes up to 3 shared-scope results, and annotates trust and verification hints for agents. Does not create a session; pass a known Codex/Claude/ContextForge sessionId only to load session working state and raw tail.',
      inputSchema: {
        ...scopedSchema,
        query: z.string(),
        sessionId: z.string().optional(),
        rawTailLimit: z.number().int().positive().optional(),
        includeShared: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
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
    'sync_resume_context',
    {
      title: 'Sync Resume Context',
      description:
        'Build a start/resume handoff package for continuing work across machines or agent environments. Use checkpoints as credible recent handoff notes, durable memories as canonical long-term context, and memory candidates only as review material. This tool must not propose or perform durable memory promotion.',
      inputSchema: {
        ...scopedSchema,
        query: z.string(),
        sessionId: z.string().optional(),
        includeShared: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        rawTailLimit: z.number().int().positive().optional(),
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
    'search',
    {
      title: 'Search Memory',
      description:
        'Search scoped ContextForge retrieval results. Results may include type=memory reviewed durable facts, type=checkpoint credible recent handoff state, and type=memory_candidate unreviewed promotion candidates. Pass repoPath or cwd to retrieve repo results for a checkout outside the MCP process cwd; repoPath takes precedence. Pass scopeKey to pin the canonical repo memory key.',
      inputSchema: {
        ...scopedSchema,
        query: z.string(),
        limit: z.number().int().positive().optional(),
        searchScopes: z.enum(['scope', 'repo', 'shared', 'repo+shared', 'local']).optional(),
        sharedScopeKey: z.string().optional(),
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
        'Delete raw evidence older than the configured raw TTL. Checkpoints, distill runs, and durable memories are preserved.',
      inputSchema: {
        ttlDays: z.number().int().positive().optional(),
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
        'Distill raw session evidence into a checkpoint with the configured provider. Keep the returned checkpointId and memoryCandidateCount for closeout review with suggest_memory_promotions, list_memory_candidates, or auto_promote_memory_candidates. level defaults to 0 for session distills; higher levels are reserved for later daily/weekly consolidation.',
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
      },
      annotations: {
        title: 'Suggest Memory Promotions',
        readOnlyHint: true,
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
