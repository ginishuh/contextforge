import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeGitRepo } from './helpers/fixtures.js';
import { makeTempDir } from './helpers/temp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createContextForge } from '../src/core.js';
import {
  ALL_MCP_TOOL_NAMES,
  createContextForgeMcpServer,
  getContextForgeMcpSurfaceInfo,
  MCP_TOOL_PROFILES,
  resolveMcpToolSelection,
} from '../src/mcp.js';
import { startContextForgeServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const packageManifest = createRequire(import.meta.url)('../package.json');

test('MCP instructions keep embedding maintenance safety guidance compact', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'mcp.js'), 'utf8');

  assert.match(source, /Embedding maintenance is operator-profile work/);
  assert.match(source, /inspect db_info coverage/);
  assert.match(source, /packaged contextforge-memory skill/);
});

test('MCP tool profiles have exact bounded surfaces and reject invalid configuration', () => {
  const expectedAgentCore = [
    'db_info',
    'resolve_workspace',
    'bootstrap_context',
    'expand_memory_cluster',
    'sync_resume_context',
    'begin_session',
    'session_status',
    'submit_distill_job',
    'get_job',
    'search',
    'get_memory',
    'remember',
    'append_raw',
    'get_working_summary',
    'list_checkpoints',
    'get_session_working_context',
    'upsert_session_working_context',
    'distill_checkpoint',
    'distill_usage',
    'list_memory_candidates',
    'suggest_memory_promotions',
    'reconcile_memory',
    'promote_memory_candidate',
    'reject_memory_candidate',
  ];
  assert.deepEqual(MCP_TOOL_PROFILES['agent-core'], expectedAgentCore);
  assert.deepEqual(
    Object.fromEntries(Object.entries(MCP_TOOL_PROFILES).map(([name, tools]) => [name, tools.length])),
    { 'agent-core': 24, review: 45, operator: 67, 'workspace-admin': 11, all: 73 },
  );
  assert.deepEqual(MCP_TOOL_PROFILES.all, ALL_MCP_TOOL_NAMES);

  const defaultSelection = resolveMcpToolSelection({ env: {} });
  assert.equal(defaultSelection.profile, 'agent-core');
  assert.deepEqual(defaultSelection.enabledToolNames, expectedAgentCore);
  assert.ok(defaultSelection.disabledToolNames.includes('process_jobs'));
  assert.ok(defaultSelection.disabledToolNames.includes('upsert_workspace_profile'));

  const customSelection = resolveMcpToolSelection({
    env: { CONTEXTFORGE_MCP_PROFILE: 'operator', CONTEXTFORGE_MCP_TOOLS: 'db_info, search,db_info' },
  });
  assert.equal(customSelection.profile, 'custom');
  assert.equal(customSelection.requestedProfile, 'operator');
  assert.equal(customSelection.explicitAllowlist, true);
  assert.deepEqual(customSelection.enabledToolNames, ['db_info', 'search']);
  assert.deepEqual(customSelection.warnings, []);
  const customWithUnknownProfile = resolveMcpToolSelection({
    env: { CONTEXTFORGE_MCP_PROFILE: 'typo', CONTEXTFORGE_MCP_TOOLS: 'db_info,search' },
  });
  assert.equal(customWithUnknownProfile.profile, 'custom');
  assert.match(customWithUnknownProfile.warnings[0], /Ignored unknown MCP profile typo/);
  assert.throws(
    () => resolveMcpToolSelection({ profile: 'mystery' }),
    /Unknown ContextForge MCP profile: mystery.*agent-core.*workspace-admin/,
  );
  assert.throws(
    () => resolveMcpToolSelection({ tools: 'db_info,launch_missiles' }),
    /Unknown ContextForge MCP tool\(s\): launch_missiles/,
  );
});

test('MCP default profile stays within the context budget without requiring an installed skill', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const defaultServer = createContextForgeMcpServer({
    app,
    env: { CONTEXTFORGE_MCP_PROFILE: 'agent-core', HOME: path.join(dataDir, 'missing-home') },
  });
  const allServer = createContextForgeMcpServer({ app, profile: 'all' });
  try {
    const surface = getContextForgeMcpSurfaceInfo(defaultServer);
    const allSurface = getContextForgeMcpSurfaceInfo(allServer);
    assert.equal(surface.toolCount, 24);
    assert.equal(allSurface.toolCount, 73);
    // Absolute caps moved to scripts/mcp-surface-budgets.json, which ratchets
    // every profile. What belongs here is the relation between them.
    assert.ok(surface.estimatedInitialTokens / allSurface.estimatedInitialTokens <= 0.5);
    assert.equal(
      surface.descriptionBytes,
      surface.tools.reduce((total, tool) => total + tool.descriptionBytes, 0),
    );
    assert.deepEqual(surface.tools.map((tool) => tool.name), MCP_TOOL_PROFILES['agent-core']);
    assert.ok(surface.disabledToolNames.includes('process_embedding_jobs'));
  } finally {
    await defaultServer.close().catch(() => {});
    await allServer.close().catch(() => {});
    app.close();
  }
});

