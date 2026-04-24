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
};

function jsonResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: { result },
  };
}

export function createContextForgeMcpServer({ app = createContextForge() } = {}) {
  const server = new McpServer(
    {
      name: 'contextforge',
      version: '0.0.0',
    },
    {
      instructions:
        'Use ContextForge for scoped memory retrieval on demand. Prefer search before loading exact memories, keep local scope opt-in, and promote checkpoint candidates only when durable memory is intentional.',
    },
  );

  server.registerTool(
    'begin_session',
    {
      title: 'Begin Session',
      description: 'Create a ContextForge session id for a scoped agent run.',
      inputSchema: z.object({
        ...scopedSchema,
        sessionId: z.string().optional(),
        conversationId: z.string().optional(),
      }),
      annotations: {
        title: 'Begin Session',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.beginSession(args)),
  );

  server.registerTool(
    'search',
    {
      title: 'Search Memory',
      description: 'Search durable ContextForge memories in the requested scope.',
      inputSchema: z.object({
        ...scopedSchema,
        query: z.string(),
        limit: z.number().int().positive().optional(),
        searchScopes: z.enum(['scope', 'repo', 'shared', 'repo+shared', 'local']).optional(),
        sharedScopeKey: z.string().optional(),
      }),
      annotations: {
        title: 'Search Memory',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.search(args)),
  );

  server.registerTool(
    'get_memory',
    {
      title: 'Get Memory',
      description: 'Fetch one durable memory by key from a specific scope.',
      inputSchema: z.object({
        ...scopedSchema,
        key: z.string(),
      }),
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
      description: 'Create or update a durable memory in an explicit scope.',
      inputSchema: z.object({
        ...scopedSchema,
        key: z.string(),
        content: z.string(),
        category: z.string().optional(),
        tags: optionalTags,
        importance: z.number().int().optional(),
      }),
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
      inputSchema: z.object({
        ...scopedSchema,
        sessionId: z.string(),
        conversationId: z.string().optional(),
        role: z.string(),
        content: z.string(),
        metadata: metadataSchema.optional(),
      }),
      annotations: {
        title: 'Append Raw Evidence',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.appendRaw(args)),
  );

  server.registerTool(
    'distill_checkpoint',
    {
      title: 'Distill Checkpoint',
      description: 'Distill raw session evidence into a checkpoint with the configured provider.',
      inputSchema: z.object({
        ...scopedSchema,
        sessionId: z.string(),
        conversationId: z.string().optional(),
        provider: z.string().optional(),
      }),
      annotations: {
        title: 'Distill Checkpoint',
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async (args) => jsonResult(await app.distillCheckpoint(args)),
  );

  server.registerTool(
    'promote_memory',
    {
      title: 'Promote Memory',
      description: 'Promote a checkpoint candidate or reviewed fact into durable memory with provenance metadata.',
      inputSchema: z.object({
        ...scopedSchema,
        key: z.string(),
        content: z.string(),
        category: z.string().optional(),
        tags: optionalTags,
        importance: z.number().int().optional(),
        sourceCheckpointId: z.string().optional(),
        sourceSessionId: z.string().optional(),
        sourceRawEventIds: z.array(z.string()).optional(),
        reason: z.string().optional(),
      }),
      annotations: {
        title: 'Promote Memory',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async (args) => jsonResult(await app.promoteMemory(args)),
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
