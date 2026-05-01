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
  'At the start of non-trivial project work, run a small bootstrap: call db_info when storage mode or vector readiness matters, search repo scope for the task, and search shared scope only when cross-repo or user-wide policy may matter.',
  'If db_info shows remote storage, treat results as shared canonical ContextForge state for the configured scope. If it shows local or project-local storage, treat results as machine-local context unless the user confirms that store is authoritative.',
  'Search result types have different trust levels: memory is reviewed durable fact or decision; checkpoint is recent session continuity, not canonical truth; memory_candidate is an unreviewed promotion candidate for review.',
  'If working on a repository while the MCP process cwd is elsewhere, pass repoPath or cwd so repo scope resolves to that checkout; repoPath takes precedence when both are provided.',
  'Treat scopeKey as the canonical repo memory key; pass an explicit normalized GitHub key when local paths differ across machines or the checkout cannot infer the right remote.',
  'Use remember for reviewed durable facts the user or assistant intentionally wants saved.',
  'After distill_checkpoint, check memoryCandidateCount; if it is greater than zero, call list_memory_candidates and promote only reviewed durable facts with promote_memory_candidate or reject unsuitable candidates with reject_memory_candidate.',
  'When session_status reports latestCheckpointMemoryCandidateCount, use list_memory_candidates before deciding what should become durable memory.',
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
        'Inspect the configured ContextForge storage backend, table counts, raw retention, and sqlite-vec/embeddings readiness. Use this to distinguish remote canonical storage from local or project-local storage before relying on retrieval results.',
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
      description: 'Inspect raw evidence and checkpoint thresholds for a session before deciding whether to distill.',
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
        'Search scoped ContextForge retrieval results. Results may include type=memory reviewed durable facts, type=checkpoint recent continuity, and type=memory_candidate unreviewed promotion candidates. Pass repoPath or cwd to retrieve repo results for a checkout outside the MCP process cwd; repoPath takes precedence. Pass scopeKey to pin the canonical repo memory key.',
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
        role: z.string(),
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
    'distill_checkpoint',
    {
      title: 'Distill Checkpoint',
      description: 'Distill raw session evidence into a checkpoint with the configured provider.',
      inputSchema: {
        ...scopedSchema,
        sessionId: z.string(),
        conversationId: z.string().optional(),
        provider: z.string().optional(),
        maxEvents: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
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
      description: 'List memory candidates saved on distilled checkpoints without promoting them.',
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
    'promote_memory',
    {
      title: 'Promote Memory',
      description:
        'Promote a checkpoint candidate or reviewed fact into intentional durable memory with provenance metadata.',
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
        'Promote a reviewed checkpoint memory candidate into intentional durable memory without copying candidate fields manually.',
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