test('MCP surface CLI reports selected profile and explicit allowlist', async () => {
  const profile = JSON.parse(
    (await execFileAsync('node', ['src/mcp.js', '--describe-surface', '--profile', 'workspace-admin'])).stdout,
  );
  assert.equal(profile.profile, 'workspace-admin');
  assert.deepEqual(profile.enabledToolNames, MCP_TOOL_PROFILES['workspace-admin']);

  const custom = JSON.parse(
    (await execFileAsync('node', ['src/mcp.js', '--describe-surface', '--tools', 'db_info,search'])).stdout,
  );
  assert.equal(custom.profile, 'custom');
  assert.deepEqual(custom.enabledToolNames, ['db_info', 'search']);
  await assert.rejects(
    execFileAsync('node', ['src/mcp.js', '--describe-surface', '--profile', 'unknown']),
    /Unknown ContextForge MCP profile: unknown/,
  );
});

test('MCP stdio server exposes core tools for synthetic integration', async () => {
  const dataDir = await makeTempDir();
  const repoPath = await makeGitRepo('git@github.com:example/mcp-repo.git');
  const client = new Client({ name: 'contextforge-test-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['src/mcp.js'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_MCP_PROFILE: 'all',
    },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: 'contextforge', version: packageManifest.version });
    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      'append_raw',
      'apply_memory_update_candidate',
      'audit_memory_candidates',
      'audit_memory_duplicates',
      'auto_promote_memory_candidates',
      'begin_session',
      'bootstrap_context',
      'cancel_job',
      'correct_memory',
      'db_info',
      'deactivate_memory',
      'deactivate_workspace_profile',
      'distill_checkpoint',
      'distill_usage',
      'embedding_inventory',
      'expand_memory_cluster',
      'get_job',
      'get_memory',
      'get_runtime_settings',
      'get_session_working_context',
      'get_working_summary',
      'get_workspace',
      'list_checkpoints', 'list_due_candidate_audits', 'list_due_candidate_stale_transitions', 'list_due_candidate_wakeups',
      'list_due_consolidations',
      'list_due_distill_sessions',
      'list_embedding_jobs',
      'list_jobs',
      'list_llm_usage_events',
      'list_memory_candidates',
      'list_memory_events',
      'list_memory_update_candidates',
      'list_preference_occurrences',
      'list_workspaces',
      'llm_usage_rollup',
      'migrate_scope', 'plan_memory_candidate_backlog_audit',
      'process_consolidations', 'process_due_candidate_audits', 'process_due_candidate_stale_transitions', 'process_due_candidate_wakeups',
      'process_due_distills',
      'process_embedding_jobs',
      'process_jobs',
      'promote_memory',
      'promote_memory_candidate',
      'prune_embedding_artifacts',
      'prune_raw_events',
      'rebuild_embeddings',
      'reconcile_memory',
      'reject_memory_candidate',
      'reject_memory_update_candidate',
      'remember',
      'remove_workspace_member', 'remove_workspace_routing_rule', 'reopen_stale_memory_candidate',
      'resolve_workspace', 'route_audited_memory_candidates',
      'search',
      'session_status',
      'skip_memory_update_candidate', 'snooze_memory_candidate',
      'submit_audit_job',
      'submit_distill_job',
      'suggest_memory_promotions',
      'sync_resume_context',
      'upsert_session_working_context',
      'upsert_workspace_member',
      'upsert_workspace_profile',
      'upsert_workspace_routing_rule', 'wake_memory_candidate',
    ]);
    const reportedSurface = JSON.parse(
      (
        await execFileAsync('node', ['src/mcp.js', '--describe-surface', '--profile', 'all'], {
          env: { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir },
        })
      ).stdout,
    );
    assert.equal(Buffer.byteLength(client.getInstructions() || '', 'utf8'), reportedSurface.instructionsBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(toolList), 'utf8'), reportedSurface.toolSchemaBytes);
    const rememberTool = toolList.tools.find((tool) => tool.name === 'remember');
    assert.ok(rememberTool.inputSchema.properties.repoPath);
    assert.ok(rememberTool.inputSchema.properties.cwd);
    const sessionStatusTool = toolList.tools.find((tool) => tool.name === 'session_status');
    assert.ok(sessionStatusTool.inputSchema.properties.maxEvents);
    assert.ok(sessionStatusTool.inputSchema.properties.maxChars);
    assert.ok(sessionStatusTool.description.includes('latestCheckpointMemoryCandidateCount'));
    const listDueDistillsTool = toolList.tools.find((tool) => tool.name === 'list_due_distill_sessions');
    assert.ok(listDueDistillsTool.inputSchema.properties.scanLimit);
    assert.ok(listDueDistillsTool.inputSchema.properties.idleMs);
    assert.ok(listDueDistillsTool.description.includes('idleMs'));
    const processDueDistillsTool = toolList.tools.find((tool) => tool.name === 'process_due_distills');
    assert.ok(processDueDistillsTool.inputSchema.properties.dryRun);
    assert.ok(processDueDistillsTool.inputSchema.properties.limit);
    assert.ok(processDueDistillsTool.description.includes('catch-up batch'));
    const submitDistillJobTool = toolList.tools.find((tool) => tool.name === 'submit_distill_job');
    assert.ok(submitDistillJobTool.inputSchema.properties.idempotencyKey);
    assert.ok(submitDistillJobTool.description.includes('return immediately'));
    const submitAuditJobTool = toolList.tools.find((tool) => tool.name === 'submit_audit_job'); assert.ok(submitAuditJobTool.description.includes('once per selected candidate')); assert.ok(submitAuditJobTool.description.includes('candidateIds backlog batch'));
    assert.deepEqual({ minItems: submitAuditJobTool.inputSchema.properties.candidateIds.minItems, maxItems: submitAuditJobTool.inputSchema.properties.candidateIds.maxItems }, { minItems: 1, maxItems: 10 });
    const backlogPlanTool = toolList.tools.find((tool) => tool.name === 'plan_memory_candidate_backlog_audit'); assert.ok(backlogPlanTool.inputSchema.properties.maxProviderCalls); assert.ok(backlogPlanTool.inputSchema.properties.inputUsdPerMillionTokens); assert.equal(backlogPlanTool.annotations.readOnlyHint, true);
    const processJobsTool = toolList.tools.find((tool) => tool.name === 'process_jobs');
    assert.ok(processJobsTool.inputSchema.properties.leaseMs);
    assert.equal(processJobsTool.annotations.readOnlyHint, false);
    const cancelJobTool = toolList.tools.find((tool) => tool.name === 'cancel_job');
    assert.ok(cancelJobTool.description.includes('not force-terminated'));
    const listDueConsolidationsTool = toolList.tools.find((tool) => tool.name === 'list_due_consolidations');
    assert.ok(listDueConsolidationsTool.inputSchema.properties.target);
    assert.ok(listDueConsolidationsTool.inputSchema.properties.windowKind);
    assert.deepEqual(listDueConsolidationsTool.inputSchema.properties.windowKind.enum, ['daily', 'custom']);
    assert.ok(listDueConsolidationsTool.description.includes('time window'));
    const processConsolidationsTool = toolList.tools.find((tool) => tool.name === 'process_consolidations');
    assert.ok(processConsolidationsTool.inputSchema.properties.dryRun);
    assert.ok(processConsolidationsTool.description.includes('handoff context'));
    const distillTool = toolList.tools.find((tool) => tool.name === 'distill_checkpoint');
    assert.ok(distillTool.inputSchema.properties.maxEvents);
    assert.ok(distillTool.inputSchema.properties.maxChars);
    assert.ok(distillTool.inputSchema.properties.level);
    assert.ok(distillTool.description.includes('memoryCandidateCount'));
    const listCheckpointsTool = toolList.tools.find((tool) => tool.name === 'list_checkpoints');
    assert.ok(listCheckpointsTool.inputSchema.properties.level);
    const distillUsageTool = toolList.tools.find((tool) => tool.name === 'distill_usage');
    assert.ok(distillUsageTool.inputSchema.properties.charsPerToken);
    const llmUsageRollupTool = toolList.tools.find((tool) => tool.name === 'llm_usage_rollup');
    assert.ok(llmUsageRollupTool.inputSchema.properties.operation);
    assert.ok(llmUsageRollupTool.inputSchema.properties.includeEvents);
    const listLlmUsageEventsTool = toolList.tools.find((tool) => tool.name === 'list_llm_usage_events');
    assert.ok(listLlmUsageEventsTool.inputSchema.properties.distillRunId);
    assert.ok(listLlmUsageEventsTool.inputSchema.properties.jobId);
    assert.ok(listLlmUsageEventsTool.inputSchema.properties.provider);
    const processEmbeddingJobsTool = toolList.tools.find((tool) => tool.name === 'process_embedding_jobs');
    assert.ok(processEmbeddingJobsTool.inputSchema.properties.retryFailed);
    const listEmbeddingJobsTool = toolList.tools.find((tool) => tool.name === 'list_embedding_jobs');
    assert.ok(listEmbeddingJobsTool.inputSchema.properties.status);
    const embeddingInventoryTool = toolList.tools.find((tool) => tool.name === 'embedding_inventory');
    assert.ok(embeddingInventoryTool.inputSchema.properties.completedJobRetentionDays);
    assert.equal(embeddingInventoryTool.annotations.readOnlyHint, true);
    const pruneEmbeddingArtifactsTool = toolList.tools.find((tool) => tool.name === 'prune_embedding_artifacts');
    assert.ok(pruneEmbeddingArtifactsTool.inputSchema.properties.batchSize);
    assert.ok(pruneEmbeddingArtifactsTool.inputSchema.properties.dryRun);
    assert.ok(pruneEmbeddingArtifactsTool.inputSchema.properties.cursor);
    assert.ok(pruneEmbeddingArtifactsTool.inputSchema.properties.includeRetired);
    assert.ok(pruneEmbeddingArtifactsTool.inputSchema.properties.confirmMassRetired);
    assert.ok(pruneEmbeddingArtifactsTool.inputSchema.properties.includeInventory);
    assert.equal(pruneEmbeddingArtifactsTool.annotations.readOnlyHint, false);
    assert.equal(pruneEmbeddingArtifactsTool.annotations.destructiveHint, true);
    for (const name of [
      'list_embedding_jobs',
      'list_checkpoints',
      'list_llm_usage_events',
      'list_memory_events',
      'list_memory_candidates',
      'list_preference_occurrences',
      'list_memory_update_candidates',
    ]) {
      const tool = toolList.tools.find((item) => item.name === name);
      assert.equal(tool.inputSchema.properties.limit.maximum, 500, name);
      assert.ok(tool.inputSchema.properties.cursor, name);
      assert.ok(tool.inputSchema.properties.page, name);
    }
    const bootstrapTool = toolList.tools.find((tool) => tool.name === 'bootstrap_context');
    assert.ok(bootstrapTool.inputSchema.properties.sessionId);
    assert.ok(bootstrapTool.inputSchema.properties.consultReason);
    assert.ok(bootstrapTool.inputSchema.properties.rawTailLimit);
    assert.ok(bootstrapTool.inputSchema.properties.latestCheckpointLimit);
    assert.ok(bootstrapTool.inputSchema.properties.relatedScopeKeys);
    assert.ok(bootstrapTool.inputSchema.properties.memoryMapLimit);
    assert.ok(bootstrapTool.inputSchema.properties.memoryMapClusterSize);
    assert.ok(bootstrapTool.description.includes('Does not create a session'));
    assert.ok(bootstrapTool.description.includes('latest checkpoint handoff'));
    assert.ok(bootstrapTool.description.includes('memoryMap'));
    const searchTool = toolList.tools.find((tool) => tool.name === 'search');
    assert.ok(searchTool.inputSchema.properties.workspaceKey);
    assert.ok(searchTool.inputSchema.properties.limit);
    assert.ok(searchTool.inputSchema.properties.candidateLimit);
    assert.ok(searchTool.inputSchema.properties.legacyFullScan);
    assert.ok(searchTool.inputSchema.properties.includeDiagnostics);
    assert.ok(searchTool.inputSchema.properties.workspaceMode);
    assert.ok(searchTool.inputSchema.properties.workspaceResultLimit);
    assert.ok(searchTool.inputSchema.properties.workspacePerScopeLimit);
    assert.ok(searchTool.inputSchema.properties.includePrimaryInWorkspaceResults);
    assert.ok(searchTool.description.includes('workspace federation'));
    const expandClusterTool = toolList.tools.find((tool) => tool.name === 'expand_memory_cluster');
    assert.ok(expandClusterTool.inputSchema.properties.clusterId);
    assert.ok(expandClusterTool.inputSchema.properties.includeProvenance);
    assert.ok(expandClusterTool.description.includes('provenance disabled by default'));
    const syncResumeTool = toolList.tools.find((tool) => tool.name === 'sync_resume_context');
    assert.ok(syncResumeTool.inputSchema.properties.sessionId);
    assert.ok(syncResumeTool.inputSchema.properties.consultReason);
    assert.ok(syncResumeTool.description.includes('Do not use this as routine active-session self-confirmation'));
    const sessionWorkingContextTool = toolList.tools.find((tool) => tool.name === 'upsert_session_working_context');
    assert.ok(sessionWorkingContextTool.inputSchema.properties.currentTask);
    assert.ok(sessionWorkingContextTool.inputSchema.properties.avoidMisreadings);
    const suggestTool = toolList.tools.find((tool) => tool.name === 'suggest_memory_promotions');
    assert.ok(suggestTool.inputSchema.properties.allowScopeFallback);
    assert.ok(suggestTool.inputSchema.properties.trigger);
    assert.ok(suggestTool.inputSchema.properties.createUpdateCandidates);
    assert.ok(suggestTool.description.includes('missing_closeout_source'));
    const preferenceOccurrencesTool = toolList.tools.find((tool) => tool.name === 'list_preference_occurrences');
    assert.ok(preferenceOccurrencesTool.inputSchema.properties.status);
    assert.ok(preferenceOccurrencesTool.inputSchema.properties.limit);
    const updateCandidatesTool = toolList.tools.find((tool) => tool.name === 'list_memory_update_candidates');
    assert.ok(updateCandidatesTool.inputSchema.properties.status);
    assert.ok(updateCandidatesTool.inputSchema.properties.action);
    const duplicateAuditTool = toolList.tools.find((tool) => tool.name === 'audit_memory_duplicates');
    assert.ok(duplicateAuditTool.inputSchema.properties.minOverlap);
    assert.ok(duplicateAuditTool.inputSchema.properties.scanLimit);
    assert.ok(duplicateAuditTool.inputSchema.properties.createUpdateCandidates);
    const listCandidateTool = toolList.tools.find((tool) => tool.name === 'list_memory_candidates');
    assert.ok(listCandidateTool.description.includes('current closeout source'));
    const applyUpdateTool = toolList.tools.find((tool) => tool.name === 'apply_memory_update_candidate');
    assert.ok(applyUpdateTool.inputSchema.properties.candidateId);
    assert.ok(applyUpdateTool.inputSchema.properties.mergeTargetKey);
    const rejectUpdateTool = toolList.tools.find((tool) => tool.name === 'reject_memory_update_candidate');
    assert.ok(rejectUpdateTool.inputSchema.properties.reason);
    const skipUpdateTool = toolList.tools.find((tool) => tool.name === 'skip_memory_update_candidate');
    assert.ok(skipUpdateTool.inputSchema.properties.candidateId);
    const autoPromoteTool = toolList.tools.find((tool) => tool.name === 'auto_promote_memory_candidates');
    assert.ok(autoPromoteTool.inputSchema.properties.dryRun);
    assert.ok(autoPromoteTool.inputSchema.properties.minConfidence);
    assert.ok(autoPromoteTool.inputSchema.properties.allowedCategories);
    assert.ok(autoPromoteTool.description.includes('missing_closeout_source'));
    const auditCandidatesTool = toolList.tools.find((tool) => tool.name === 'audit_memory_candidates');
    assert.ok(auditCandidatesTool.inputSchema.properties.minConfidence);
    assert.ok(auditCandidatesTool.inputSchema.properties.promotionRecommendation);
    assert.ok(auditCandidatesTool.description.includes('never promotes'));
    assert.ok(auditCandidatesTool.description.includes('Persists candidate review metadata'));
    assert.equal(auditCandidatesTool.annotations.readOnlyHint, false);
    assert.equal(auditCandidatesTool.annotations.destructiveHint, false);
    assert.equal(auditCandidatesTool.annotations.idempotentHint, false);
    assert.equal(auditCandidatesTool.annotations.openWorldHint, true);
    const promoteTool = toolList.tools.find((tool) => tool.name === 'promote_memory');
    assert.ok(promoteTool.description.includes('sourceCheckpointId'));
    const promoteCandidateTool = toolList.tools.find((tool) => tool.name === 'promote_memory_candidate');
    assert.ok(promoteCandidateTool.description.includes('candidateId'));
    const reconcileTool = toolList.tools.find((tool) => tool.name === 'reconcile_memory');
    assert.ok(reconcileTool.inputSchema.properties.correction);
    assert.ok(!reconcileTool.inputSchema.required?.includes('query'));
    assert.ok(reconcileTool.inputSchema.properties.mode);
    assert.ok(reconcileTool.inputSchema.properties.createUpdateCandidates);
    const appendRawTool = toolList.tools.find((tool) => tool.name === 'append_raw');
    assert.deepEqual(appendRawTool.inputSchema.properties.role.enum, ['user', 'assistant']);

    const rememberResult = await client.callTool({
      name: 'remember',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        key: 'mcp-rule',
        content: 'Use MCP retrieval on demand.',
        category: 'policy',
      },
    });
    assert.equal(rememberResult.structuredContent.result.key, 'mcp-rule');

    const searchResult = await client.callTool({
      name: 'search',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        query: 'retrieval demand',
      },
    });
    assert.equal(searchResult.structuredContent.result[0].memory.key, 'mcp-rule');

    const bootstrapResult = await client.callTool({
      name: 'bootstrap_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        query: 'retrieval demand previous work',
      },
    });
    assert.equal(bootstrapResult.structuredContent.result.scope.scopeKey, 'mcp-repo');
    assert.equal(bootstrapResult.structuredContent.result.results[0].trust, 'reviewed_durable');
    assert.equal(bootstrapResult.structuredContent.result.memoryMap.kind, 'memory_map');
    const mcpClusterId = bootstrapResult.structuredContent.result.memoryMap.clusters[0].clusterId;

    const expandedCluster = await client.callTool({
      name: 'expand_memory_cluster',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        clusterId: mcpClusterId,
      },
    });
    assert.equal(expandedCluster.structuredContent.result.kind, 'memory_cluster_expansion');
    assert.equal(expandedCluster.structuredContent.result.memories[0].key, 'mcp-rule');

    const repoPathResult = await client.callTool({
      name: 'remember',
      arguments: {
        scope: 'repo',
        repoPath,
        key: 'mcp-repo-path-rule',
        content: 'MCP repoPath resolves the target checkout.',
      },
    });
    assert.equal(repoPathResult.structuredContent.result.scopeKey, 'github.com/example/mcp-repo');

    const sessionResult = await client.callTool({
      name: 'begin_session',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
      },
    });
    assert.equal(sessionResult.structuredContent.result.sessionId, 'mcp-session');

    await client.callTool({
      name: 'append_raw',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        role: 'user',
        content: 'Decision: MCP agents should inspect session status before distilling.',
      },
    });
    const invalidAppendResult = await client.callTool({
      name: 'append_raw',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        role: 'tool_result',
        content: 'tool output stays in the native transcript.',
      },
    });
    assert.equal(invalidAppendResult.isError, true);
    assert.match(invalidAppendResult.content[0].text, /Invalid arguments|tool_result/);

    const zeroRawTailBootstrap = await client.callTool({
      name: 'bootstrap_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        query: 'session status before distilling',
        rawTailLimit: 0,
      },
    });
    assert.equal(zeroRawTailBootstrap.structuredContent.result.rawTailLimit, 0);
    assert.deepEqual(zeroRawTailBootstrap.structuredContent.result.rawTail, []);

    const statusResult = await client.callTool({
      name: 'session_status',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        sessionId: 'mcp-session',
        minEvents: 1,
        charThreshold: 1,
      },
    });
    assert.equal(statusResult.structuredContent.result.shouldDistill, true);

    const promotedResult = await client.callTool({
      name: 'promote_memory',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-repo',
        key: 'promoted-mcp-rule',
        content: 'Reviewed checkpoint candidates can become durable memory.',
        sourceCheckpointId: 'checkpoint-mcp',
        reason: 'Synthetic MCP test.',
      },
    });
    assert.equal(promotedResult.structuredContent.result.key, 'promoted-mcp-rule');

    const candidateTool = toolList.tools.find((tool) => tool.name === 'promote_memory_candidate');
    assert.ok(candidateTool.inputSchema.properties.candidateId);
    assert.ok(candidateTool.inputSchema.properties.checkpointId);
    assert.ok(candidateTool.inputSchema.properties.sourceCandidateIndex);
    assert.ok(toolList.tools.some((tool) => tool.name === 'reject_memory_candidate'));
  } finally {
    await client.close();
  }
});

test('MCP streamable HTTP endpoint exposes core tools with bearer auth', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_provider: async () => ({
        summaryShort: 'HTTP MCP candidate checkpoint.',
        summaryText: 'The checkpoint contains one reviewed memory candidate.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'http-mcp-candidate',
            content: 'HTTP MCP can promote memory candidates by checkpoint id.',
            reason: 'Synthetic HTTP MCP candidate.',
          },
        ],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });
  const remote = await startContextForgeServer({
    app,
    port: 0,
    env: {
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });
  const client = new Client({ name: 'contextforge-http-test-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: {
      headers: {
        authorization: 'Bearer test-token',
        'x-request-id': 'mcp-correlation-id',
      },
    },
  });

  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: 'contextforge', version: packageManifest.version });
    const toolList = await client.listTools();
    assert.deepEqual(
      toolList.tools.map((tool) => tool.name),
      MCP_TOOL_PROFILES['agent-core'],
    );
    const reportedSurface = JSON.parse(
      (
        await execFileAsync('node', ['src/mcp.js', '--describe-surface'], {
          env: { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir },
        })
      ).stdout,
    );
    assert.equal(Buffer.byteLength(client.getInstructions() || '', 'utf8'), reportedSurface.instructionsBytes);
    assert.equal(Buffer.byteLength(JSON.stringify(toolList), 'utf8'), reportedSurface.toolSchemaBytes);
    assert.ok(!toolList.tools.some((tool) => tool.name === 'process_jobs'));
    assert.ok(!toolList.tools.some((tool) => tool.name === 'upsert_workspace_profile'));

    const infoResult = await client.callTool({ name: 'db_info', arguments: {} });
    assert.equal(infoResult.structuredContent.result.connection.mode, 'remote-client');
    assert.equal(infoResult.structuredContent.result.connection.accessMode, 'remote-client');
    assert.equal(infoResult.structuredContent.result.connection.accessPath, 'http-mcp');
    assert.equal(infoResult.structuredContent.result.connection.transport, 'http-mcp');
    assert.equal(infoResult.structuredContent.result.connection.serverRole, 'local-process');
    assert.equal(infoResult.structuredContent.result.connection.summary, 'remote-client over http-mcp to local-process');
    assert.equal(infoResult.structuredContent.result.connection.server.mode, 'direct-local');

    const remembered = await client.callTool({
      name: 'remember',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        key: 'http-mcp-rule',
        content: 'HTTP MCP should share canonical remote memory.',
      },
    });
    assert.equal(remembered.structuredContent.result.scopeKey, 'http-mcp-repo');

    const searched = await client.callTool({
      name: 'search',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        query: 'canonical remote',
      },
    });
    assert.equal(searched.structuredContent.result[0].memory.key, 'http-mcp-rule');

    const bootstrap = await client.callTool({
      name: 'bootstrap_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        query: 'canonical remote',
      },
    });
    assert.equal(bootstrap.structuredContent.result.storage.connection.mode, 'remote-client');
    assert.equal(bootstrap.structuredContent.result.storage.connection.accessMode, 'remote-client');
    assert.equal(bootstrap.structuredContent.result.storage.connection.accessPath, 'http-mcp');
    assert.equal(bootstrap.structuredContent.result.storage.connection.transport, 'http-mcp');
    assert.equal(bootstrap.structuredContent.result.storage.connection.serverRole, 'local-process');
    assert.equal(bootstrap.structuredContent.result.storage.connection.server.mode, 'direct-local');

    const syncResume = await client.callTool({
      name: 'sync_resume_context',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        query: 'canonical remote previous work',
      },
    });
    assert.equal(syncResume.structuredContent.result.storage.connection.mode, 'remote-client');
    assert.equal(syncResume.structuredContent.result.storage.connection.accessMode, 'remote-client');
    assert.equal(syncResume.structuredContent.result.storage.connection.accessPath, 'http-mcp');
    assert.equal(syncResume.structuredContent.result.storage.connection.transport, 'http-mcp');
    assert.equal(syncResume.structuredContent.result.storage.connection.serverRole, 'local-process');
    assert.equal(syncResume.structuredContent.result.storage.connection.server.mode, 'direct-local');

    await client.callTool({
      name: 'append_raw',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        sessionId: 'http-mcp-session',
        role: 'assistant',
        content: 'Candidate: HTTP MCP can promote memory candidates by checkpoint id.',
      },
    });
    const submittedJob = await client.callTool({
      name: 'submit_distill_job',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        sessionId: 'http-mcp-session',
      },
    });
    assert.equal(submittedJob.structuredContent.result.job.metadata.requestId, 'mcp-correlation-id');
    const checkpoint = await client.callTool({
      name: 'distill_checkpoint',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        sessionId: 'http-mcp-session',
      },
    });
    const promoted = await client.callTool({
      name: 'promote_memory_candidate',
      arguments: {
        scope: 'repo',
        scopeKey: 'http-mcp-repo',
        checkpointId: checkpoint.structuredContent.result.id,
        sourceCandidateIndex: 0,
        reason: 'Reviewed over HTTP MCP.',
      },
    });
    assert.equal(promoted.structuredContent.result.key, 'http-mcp-candidate');
  } finally {
    await client.close();
    await remote.close();
    app.close();
  }
});

test('MCP streamable HTTP db_info reports remote-client for HTTP callers', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });
  const client = new Client({ name: 'contextforge-http-dbinfo-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: {
      headers: {
        authorization: 'Bearer test-token',
      },
    },
  });

  try {
    await client.connect(transport);
    const info = await client.callTool({ name: 'db_info', arguments: {} });
    assert.equal(info.structuredContent.result.connection.mode, 'remote-client');
    assert.equal(info.structuredContent.result.connection.accessMode, 'remote-client');
    assert.equal(info.structuredContent.result.connection.accessPath, 'http-mcp');
    assert.equal(info.structuredContent.result.connection.transport, 'http-mcp');
    assert.equal(info.structuredContent.result.connection.serverRole, 'http-server');
    assert.equal(info.structuredContent.result.connection.summary, 'remote-client over http-mcp to http-server');
    assert.equal(info.structuredContent.result.connection.server.mode, 'http-server');
    assert.equal(info.structuredContent.result.connection.server.accessMode, 'server-process');
    assert.equal(info.structuredContent.result.connection.server.accessPath, 'in-process');
    assert.equal(info.structuredContent.result.connection.server.serverRole, 'http-server');
    assert.equal(info.structuredContent.result.connection.server.summary, 'in-process http-server');
    assert.equal(info.structuredContent.result.connection.server.storageMode, 'project-local');
  } finally {
    await client.close();
    await remote.close();
  }
});

test('HTTP v0 callers see remote-client connection metadata', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const response = await fetch(`${remote.url}/v0/dbInfo`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.connection.mode, 'remote-client');
    assert.equal(body.result.connection.accessMode, 'remote-client');
    assert.equal(body.result.connection.accessPath, 'http-api');
    assert.equal(body.result.connection.transport, 'http-api');
    assert.equal(body.result.connection.serverRole, 'http-server');
    assert.equal(body.result.connection.summary, 'remote-client over http-api to http-server');
    assert.equal(body.result.connection.server.mode, 'http-server');
    assert.equal(body.result.connection.server.accessMode, 'server-process');
    assert.equal(body.result.connection.server.accessPath, 'in-process');
    assert.equal(body.result.connection.server.serverRole, 'http-server');
    assert.equal(body.result.connection.server.summary, 'in-process http-server');
    assert.equal(body.result.connection.server.storageMode, 'project-local');

    const secretResponse = await fetch(`${remote.url}/v0/updateRuntimeSettings`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ secrets: { openAiCompatibleApiKey: 'must-not-be-stored' } }),
    });
    assert.equal(secretResponse.status, 500);
    const secretBody = await secretResponse.json();
    assert.equal(
      secretBody.error.code,
      'CONTEXTFORGE_PLAINTEXT_RUNTIME_SECRET_OPT_IN_REQUIRED',
    );

    const resumeResponse = await fetch(`${remote.url}/v0/syncResumeContext`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: 'repo',
        scopeKey: 'http-api-repo',
        query: 'previous work',
      }),
    });
    assert.equal(resumeResponse.status, 200);
    const resumeBody = await resumeResponse.json();
    assert.equal(resumeBody.result.storage.connection.mode, 'remote-client');
    assert.equal(resumeBody.result.storage.connection.accessMode, 'remote-client');
    assert.equal(resumeBody.result.storage.connection.accessPath, 'http-api');
    assert.equal(resumeBody.result.storage.connection.transport, 'http-api');
    assert.equal(resumeBody.result.storage.connection.serverRole, 'http-server');
    assert.equal(resumeBody.result.storage.connection.server.mode, 'http-server');
  } finally {
    await remote.close();
  }
});
