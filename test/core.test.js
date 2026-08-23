import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseJunitReport } from '../scripts/junit-report.js';
import {
  makeGitRepo,
} from './helpers/fixtures.js';
import {
  fakeSpawnThatClosesOnKill,
  testAdminPasswordHash,
} from './helpers/schema.js';
import { makeTempDir, waitForCondition } from './helpers/temp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import {
  createCodexSdkPythonAutoPromoteAuditor,
  runCodexSdkPythonCommand,
} from '../src/audit/codex_sdk_python.js';
import {
  createTokenAuthorizer,
  REMOTE_METHOD_CAPABILITIES,
  TOKEN_CAPABILITIES,
} from '../src/auth/token_authorization.js';
import { createContextForge } from '../src/core.js';
import { runCodexExecCommand } from '../src/distill/providers/codex_exec.js';
import {
  createOpenAiCompatibleProvider,
} from '../src/distill/providers/openai_compatible.js';
import { STRUCTURED_CHECKPOINT_SCHEMA_VERSION, validateDistillOutput } from '../src/distill/validate.js';
import { createOpenAiEmbeddingProvider } from '../src/embeddings/index.js';
import { createInterruptibleSleep } from '../src/ingest/common.js';
import { listAgentAdapters } from '../src/ingest/agents.js';
import {
  ALL_MCP_TOOL_NAMES,
  createContextForgeMcpServer,
  getContextForgeMcpSurfaceInfo,
  MCP_TOOL_PROFILES,
  resolveMcpToolSelection,
} from '../src/mcp.js';
import { REMOTE_METHODS } from '../src/remote/client.js';
import { ProviderTimeoutError } from '../src/runtime/provider_execution.js';
import {
  registerRuntimeChild,
  runtimeChildSnapshot,
  terminateRuntimeChildren,
} from '../src/runtime/child_processes.js';
import { startContextForgeServer } from '../src/server.js';
import { ContextForgeStore, SCHEMA_VERSION, SQLITE_JOURNAL_MODE } from '../src/storage/sqlite.js';
import { PRIVATE_DATA_FILE_MODE } from '../src/storage/permissions.js';
import { backupSqliteDatabase } from '../src/storage/backup.js';
import { ExternalProviderDisabledInTestError } from '../src/testing/external_provider.js';
import { CONTEXTFORGE_VERSION } from '../src/version.js';

const execFileAsync = promisify(execFile);
const packageManifest = createRequire(import.meta.url)('../package.json');

test('package, lockfile, CLI, and release docs share the canonical version', async () => {
  const packageLock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  const koreanReadme = await fs.readFile(new URL('../README.ko.md', import.meta.url), 'utf8');

  assert.equal(CONTEXTFORGE_VERSION, packageManifest.version);
  assert.equal(packageLock.version, packageManifest.version);
  assert.equal(packageLock.packages[''].version, packageManifest.version);
  assert.ok(readme.includes('Current package version: `' + packageManifest.version + '`'));
  assert.match(readme, new RegExp(`## What's New In ${packageManifest.version.replaceAll('.', '\\.')}`));
  assert.ok(koreanReadme.includes('현재 package version: `' + packageManifest.version + '`'));
  assert.ok(koreanReadme.includes(`## ${packageManifest.version}에서 좋아진 점`));

  for (const command of ['--version', 'version']) {
    const result = await execFileAsync('node', ['src/cli.js', command], { cwd: process.cwd() });
    assert.equal(result.stdout.trim(), packageManifest.version);
  }
  const help = await execFileAsync('node', ['src/cli.js', '--help'], { cwd: process.cwd() });
  const helpPayload = JSON.parse(help.stdout);
  assert.equal(helpPayload.name, 'contextforge');
  assert.equal(helpPayload.version, packageManifest.version);
  assert.ok(helpPayload.commands.includes('version'));
});

test('interruptible ingest sleep wakes when stopped', async () => {
  const sleeper = createInterruptibleSleep();
  let resolved = false;
  const wait = sleeper.sleep(10000).then(() => {
    resolved = true;
  });
  sleeper.stop();
  await wait;
  assert.equal(resolved, true);
});

test('normal test mode fails closed before external provider runners or fetch execute', async () => {
  assert.equal(process.env.CONTEXTFORGE_TEST_MODE, 'true');
  assert.equal(process.env.CONTEXTFORGE_LIVE_TESTS, 'false');
  const expectedError = (error, provider) => {
    assert.equal(error instanceof ExternalProviderDisabledInTestError, true);
    assert.equal(error.code, 'CONTEXTFORGE_EXTERNAL_PROVIDER_DISABLED_IN_TEST');
    assert.equal(error.provider, provider);
    return true;
  };

  assert.throws(
    () =>
      runCodexExecCommand({
        command: 'codex-must-not-run',
        args: [],
        prompt: '',
        timeoutMs: 1000,
        cwd: process.cwd(),
      }),
    (error) => expectedError(error, 'codex_exec'),
  );
  assert.throws(
    () =>
      runCodexSdkPythonCommand({
        pythonCommand: 'python-must-not-run',
        scriptPath: 'missing.py',
        codexBin: 'codex-must-not-run',
        model: 'test',
        sandbox: 'read-only',
        prompt: '',
        timeoutMs: 1000,
        cwd: process.cwd(),
      }),
    (error) => expectedError(error, 'codex_sdk_python_audit'),
  );
  assert.throws(
    () => createOpenAiCompatibleProvider({ apiKey: 'synthetic-test-key' }),
    (error) => expectedError(error, 'openai_compatible'),
  );
  assert.throws(
    () =>
      createOpenAiEmbeddingProvider({
        apiKey: 'synthetic-test-key',
        baseUrl: 'https://example.invalid/v1',
        model: 'text-embedding-3-small',
        dimensions: 3,
        timeoutMs: 1000,
      }),
    (error) => expectedError(error, 'openai_embeddings'),
  );
});

test('child provider timeouts wait for SIGKILL close before rejecting', async () => {
  for (const provider of ['codex_exec', 'codex_sdk_python']) {
    const fake = fakeSpawnThatClosesOnKill();
    let rejectedAfterClose = false;
    const call =
      provider === 'codex_exec'
        ? runCodexExecCommand({
            command: 'synthetic-codex',
            args: [],
            prompt: 'synthetic prompt',
            timeoutMs: 5,
            killGraceMs: 5,
            cwd: process.cwd(),
            spawnImpl: fake.spawnImpl,
          })
        : runCodexSdkPythonCommand({
            pythonCommand: 'synthetic-python',
            scriptPath: 'synthetic-runner.py',
            codexBin: 'synthetic-codex',
            model: 'synthetic-model',
            sandbox: 'read-only',
            prompt: 'synthetic prompt',
            timeoutMs: 5,
            killGraceMs: 5,
            cwd: process.cwd(),
            spawnImpl: fake.spawnImpl,
          });

    await assert.rejects(call, (error) => {
      rejectedAfterClose = fake.child.closed;
      assert.equal(error.code, 'CONTEXTFORGE_PROVIDER_TIMEOUT');
      assert.equal(error.retryable, true);
      return true;
    });
    assert.equal(rejectedAfterClose, true);
    assert.deepEqual(fake.child.signals, ['SIGTERM', 'SIGKILL']);
  }
});

test('runtime child registry sends TERM on shutdown and unregisters on close', () => {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  registerRuntimeChild(child);
  assert.equal(runtimeChildSnapshot().active, 1);
  assert.deepEqual(terminateRuntimeChildren({ killAfterMs: 1000 }), { signaled: 1, killAfterMs: 1000 });
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  assert.equal(runtimeChildSnapshot().active, 0);
});

test('JUnit duration parser is independent of testcase attribute order', () => {
  const report = parseJunitReport(`
    <testsuites>
      <testcase classname="test" time="0.125" name="classname-first" />
      <testcase name="name-first" file="test/example.test.js" time="1.5" />
      <!-- duration_ms 1700.25 -->
    </testsuites>
  `);
  assert.deepEqual(report.testCases, [
    { name: 'classname-first', durationMs: 125 },
    { name: 'name-first', durationMs: 1500 },
  ]);
  assert.equal(report.reportedDurationMs, 1700.25);
});

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

test('bootstrapContext includes working summary and recent raw tail separately from search results', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'working_summary_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      working_summary_provider: async () => ({
        summaryShort: 'Working summary checkpoint.',
        summaryText: 'Checkpoint delta: the agent implemented storage scaffolding.',
        workingSummary: 'Current state: storage is done, bootstrap wiring is next.',
        decisions: [],
        todos: ['Wire bootstrapContext to include working summary.'],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        metadata: { synthetic: true },
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-working',
    key: 'durable-rule',
    content: 'Durable memory remains reviewed canonical state.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    role: 'user',
    content: 'Implement working summaries.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    role: 'assistant',
    content: 'Bootstrap wiring is now in progress.',
  });

  const defaultBootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
  });
  assert.deepEqual(defaultBootstrap.rawTail, []);
  assert.equal(defaultBootstrap.rawTailLimit, 0);

  const zeroBootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
    rawTailLimit: 0,
  });
  assert.deepEqual(zeroBootstrap.rawTail, []);
  assert.equal(zeroBootstrap.rawTailLimit, 0);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-working',
    sessionId: 'working-session',
    query: 'durable working summary bootstrap',
    rawTailLimit: 1,
  });

  assert.equal(bootstrap.results.some((item) => item.type === 'memory' && item.key === 'durable-rule'), true);
  assert.equal(bootstrap.workingSummary.type, 'working_summary');
  assert.equal(bootstrap.workingSummary.trust, 'live_continuity');
  assert.match(bootstrap.workingSummary.content, /storage is done/);
  assert.equal(bootstrap.rawTail.length, 1);
  assert.match(bootstrap.rawTail[0].content, /Bootstrap wiring/);
});

test('bootstrapContext includes latest checkpoints independently from search results', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'handoff_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      handoff_provider: async (input) => {
        const latestContent = input.rawEvents.at(-1).content;
        if (latestContent.includes('usage smoke')) {
          return {
            summaryShort: 'Usage smoke checkpoint.',
            summaryText: `Synthetic checkpoint: ${latestContent}`,
            decisions: [],
            todos: [],
            openQuestions: [],
            memoryCandidates: [],
            sourceEventCount: input.rawEvents.length,
            metadata: { synthetic: true },
          };
        }
        return {
          summaryShort: 'Latest handoff.',
          summaryText: `Recent checkpoint: ${latestContent}`,
          decisions: ['Recent decision.'],
          todos: ['Recent todo.'],
          openQuestions: [],
          memoryCandidates: [],
          structured: {
            schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
            work: {
              intent: 'Preserve latest handoff independently from search ranking.',
              status: 'verified',
              outcome: 'Latest checkpoint should appear in handoff.latestHandoff.',
            },
            liveState: {
              repo: 'github.com/example/mcp-repo',
              branch: 'feature/handoff',
              headCommit: 'abc1234',
              ciStatus: 'pass',
              observedAt: '2026-06-03T00:00:00Z',
              verificationRequired: true,
              staleReasons: ['branch, commit, and CI are mutable live state'],
              verifyHints: ['git status --short --branch', 'gh pr view 123 --json statusCheckRollup'],
            },
            changes: [],
            verification: [],
            risks: [],
            nextActions: [],
          },
          sourceEventCount: input.rawEvents.length,
          metadata: { synthetic: true },
        };
      },
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    key: 'durable-bootstrap-hit',
    content: 'Durable bootstrap memory should win ordinary search ranking.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'handoff-session',
    role: 'assistant',
    content: 'PR #123 merged after all CI passed.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'handoff-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'usage-smoke-session',
    role: 'assistant',
    content: 'usage smoke checkpoint should not become the preferred latest handoff.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    sessionId: 'usage-smoke-session',
    source: 'manual',
    sourceRef: 'usage-smoke',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    query: 'durable bootstrap memory',
  });

  assert.equal(bootstrap.results.some((item) => item.type === 'memory' && item.key === 'durable-bootstrap-hit'), true);
  assert.equal(bootstrap.handoff.latestCheckpointLimit, 1);
  assert.deepEqual(bootstrap.handoff.relatedScopeKeys, []);
  assert.equal(bootstrap.handoff.latestHandoff.id, bootstrap.handoff.latestCheckpoints[0].id);
  assert.equal(bootstrap.handoff.latestHandoff.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.equal(bootstrap.handoff.latestHandoff.structured.liveState.branch, 'feature/handoff');
  assert.equal(bootstrap.handoff.latestHandoff.source, 'distill');
  assert.notEqual(bootstrap.handoff.latestHandoff.sessionId, 'usage-smoke-session');
  assert.equal(bootstrap.handoff.latestHandoff.structuredWarnings[0].code, 'live_state_may_be_stale');
  assert.ok(bootstrap.handoff.latestHandoff.structuredWarnings[0].fields.includes('liveState.branch'));
  assert.deepEqual(bootstrap.handoff.latestHandoff.structuredWarnings[0].verifyHints, [
    'git status --short --branch',
    'gh pr view 123 --json statusCheckRollup',
  ]);
  assert.equal(bootstrap.handoff.latestCheckpoints.length, 1);
  assert.equal(bootstrap.handoff.latestCheckpoints[0].trust, 'credible_recent_handoff');
  assert.equal(bootstrap.handoff.latestCheckpoints[0].scope.scopeKey, 'repo-handoff');
  assert.match(bootstrap.handoff.latestCheckpoints[0].summaryText, /PR #123 merged/);
  assert.ok(bootstrap.handoff.latestCheckpoints[0].useFor.includes('recent_status'));

  const disabled = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-handoff',
    query: 'durable bootstrap memory',
    latestCheckpointLimit: 0,
  });
  assert.deepEqual(disabled.handoff.latestCheckpoints, []);
  assert.equal(disabled.handoff.latestHandoff, null);
});

test('bootstrapContext falls back to newest checkpoint when no preferred handoff exists', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'plain_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      plain_provider: async (input) => ({
        summaryShort: input.rawEvents.at(-1).content,
        summaryText: `Plain checkpoint: ${input.rawEvents.at(-1).content}`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: input.rawEvents.length,
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-old',
    role: 'assistant',
    content: 'older manual checkpoint',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-old',
    source: 'manual',
    sourceRef: 'older',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-new',
    role: 'assistant',
    content: 'newer manual checkpoint',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    sessionId: 'plain-new',
    source: 'manual',
    sourceRef: 'newer',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-plain-handoff',
    query: 'plain checkpoint fallback',
  });

  assert.equal(bootstrap.handoff.latestHandoff.sessionId, 'plain-new');
  assert.equal(bootstrap.handoff.latestHandoff.source, 'manual');
  assert.equal(bootstrap.handoff.latestHandoff.structured, null);
  assert.equal(bootstrap.handoff.latestCheckpoints[0].sessionId, 'plain-new');
});

test('bootstrapContext returns compact memory map and cluster expansion hooks', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    key: 'retrieval.progressive-map',
    content:
      'Progressive retrieval should return a compact memory map with canonical consolidated memory before individual memory fragments.',
    category: 'architecture',
    tags: ['retrieval', 'memory-map', 'cluster'],
    importance: 5,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    key: 'retrieval.cluster-expansion',
    content:
      'Cluster expansion loads related atomic durable memories on demand without pulling every durable memory in the scope.',
    category: 'architecture',
    tags: ['retrieval', 'memory-map', 'cluster'],
    importance: 4,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    key: 'runtime.scheduler-note',
    content: 'Scheduler maintenance windows belong to runtime operations and service restarts.',
    category: 'operations',
    tags: ['scheduler'],
    importance: 3,
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-memory-map',
    query: 'progressive retrieval memory map cluster expansion',
    memoryMapLimit: 3,
    memoryMapClusterSize: 4,
  });

  assert.equal(bootstrap.memoryMap.kind, 'memory_map');
  assert.equal(bootstrap.memoryMap.query, 'progressive retrieval memory map cluster expansion');
  assert.equal(bootstrap.memoryMap.embedding.degraded, true);
  assert.ok(bootstrap.memoryMap.embedding.reasons.includes('query_embedding_unavailable'));
  assert.ok(Array.isArray(bootstrap.results));
  assert.ok(bootstrap.results.some((item) => item.type === 'memory'));
  assert.ok(bootstrap.memoryMap.clusters.length >= 1);

  const cluster = bootstrap.memoryMap.clusters[0];
  assert.equal(cluster.retrievalHooks.expand.tool, 'expand_memory_cluster');
  assert.equal(cluster.retrievalHooks.expand.method, 'expandMemoryCluster');
  assert.equal(cluster.consolidatedMemory.key, 'retrieval.progressive-map');
  assert.ok(cluster.consolidatedMemory.coverageCount >= 2);
  assert.ok(cluster.members.some((member) => member.key === 'retrieval.cluster-expansion'));
  assert.ok(!cluster.members.some((member) => member.key === 'runtime.scheduler-note'));
});

test('bootstrapContext uses seed embeddings for memory map cluster membership', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => {
        const value = String(text).toLowerCase();
        if (
          value.includes('authorization') ||
          value.includes('permission gate') ||
          value.includes('bearer credentials')
        ) {
          return [1, 0, 0];
        }
        if (value.includes('billing')) return [0, 1, 0];
        return [0, 0, 1];
      });
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    key: 'auth.header-contract',
    content: 'Authorization header is required for protected endpoints.',
    category: 'api',
    tags: ['http'],
    importance: 5,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    key: 'security.gateway-rule',
    content: 'Permission gate validates bearer credentials before handlers run.',
    category: 'security',
    tags: ['gateway'],
    importance: 3,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    key: 'billing.export-rule',
    content: 'Billing export files are produced after monthly closeout.',
    category: 'finance',
    tags: ['billing'],
    importance: 4,
  });
  await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-vector-map',
    query: 'authorization protected endpoints',
    limit: 1,
    memoryMapClusterSize: 4,
  });

  assert.equal(bootstrap.memoryMap.embedding.degraded, false);
  assert.equal(bootstrap.memoryMap.embedding.used, true);
  assert.equal(bootstrap.memoryMap.embedding.relationEmbeddingsUsed, true);
  const cluster = bootstrap.memoryMap.clusters[0];
  const vectorMember = cluster.members.find((member) => member.key === 'security.gateway-rule');
  assert.ok(vectorMember);
  assert.ok(vectorMember.vectorScore > 0);
  assert.ok(!cluster.members.some((member) => member.key === 'billing.export-rule'));
});

test('expandMemoryCluster returns atomic durable memories for one map cluster', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    key: 'retrieval.canonical-contract',
    content:
      'Canonical durable memory for progressive retrieval says agents should read the memory map first.',
    category: 'runbook',
    tags: ['retrieval', 'memory-map'],
    importance: 6,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    key: 'retrieval.atomic-detail',
    content:
      'Atomic durable memory detail says expand the selected memory cluster only when implementation details are needed.',
    category: 'runbook',
    tags: ['retrieval', 'memory-map'],
    importance: 4,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    key: 'billing.unrelated',
    content: 'Billing exports use a separate monthly closeout workflow.',
    category: 'finance',
    tags: ['billing'],
    importance: 4,
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    query: 'progressive retrieval memory map canonical atomic detail',
  });
  const clusterId = bootstrap.memoryMap.clusters[0].clusterId;
  const expansion = await app.expandMemoryCluster({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    clusterId,
    limit: 4,
  });

  assert.equal(expansion.kind, 'memory_cluster_expansion');
  assert.equal(expansion.clusterId, clusterId);
  assert.equal(expansion.provenanceIncluded, false);
  assert.equal(expansion.cluster.consolidatedMemory.key, 'retrieval.canonical-contract');
  assert.ok(expansion.memories.some((memory) => memory.key === 'retrieval.atomic-detail'));
  assert.ok(!expansion.memories.some((memory) => memory.key === 'billing.unrelated'));
  assert.equal(expansion.memories.some((memory) => memory.provenance), false);

  const withProvenance = await app.expandMemoryCluster({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    clusterId,
    includeProvenance: true,
    limit: 4,
  });
  assert.equal(withProvenance.clusterId, clusterId);
  assert.equal(withProvenance.provenanceIncluded, true);
  assert.ok(Array.isArray(withProvenance.memories[0].provenance));

  const byQuery = await app.expandMemoryCluster({
    scope: 'repo',
    scopeKey: 'repo-cluster-expand',
    query: 'selected memory cluster atomic detail',
    limit: 4,
  });
  assert.equal(byQuery.memories.some((memory) => memory.key === 'retrieval.canonical-contract'), true);
});

test('bootstrapContext records session-first consult reasons and active-session warnings', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    key: 'targeted-search-rule',
    content: 'Use targeted search for active-session API lookup.',
  });

  const startup = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'startup consult policy',
    consultReason: 'startup',
  });
  assert.equal(startup.consult.reason, 'startup');
  assert.equal(startup.consult.handoffRecommended, true);
  assert.deepEqual(startup.consult.warnings, []);

  const active = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    sessionId: 'active-session',
    query: 'active session consult policy',
    consultReason: 'active_session',
  });
  assert.equal(active.consult.reason, 'active_session');
  assert.equal(active.consult.handoffRecommended, false);
  assert.ok(active.consult.warnings.some((warning) => warning.code === 'active_session_handoff_not_self_check'));
  assert.ok(active.consult.warnings.some((warning) => warning.code === 'same_session_bootstrap_warning'));
  assert.ok(!active.nextActions.some((action) => /routine self-confirmation/.test(action)));

  const targeted = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'targeted API lookup',
    consultReason: 'targeted_search',
  });
  assert.ok(targeted.consult.recommendedTools.includes('search'));
  assert.ok(targeted.consult.warnings.some((warning) => warning.code === 'prefer_search_for_targeted_lookup'));

  const liveState = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'runtime status check',
    consultReason: 'live_state_check',
  });
  assert.ok(liveState.consult.recommendedTools.includes('db_info'));
  assert.ok(liveState.consult.warnings.some((warning) => warning.code === 'prefer_live_sources_for_mutable_state'));

  const compaction = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'compaction recovery',
    consultReason: 'compaction_recovery',
  });
  assert.equal(compaction.consult.handoffRecommended, true);

  const resume = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'resume recovery',
    consultReason: 'resume',
  });
  assert.equal(resume.consult.handoffRecommended, true);

  const agentSwitch = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consult-policy',
    query: 'agent switch recovery',
    consultReason: 'agent_switch',
  });
  assert.equal(agentSwitch.consult.handoffRecommended, true);

  await assert.rejects(
    () =>
      app.bootstrapContext({
        scope: 'repo',
        scopeKey: 'repo-consult-policy',
        query: 'bad consult reason',
        consultReason: 'just_checking',
      }),
    /consultReason/,
  );
});

test('processConsolidations creates scope-window checkpoints and bootstrap exposes them', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  let providerInput = null;
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('consolidated') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'consolidation_provider',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    store,
    embeddingProviders: {
      openai: embeddingProvider,
    },
    distillProviders: {
      consolidation_provider: async (input) => {
        providerInput = input;
        return {
          summaryShort: 'Daily consolidated context.',
          summaryText: `Daily consolidated context from ${input.sourceCheckpoints.length} source checkpoints.`,
          decisions: ['Use period consolidation for bootstrap context.'],
          todos: ['Verify mutable live state before acting.'],
          openQuestions: [],
          memoryCandidates: [
            {
              key: 'period-consolidation-runbook',
              content: 'Period consolidation should preserve repeated durable runbook signals.',
              reason: 'Repeated across source checkpoints.',
              promotionRecommendation: 'review',
            },
          ],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: { synthetic: true, codexExec: { inputTruncated: true } },
        };
      },
    },
  });

  for (const [sessionId, summaryText] of [
    ['thread-a', 'First checkpoint mentions bootstrap being too thin.'],
    ['thread-a', 'Second checkpoint mentions preserving period context.'],
    ['thread-b', 'Third checkpoint from another session mentions memory candidates.'],
  ]) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-consolidation',
      sessionId,
      summaryShort: 'Source checkpoint.',
      summaryText,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {
        sourceProvenance: {
          sourceAgent: sessionId === 'thread-b' ? 'claude_code' : 'codex',
        },
      },
    });
  }
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    key: 'existing-memory',
    content: 'Existing durable memory for lifecycle summary.',
  });

  const due = app.listDueConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(due.count, 1);
  assert.equal(due.items[0].target, 'repo');
  assert.equal(due.items[0].sourceCheckpointCount, 3);
  assert.equal(due.memoryLifecycle.latestPromotedAt != null, true);

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(result.created, 1);
  assert.equal(result.checkpoint.source, 'daily_consolidation');
  assert.equal(result.checkpoint.metadata.consolidation.target, 'repo');
  assert.equal(result.checkpoint.metadata.consolidation.windowKind, 'daily');
  assert.equal(result.checkpoint.metadata.consolidation.inputTruncated, true);
  assert.equal(result.checkpoint.metadata.consolidation.sourceCheckpointIds.length, 3);
  assert.deepEqual(result.checkpoint.metadata.consolidation.sourceAgents.sort(), ['claude_code', 'codex']);
  assert.equal(result.memoryCandidateCount, 1);
  assert.equal(result.embedding.queued, 2);
  assert.equal(providerInput.consolidation.target, 'repo');
  assert.equal(providerInput.rawEvents.length, 0);
  assert.equal(providerInput.sourceCheckpoints.length, 3);
  assert.throws(
    () =>
      store.insertCheckpoint({
        scopeType: 'repo',
        scopeKey: 'repo-consolidation',
        sessionId: 'duplicate-consolidation',
        summaryShort: 'Duplicate consolidation.',
        summaryText: 'This should be blocked by the consolidation uniqueness index.',
        decisions: [],
        todos: [],
        openQuestions: [],
        sourceEventCount: 1,
        provider: 'test',
        source: 'daily_consolidation',
        sourceRef: result.checkpoint.sourceRef,
        metadata: {
          consolidation: {
            target: 'repo',
          },
        },
      }),
    /UNIQUE constraint failed|constraint/i,
  );
  assert.throws(
    () =>
      app.listDueConsolidations({
        scope: 'repo',
        scopeKey: 'repo-consolidation',
        target: 'repo',
        windowKind: 'rolling',
      }),
    /windowKind must be one of: daily, custom/,
  );

  const duplicate = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    target: 'repo',
    day: new Date().toISOString(),
  });
  assert.equal(duplicate.created, 0);
  assert.equal(duplicate.skipped, 1);
  assert.equal(duplicate.items[0].reason, 'already_exists');

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-consolidation',
    query: 'period consolidation bootstrap',
  });
  assert.equal(bootstrap.handoff.latestConsolidation.repo.id, result.checkpoint.id);
  assert.equal(bootstrap.handoff.latestConsolidation.repo.consolidation.target, 'repo');
  assert.equal(bootstrap.memoryLifecycle.pendingReviewCount, 1);
  assert.equal(bootstrap.memoryLifecycle.candidatesLast7d >= 1, true);
  assert.equal(bootstrap.rawTail, undefined);
});

test('processConsolidations collapses race duplicate insertions into already_exists', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'race_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      race_provider: async (input) => {
        store.insertCheckpoint({
          scopeType: input.session.scopeType,
          scopeKey: input.session.scopeKey,
          sessionId: 'competing-worker',
          summaryShort: 'Competing consolidation.',
          summaryText: 'A competing worker inserted this consolidation first.',
          decisions: [],
          todos: [],
          openQuestions: [],
          sourceEventCount: input.sourceCheckpoints.length,
          provider: 'race_provider',
          level: 1,
          coversFrom: input.consolidation.coversFrom,
          coversTo: input.consolidation.coversTo,
          source: 'daily_consolidation',
          sourceRef: input.consolidation.sourceRef,
          metadata: {
            consolidation: {
              target: input.consolidation.target,
            },
          },
        });
        return {
          summaryShort: 'Losing consolidation.',
          summaryText: 'This output should be collapsed to the existing checkpoint.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: {},
        };
      },
    },
  });

  for (const summaryText of ['First source checkpoint.', 'Second source checkpoint.']) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-consolidation-race',
      sessionId: 'thread-race',
      summaryShort: 'Source checkpoint.',
      summaryText,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {},
    });
  }

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-consolidation-race',
    target: 'repo',
    day: new Date().toISOString(),
  });

  assert.equal(result.processed, 1);
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.items[0].reason, 'already_exists');
  assert.equal(result.checkpoint.summaryShort, 'Competing consolidation.');
});

test('processConsolidations supports thread windows without mixing sessions', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  let sourceSessionIds = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'thread_consolidation_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      thread_consolidation_provider: async (input) => {
        sourceSessionIds = input.sourceCheckpoints.map((checkpoint) => checkpoint.sessionId);
        return {
          summaryShort: 'Thread consolidated context.',
          summaryText: 'Thread consolidated context from one session.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.sourceCheckpoints.length,
          metadata: {},
        };
      },
    },
  });

  for (const sessionId of ['target-thread', 'target-thread', 'other-thread']) {
    store.insertCheckpoint({
      scopeType: 'repo',
      scopeKey: 'repo-thread-consolidation',
      sessionId,
      summaryShort: 'Thread source checkpoint.',
      summaryText: `Checkpoint for ${sessionId}.`,
      decisions: [],
      todos: [],
      openQuestions: [],
      sourceEventCount: 1,
      provider: 'test',
      source: 'distill',
      metadata: {},
    });
  }

  const result = await app.processConsolidations({
    scope: 'repo',
    scopeKey: 'repo-thread-consolidation',
    target: 'thread',
    sessionId: 'target-thread',
    day: new Date().toISOString(),
  });

  assert.equal(result.created, 1);
  assert.deepEqual(sourceSessionIds, ['target-thread', 'target-thread']);
  assert.deepEqual(result.checkpoint.metadata.consolidation.sourceSessionIds, ['target-thread']);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-thread-consolidation',
    sessionId: 'target-thread',
    query: 'thread consolidated context',
  });
  assert.equal(bootstrap.handoff.latestConsolidation.thread.id, result.checkpoint.id);
});

test('bootstrapContext can include latest checkpoints from related repo scopes', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'related_handoff_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      related_handoff_provider: async (input) => ({
        summaryShort: 'Latest related handoff.',
        summaryText: `Recent related checkpoint: ${input.rawEvents.at(-1).content}`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: input.rawEvents.length,
        metadata: {},
      }),
    },
  });

  for (const scopeKey of ['repo-child', 'repo-suite']) {
    app.appendRaw({
      scope: 'repo',
      scopeKey,
      sessionId: `${scopeKey}-session`,
      role: 'assistant',
      content: `Checkpoint evidence for ${scopeKey}.`,
    });
    await app.distillCheckpoint({
      scope: 'repo',
      scopeKey,
      sessionId: `${scopeKey}-session`,
    });
  }

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-child',
    relatedScopeKeys: ['repo-suite', 'repo-suite', 'repo-child'],
    query: 'unrelated query still needs latest handoff',
  });

  assert.deepEqual(
    bootstrap.handoff.latestCheckpoints.map((checkpoint) => checkpoint.scope.scopeKey).sort(),
    ['repo-child', 'repo-suite'],
  );
  assert.deepEqual(bootstrap.handoff.relatedScopeKeys, ['repo-suite']);

  await assert.rejects(
    () =>
      app.bootstrapContext({
        scope: 'repo',
        scopeKey: 'repo-child',
        query: 'invalid handoff limit',
        latestCheckpointLimit: 4,
      }),
    /latestCheckpointLimit must be an integer between 0 and 3/,
  );
});

test('distillCheckpoint passes previous working summary to provider for rolling updates', async () => {
  const dataDir = await makeTempDir();
  const seenPreviousWorkingSummaries = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'rolling_summary_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      rolling_summary_provider: async (input) => {
        seenPreviousWorkingSummaries.push(input.previousWorkingSummary);
        return {
          summaryShort: 'Rolling summary checkpoint.',
          summaryText: 'Checkpoint delta for rolling summary.',
          workingSummary: input.previousWorkingSummary
            ? `${input.previousWorkingSummary.summaryText}\nUpdated with second pass.`
            : 'Initial rolling state.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.rawEvents.length,
          metadata: {},
        };
      },
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
    role: 'user',
    content: 'Initial raw event.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
    role: 'assistant',
    content: 'Second raw event.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
  });

  assert.equal(seenPreviousWorkingSummaries[0], null);
  assert.match(seenPreviousWorkingSummaries[1].summaryText, /Initial rolling state/);
  const workingSummary = app.getWorkingSummary({
    scope: 'repo',
    scopeKey: 'repo-rolling',
    sessionId: 'rolling-session',
  });
  assert.match(workingSummary.summaryText, /Updated with second pass/);
});

test('distillCheckpoint recovers when working summary update fails after checkpoint insert', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'summary_fail_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      summary_fail_provider: async () => ({
        summaryShort: 'Checkpoint survives.',
        summaryText: 'The checkpoint should persist even if working summary update fails.',
        workingSummary: 'This working summary update will fail.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        metadata: {},
      }),
    },
  });
  store.upsertWorkingSummary = () => {
    throw new Error('synthetic working summary failure');
  };

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-summary-fail',
    sessionId: 'summary-fail-session',
    role: 'assistant',
    content: 'Checkpoint should still be inserted.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-summary-fail',
    sessionId: 'summary-fail-session',
  });

  assert.equal(checkpoint.summaryShort, 'Checkpoint survives.');
  assert.equal(checkpoint.workingSummary.updated, false);
  assert.match(checkpoint.workingSummary.error.message, /synthetic working summary failure/);
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-summary-fail',
    sessionId: 'summary-fail-session',
  });
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].outputMetadata.checkpointId, checkpoint.id);
  assert.match(runs[0].outputMetadata.workingSummaryError.message, /synthetic working summary failure/);
  app.close();
});

test('distillCheckpoint records working summary if checkpoint insert fails', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'checkpoint_fail_provider',
    },
    cwd: process.cwd(),
    store,
    distillProviders: {
      checkpoint_fail_provider: async () => ({
        summaryShort: 'Summary survives.',
        summaryText: 'Checkpoint insert will fail.',
        workingSummary: 'Current state can still be saved for handoff.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        metadata: {},
      }),
    },
  });
  store.insertCheckpoint = () => {
    throw new Error('synthetic checkpoint insert failure');
  };

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
    role: 'assistant',
    content: 'Working summary should still be attempted.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-checkpoint-fail',
        sessionId: 'checkpoint-fail-session',
      }),
    /synthetic checkpoint insert failure/,
  );

  const workingSummary = app.getWorkingSummary({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
  });
  assert.match(workingSummary.summaryText, /still be saved/);
  assert.equal(workingSummary.sourceCheckpointId, null);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].outputMetadata.checkpointFailed, true);
  assert.equal(runs[0].outputMetadata.workingSummaryUpdated, true);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-checkpoint-fail',
    sessionId: 'checkpoint-fail-session',
    query: 'checkpoint failed handoff',
  });
  assert.equal(bootstrap.workingSummary.degraded, true);
  assert.equal(bootstrap.workingSummary.checkpointInsertFailed, true);
  app.close();
});

test('raw event TTL pruning deletes only checkpoint-covered evidence and preserves the latest tail', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
    role: 'user',
    content: 'old raw evidence',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
    role: 'assistant',
    content: 'fresh raw evidence',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
    role: 'assistant',
    content: 'old raw tail after checkpoint',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare("UPDATE raw_events SET created_at = ? WHERE content IN (?, ?)").run(
      '2026-01-01T00:00:00.000Z',
      'old raw evidence',
      'old raw tail after checkpoint',
    );
  } finally {
    db.close();
  }

  const dryRun = app.pruneRawEvents({ dryRun: true });
  assert.equal(dryRun.deletedRawEvents, 0);
  assert.equal(dryRun.candidateRawEvents, 2);
  assert.equal(dryRun.eligibleRawEvents, 1);
  assert.equal(dryRun.blockedRawEvents, 1);
  assert.equal(dryRun.sessions[0].status, 'eligible');
  assert.equal(dryRun.sessions[0].reason, 'covered_by_successful_level_zero_checkpoint');
  assert.equal(dryRun.sessions[0].latestCheckpointId, checkpoint.id);

  const result = app.pruneRawEvents();
  assert.equal(result.ttlDays, 7);
  assert.equal(result.deletedRawEvents, 1);
  assert.equal(result.eligibleRawEvents, 1);
  assert.equal(result.blockedRawEvents, 1);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'repo-ttl',
    sessionId: 'session-ttl',
  });
  assert.deepEqual(
    events.map((event) => event.content).sort(),
    ['fresh raw evidence', 'old raw tail after checkpoint'].sort(),
  );
  app.close();
});

test('raw event TTL pruning blocks sessions without a checkpoint unless force is explicit', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
    },
    cwd: process.cwd(),
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-ttl-uncovered',
    sessionId: 'session-ttl-uncovered',
    role: 'user',
    content: 'undistilled old evidence',
  });
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'undistilled old evidence',
    );
  } finally {
    db.close();
  }

  const blocked = app.pruneRawEvents({ dryRun: true });
  assert.equal(blocked.eligibleRawEvents, 0);
  assert.equal(blocked.blockedRawEvents, 1);
  assert.equal(blocked.sessions[0].status, 'blocked');
  assert.equal(blocked.sessions[0].reason, 'no_level_zero_checkpoint');
  assert.equal(app.pruneRawEvents().deletedRawEvents, 0);

  const forced = app.pruneRawEvents({ dryRun: true, force: true });
  assert.equal(forced.eligibleRawEvents, 1);
  assert.equal(forced.sessions[0].reason, 'force_age_only');
  assert.equal(app.pruneRawEvents({ force: true }).deletedRawEvents, 1);
  app.close();
});

test('raw event TTL pruning blocks previously covered evidence after the latest distill fails', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
    distillProviders: {
      failing_prune_provider: async () => {
        throw new Error('synthetic prune provider failure');
      },
    },
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-failed',
    sessionId: 'session-ttl-failed',
  };
  app.appendRaw({ ...scope, role: 'user', content: 'covered evidence before failure' });
  await app.distillCheckpoint(scope);
  app.appendRaw({ ...scope, role: 'assistant', content: 'evidence selected by failed distill' });
  await assert.rejects(
    () => app.distillCheckpoint({ ...scope, provider: 'failing_prune_provider' }),
    /synthetic prune provider failure/,
  );

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'covered evidence before failure',
    );
  } finally {
    db.close();
  }

  const result = app.pruneRawEvents({ dryRun: true });
  assert.equal(result.eligibleRawEvents, 0);
  assert.equal(result.blockedRawEvents, 1);
  assert.equal(result.sessions[0].status, 'blocked');
  assert.equal(result.sessions[0].reason, 'latest_distill_failed');
  assert.equal(result.sessions[0].latestDistillRunStatus, 'failed');
  assert.equal(app.pruneRawEvents().deletedRawEvents, 0);
  app.close();
});

test('raw event TTL pruning blocks covered evidence while the latest distill is incomplete', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-incomplete',
    sessionId: 'session-ttl-incomplete',
  };
  app.appendRaw({ ...scope, role: 'user', content: 'covered evidence before incomplete run' });
  await app.distillCheckpoint(scope);

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'covered evidence before incomplete run',
    );
    db.prepare(`
      INSERT INTO distill_runs (
        id, scope_type, scope_key, session_id, provider, status,
        source_event_count, input_metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, 'started', 0, '{}', ?)
    `).run(
      'incomplete-prune-run',
      'repo',
      'repo-ttl-incomplete',
      'session-ttl-incomplete',
      'mock',
      new Date(Date.now() + 1000).toISOString(),
    );
  } finally {
    db.close();
  }

  const result = app.pruneRawEvents({ dryRun: true });
  assert.equal(result.eligibleRawEvents, 0);
  assert.equal(result.blockedRawEvents, 1);
  assert.equal(result.sessions[0].reason, 'latest_distill_incomplete');
  assert.equal(result.sessions[0].latestDistillRunStatus, 'started');
  app.close();
});

test('raw event TTL pruning rejects checkpoint coverage without a succeeded distill run', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
    },
    cwd: process.cwd(),
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-unverified-checkpoint',
    sessionId: 'session-ttl-unverified-checkpoint',
  };
  app.appendRaw({ ...scope, role: 'user', content: 'evidence with unverified checkpoint' });
  const rawEvent = app.listRawEvents(scope)[0];

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      rawEvent.id,
    );
    db.prepare(`
      INSERT INTO checkpoints (
        id, scope_type, scope_key, session_id, summary_short, summary_text,
        source_event_count, provider, level, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)
    `).run(
      'unverified-prune-checkpoint',
      'repo',
      'repo-ttl-unverified-checkpoint',
      'session-ttl-unverified-checkpoint',
      'Unverified checkpoint.',
      'This checkpoint is not linked to a succeeded distill run.',
      'synthetic',
      JSON.stringify({ sourceRawEventIds: [rawEvent.id] }),
      '2026-07-10T04:00:00.000Z',
    );
  } finally {
    db.close();
  }

  const result = app.pruneRawEvents({ dryRun: true });
  assert.equal(result.eligibleRawEvents, 0);
  assert.equal(result.blockedRawEvents, 1);
  assert.equal(result.sessions[0].latestCheckpointId, 'unverified-prune-checkpoint');
  assert.equal(result.sessions[0].reason, 'no_successful_level_zero_checkpoint');
  app.close();
});

test('append-time TTL pruning uses the same checkpoint coverage guard', async () => {
  const dataDir = await makeTempDir();
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-ttl-append',
    sessionId: 'session-ttl-append',
  };
  const initial = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  initial.appendRaw({ ...scope, role: 'user', content: 'old undistilled append evidence' });
  initial.close();

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      '2026-01-01T00:00:00.000Z',
      'old undistilled append evidence',
    );
  } finally {
    db.close();
  }

  const reopened = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_RAW_TTL_DAYS: '7',
    },
    cwd: process.cwd(),
  });
  reopened.appendRaw({ ...scope, role: 'assistant', content: 'new append evidence' });
  assert.deepEqual(
    reopened.listRawEvents(scope).map((event) => event.content),
    ['old undistilled append evidence', 'new append evidence'],
  );
  reopened.close();
});

test('char-threshold distillation waits for the char minimum interval after a checkpoint', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_MIN_INTERVAL_MS: '600000',
      CONTEXTFORGE_DISTILL_CHAR_MIN_INTERVAL_MS: '600000',
    },
    cwd: process.cwd(),
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
    role: 'user',
    content: 'first checkpoint seed',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
    role: 'assistant',
    content: 'x'.repeat(500),
  });

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-cost',
    sessionId: 'session-cost',
    charThreshold: 10,
  });
  assert.equal(status.charsSinceLastCheckpoint >= 10, true);
  assert.equal(status.shouldDistill, false);
  assert.equal(status.reasons.includes('char_threshold_since_checkpoint'), false);
  assert.equal(status.thresholds.charMinIntervalMs, 600000);
});

test('sessionStatus continues after the last raw event covered by a checkpoint', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
    role: 'user',
    content: 'covered raw event',
  });
  const firstRaw = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
  })[0];
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
    role: 'assistant',
    content: 'raw appended while distillation was finishing',
  });

  const betweenFirstRawAndCheckpoint = new Date(Date.parse(firstRaw.createdAt) + 1).toISOString();
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE content = ?').run(
      betweenFirstRawAndCheckpoint,
      'raw appended while distillation was finishing',
    );
  } finally {
    db.close();
  }

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-covered',
    sessionId: 'session-covered',
    charThreshold: 1,
    charMinIntervalMs: 1,
  });
  assert.equal(checkpoint.metadata.sourceRawEventIds.length, 1);
  assert.equal(status.latestCheckpointId, checkpoint.id);
  assert.equal(status.eventsSinceLastCheckpoint, 1);
  assert.equal(status.distillWindow.selectedEventCount, 1);
  assert.equal(status.distillWindow.firstRawEventId !== checkpoint.metadata.sourceRawEventIds[0], true);
});

test('listDueDistillSessions finds raw evidence after checkpoint coverage', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });
  const scope = {
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    sessionId: 'catch-up-session',
  };

  app.appendRaw({
    ...scope,
    role: 'user',
    content: 'covered raw event',
  });
  const coveredRaw = app.listRawEvents(scope)[0];
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      coveredRaw.id,
    );
  } finally {
    db.close();
  }

  const checkpoint = await app.distillCheckpoint(scope);
  app.appendRaw({
    ...scope,
    role: 'assistant',
    content: 'tail raw appended after the checkpoint run',
  });
  const tailRaw = app.listRawEvents(scope).find((event) => event.content.includes('tail raw appended'));
  const dbAfterTail = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    dbAfterTail.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:01:00.000Z',
      tailRaw.id,
    );
    dbAfterTail.prepare('UPDATE checkpoints SET created_at = ? WHERE id = ?').run(
      '2026-01-01T00:02:00.000Z',
      checkpoint.id,
    );
  } finally {
    dbAfterTail.close();
  }

  const due = app.listDueDistillSessions({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 5,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
  });

  assert.equal(due.dueCount, 1);
  assert.equal(due.skippedCount, 0);
  assert.deepEqual(due.skipReasonCounts, {});
  assert.equal(due.sessions[0].sessionId, 'catch-up-session');
  assert.equal(due.sessions[0].eventsSinceLastCheckpoint, 1);
  assert.equal(due.sessions[0].charsSinceLastCheckpoint, tailRaw.content.length);
  assert.equal(due.sessions[0].latestCheckpointAt, '2026-01-01T00:02:00.000Z');

  const dryRun = await app.processDueDistills({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 1,
    dryRun: true,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
  });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.processed, 0);
  assert.equal(dryRun.dueCount, 1);

  const processed = await app.processDueDistills({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 1,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
  });
  assert.equal(processed.processed, 1);
  assert.equal(processed.failed, 0);
  assert.equal(processed.results[0].status, 'succeeded');
  assert.equal(processed.results[0].sourceEventCount, 1);

  const after = app.listDueDistillSessions({
    scope: 'repo',
    scopeKey: 'repo-catch-up',
    limit: 5,
    minEvents: 1,
    minIntervalMs: 1,
    charThreshold: 1,
    charMinIntervalMs: 1,
    idleMs: 0,
  });
  assert.equal(after.dueCount, 0);
});

test('listDueDistillSessions skips sessions inside the idle window', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
    },
    cwd: process.cwd(),
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-idle-catch-up',
    sessionId: 'idle-session',
    role: 'user',
    content: 'fresh raw event that should wait for the idle window',
  });

  const due = app.listDueDistillSessions({
    scope: 'repo',
    scopeKey: 'repo-idle-catch-up',
    limit: 5,
    minEvents: 1,
    charThreshold: 1,
    idleMs: 600000,
  });
  assert.equal(due.dueCount, 0);
  assert.equal(due.skippedCount, 1);
  assert.deepEqual(due.skipReasonCounts, { idle_window: 1 });
});

test('CLI due distill commands preserve core default limits', async () => {
  const dataDir = await makeTempDir();
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const listed = await execFileAsync('node', ['src/cli.js', 'listDueDistillSessions'], { env });
  assert.equal(JSON.parse(listed.stdout).limit, 20);

  const dryRun = await execFileAsync('node', ['src/cli.js', 'processDueDistills', '--dryRun', 'true'], { env });
  assert.equal(JSON.parse(dryRun.stdout).limit, 5);

  const explicit = await execFileAsync('node', ['src/cli.js', 'processDueDistills', '--dryRun', 'true', '--limit', '2'], {
    env,
  });
  assert.equal(JSON.parse(explicit.stdout).limit, 2);
});

test('distillCheckpoint drains bounded conversation windows oldest first', async () => {
  const dataDir = await makeTempDir();
  const seen = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'window_provider',
      CONTEXTFORGE_DISTILL_MAX_EVENTS: '3',
      CONTEXTFORGE_DISTILL_MAX_CHARS: '60',
    },
    cwd: process.cwd(),
    distillProviders: {
      window_provider: async (input) => {
        seen.push(input.rawEvents.map((event) => event.content));
        return {
          summaryShort: 'Window checkpoint.',
          summaryText: 'The provider saw a bounded oldest-first conversation window.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [],
          sourceEventCount: input.rawEvents.length,
          metadata: {
            providerNotes: 'synthetic provider output',
            retrievalHooks: ['codex_exec', 'provider contract', 'synthetic raw events'],
          },
        };
      },
    },
  });

  for (let index = 0; index < 6; index += 1) {
    app.appendRaw({
      scope: 'repo',
      scopeKey: 'repo-window',
      sessionId: 'window-session',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `event-${index}`,
    });
  }
  const rawBeforeLegacyTool = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    const toolCreatedAt = new Date(Date.parse(rawBeforeLegacyTool[1].createdAt) + 1).toISOString();
    db.prepare(
      `INSERT INTO raw_events (
        id, scope_type, scope_key, session_id, conversation_id,
        role, content, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-tool-result',
      'repo',
      'repo-window',
      'window-session',
      null,
      'tool_result',
      'legacy tool output should not enter distillation',
      '{}',
      toolCreatedAt,
    );
  } finally {
    db.close();
  }

  const status = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(status.rawEventCount, 7);
  assert.equal(status.distillWindow.candidateEventCount, 6);
  assert.equal(status.distillWindow.selectedEventCount, 3);
  assert.equal(status.distillWindow.truncated, true);

  const firstCheckpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.deepEqual(seen[0], ['event-0', 'event-1', 'event-2']);
  assert.equal(firstCheckpoint.sourceEventCount, 3);
  assert.equal(firstCheckpoint.metadata.sourceRawEventIds.length, 3);
  assert.equal(firstCheckpoint.metadata.sourceEventWindow.selectedEventCount, 3);
  assert.equal(firstCheckpoint.metadata.sourceEventWindow.truncated, true);

  const statusAfterFirst = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(statusAfterFirst.eventsSinceLastCheckpoint, 3);
  assert.equal(statusAfterFirst.distillWindow.selectedEventCount, 3);
  assert.deepEqual(
    app
      .listRawEvents({
        scope: 'repo',
        scopeKey: 'repo-window',
        sessionId: 'window-session',
      })
      .filter(
        (event) =>
          statusAfterFirst.distillWindow.firstRawEventId === event.id ||
          statusAfterFirst.distillWindow.lastRawEventId === event.id,
      )
      .map((event) => event.content),
    ['event-3', 'event-5'],
  );

  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.deepEqual(seen[1], ['event-3', 'event-4', 'event-5']);

  const statusAfterSecond = app.sessionStatus({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(statusAfterSecond.eventsSinceLastCheckpoint, 0);
  assert.equal(statusAfterSecond.distillWindow.selectedEventCount, 0);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-window',
    sessionId: 'window-session',
  });
  assert.equal(runs[0].inputMetadata.rawEventIds.length, 3);
  assert.equal(runs[0].inputMetadata.sourceEventWindow.totalRawEventCount, 7);
  assert.equal(runs[0].inputMetadata.sourceEventWindow.candidateEventCount, 6);
});

test('distillUsage summarizes estimated and actual provider usage', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'usage_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      usage_provider: async () => ({
        summaryShort: 'Usage checkpoint.',
        summaryText: 'The provider returned usage metadata.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: 1,
        provider: 'usage_provider',
        metadata: {
          usage: {
            inputTokens: 42,
            outputTokens: 8,
            totalTokens: 50,
            prompt_cache_hit_tokens: 10,
            prompt_cache_miss_tokens: 32,
          },
        },
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
    role: 'user',
    content: '1234567890',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
  });

  const usage = app.distillUsage({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
    charsPerToken: 5,
  });
  assert.equal(usage.totals.runs, 1);
  assert.equal(usage.totals.succeeded, 1);
  assert.equal(usage.totals.completedRuns, 1);
  assert.equal(usage.totals.selectedCharCount, 10);
  assert.equal(usage.totals.estimatedInputTokens, 2);
  assert.deepEqual(usage.totals.actualUsage, {
    runs: 1,
    inputTokens: 42,
    outputTokens: 8,
    totalTokens: 50,
    promptCacheRuns: 1,
    promptCacheHitTokens: 10,
    promptCacheMissTokens: 32,
    promptCacheHitRatio: 10 / 42,
  });
  assert.equal(usage.totals.persistedUsage.events, 1);
  assert.equal(usage.totals.persistedUsage.inputTokens, 42);
  assert.equal(usage.totals.persistedUsage.cachedInputTokens, 10);
  assert.equal(usage.totals.persistedUsage.uncachedInputTokens, 32);
  assert.equal(usage.totals.persistedUsage.outputTokens, 8);
  assert.equal(usage.totals.persistedUsage.totalTokens, 50);
  assert.equal(usage.totals.persistedUsage.byOperation.checkpoint_distill.events, 1);
  assert.equal(usage.totals.persistedUsage.byProviderModel.usage_provider.events, 1);
  assert.equal(usage.totals.persistedUsage.byProviderModelOperation['usage_provider:checkpoint_distill'].events, 1);
  assert.equal(usage.totals.canonicalUsage.source, 'persisted_usage_events');
  assert.equal(usage.totals.canonicalUsage.totalTokens, 50);
  assert.equal(usage.runs[0].usage.totalTokens, 50);
  assert.equal(usage.runs[0].usage.promptCacheHitTokens, 10);

  const store = new ContextForgeStore({ dataDir });
  const events = store.listLlmUsageEvents({
    scopeType: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'checkpoint_distill');
  assert.equal(events[0].inputTokens, 42);
  assert.equal(events[0].cachedInputTokens, 10);
  assert.equal(events[0].uncachedInputTokens, 32);
  assert.equal(events[0].usage.prompt_cache_hit_tokens, 10);
  store.close();

  const rollup = app.llmUsageRollup({
    scope: 'repo',
    scopeKey: 'repo-usage',
    sessionId: 'usage-session',
  });
  assert.equal(rollup.totals.events, 1);
  assert.equal(rollup.totals.byOperation.checkpoint_distill.totalTokens, 50);
  assert.equal(rollup.totals.byProviderModel.usage_provider.inputTokens, 42);
  assert.equal(rollup.totals.byProviderModelOperation['usage_provider:checkpoint_distill'].outputTokens, 8);
});

test('distillUsage averages elapsed time across completed runs only', async () => {
  const dataDir = await makeTempDir();
  const store = new ContextForgeStore({ dataDir });
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd(), store });
  const scope = { scopeType: 'repo', scopeKey: 'repo-usage-average' };

  store.startDistillRun({
    ...scope,
    sessionId: 'usage-average-session',
    provider: 'mock',
    sourceEventCount: 1,
    inputMetadata: {
      sourceEventWindow: {
        selectedEventCount: 1,
        selectedCharCount: 20,
      },
    },
  });
  const completed = store.startDistillRun({
    ...scope,
    sessionId: 'usage-average-session',
    provider: 'mock',
    sourceEventCount: 1,
    inputMetadata: {
      sourceEventWindow: {
        selectedEventCount: 1,
        selectedCharCount: 40,
      },
    },
  });
  store.completeDistillRun({ id: completed.id });

  const usage = app.distillUsage({
    scope: 'repo',
    scopeKey: 'repo-usage-average',
    sessionId: 'usage-average-session',
  });

  assert.equal(usage.totals.runs, 2);
  assert.equal(usage.totals.started, 1);
  assert.equal(usage.totals.completedRuns, 1);
  assert.equal(usage.totals.estimatedInputTokens, 15);
  assert.equal(usage.totals.averageElapsedMs, usage.totals.elapsedMs);
  app.close();
});

test('distillCheckpoint rejects malformed provider output and preserves raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'bad_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      bad_provider: async () => ({
        summaryShort: 'Missing required arrays.',
        summaryText: 'Malformed output should be rejected.',
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-b',
    sessionId: 'bad-session',
    role: 'user',
    content: 'Keep this raw event even when validation fails.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-b',
        sessionId: 'bad-session',
      }),
    /decisions.*array/,
  );

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 1);
  assert.equal(info.tables.checkpoints, 0);
  assert.equal(info.tables.distillRuns, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-b',
    sessionId: 'bad-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].outputMetadata.validationFailed, true);
});

test('distill output validation includes received types', () => {
  assert.throws(() => validateDistillOutput(null), /received null/);
  assert.throws(
    () =>
      validateDistillOutput({
        summaryShort: 'Invalid checkpoint.',
        summaryText: 'Array fields are not valid here.',
        decisions: 'not-array',
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
      }),
    /decisions.*received string/,
  );
  const legacy = validateDistillOutput({
    summaryShort: 'Legacy checkpoint.',
    summaryText: 'Legacy output has no structured payload.',
    decisions: [],
    todos: [],
    openQuestions: [],
    memoryCandidates: [],
  });
  assert.equal(legacy.structured, null);
  const structured = validateDistillOutput({
    summaryShort: 'Structured checkpoint.',
    summaryText: 'Structured output has handoff state.',
    decisions: [],
    todos: [],
    openQuestions: [],
    memoryCandidates: [],
    structured: {
      schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
      work: {
        status: 'verified',
      },
    },
  });
  assert.equal(structured.structured.schemaVersion, STRUCTURED_CHECKPOINT_SCHEMA_VERSION);
  assert.throws(
    () =>
      validateDistillOutput({
        summaryShort: 'Invalid structured checkpoint.',
        summaryText: 'Structured output has the wrong schema version.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        structured: {
          schemaVersion: 'contextforge.structured_checkpoint.v999',
        },
      }),
    /structured\.schemaVersion/,
  );
});

test('provider timeout mismatch fails before execution and records non-retryable run state', async () => {
  const dataDir = await makeTempDir();
  let invocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'codex_exec',
      CONTEXTFORGE_CODEX_EXEC_TIMEOUT_MS: '1000',
    },
    cwd: process.cwd(),
    codexExecRunner: async () => {
      invocations += 1;
      throw new Error('runner must not execute');
    },
  });
  const options = { scope: 'repo', scopeKey: 'timeout-repo', sessionId: 'timeout-session' };
  app.appendRaw({ ...options, role: 'assistant', content: 'Timeout mismatch evidence.' });

  await assert.rejects(
    () => app.distillCheckpoint({ ...options, _clientTimeoutMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'CONTEXTFORGE_PROVIDER_TIMEOUT_EXCEEDS_CLIENT_TIMEOUT');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(invocations, 0);
  const [run] = app.listDistillRuns(options);
  assert.equal(run.status, 'failed');
  assert.equal(run.outputMetadata.providerFailed, true);
  assert.equal(run.outputMetadata.retryable, false);
});

test('distillCheckpoint records retryable provider timeout failures without deleting raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'timeout_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      timeout_provider: async () => {
        throw new ProviderTimeoutError('timeout_provider', 25);
      },
    },
  });
  const options = { scope: 'repo', scopeKey: 'timeout-run-repo', sessionId: 'timeout-run-session' };
  app.appendRaw({ ...options, role: 'assistant', content: 'Retryable timeout evidence.' });

  await assert.rejects(() => app.distillCheckpoint(options), /timed out after 25ms/);
  const [run] = app.listDistillRuns(options);
  assert.equal(run.status, 'failed');
  assert.equal(run.outputMetadata.retryable, true);
  assert.equal(app.listRawEvents(options).length, 1);
  assert.equal(app.listCheckpoints(options).length, 0);
});

test('distillCheckpoint records provider failures without deleting raw evidence', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'failing_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      failing_provider: async () => {
        throw new Error('synthetic provider failure');
      },
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-c',
    sessionId: 'failing-session',
    role: 'assistant',
    content: 'Raw evidence should survive provider exceptions.',
  });

  await assert.rejects(
    () =>
      app.distillCheckpoint({
        scope: 'repo',
        scopeKey: 'repo-c',
        sessionId: 'failing-session',
      }),
    /synthetic provider failure/,
  );

  const info = app.dbInfo();
  assert.equal(info.tables.rawEvents, 1);
  assert.equal(info.tables.checkpoints, 0);
  assert.equal(info.tables.distillRuns, 1);

  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'repo-c',
    sessionId: 'failing-session',
  });
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].errorMessage, 'synthetic provider failure');
  assert.equal(runs[0].outputMetadata.providerFailed, true);
});

test('memory tags are normalized before FTS indexing', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const memory = app.remember({
    scope: 'repo',
    scopeKey: 'repo-tags',
    key: 'string-tags',
    content: 'String tags should not break memory indexing.',
    tags: 'not-an-array',
  });

  assert.deepEqual(memory.tags, []);
  const results = app.search({
    scope: 'repo',
    scopeKey: 'repo-tags',
    query: 'indexing',
  });
  assert.equal(results[0].memory.key, 'string-tags');
});

test('bootstrapContext returns semantic retrieval with trust and verification hints', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    key: 'issue-69-contract',
    content: 'Issues and PRs changed the bootstrap API contract for agents.',
    category: 'decision',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    key: 'indentation-style',
    content: 'Use four spaces for generated examples in this repo.',
    category: 'preference',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'agent-bootstrap-policy',
    content: 'Agents should verify PR and CI state before acting on retrieved context.',
    category: 'policy',
  });

  const result = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    query: 'issue 69 bootstrap contract previous work',
    includeShared: true,
    limit: 5,
  });

  assert.deepEqual(result.scope, { scopeType: 'repo', scopeKey: 'repo-bootstrap' });
  assert.equal(result.storage.mode, 'project-local');
  assert.equal(result.storage.authority, 'project-local');
  assert.match(result.summary, /Found/);
  assert.ok(result.results.some((item) => item.group === 'primary' && item.key === 'issue-69-contract'));
  assert.ok(result.results.some((item) => item.group === 'shared' && item.key === 'agent-bootstrap-policy'));
  const repoHit = result.results.find((item) => item.key === 'issue-69-contract');
  assert.equal(repoHit.trust, 'reviewed_durable');
  assert.equal(repoHit.verificationRequired, true);
  assert.ok(Array.isArray(repoHit.why));
  assert.equal(Object.hasOwn(repoHit, 'score'), false);
  assert.match(repoHit.whyUse, /Reviewed durable/);
  assert.ok(result.nextActions.some((item) => item.includes('Verify current git')));

  const stableResult = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap',
    query: 'indentation style examples',
    limit: 3,
    rawTailLimit: 0,
  });
  const stableHit = stableResult.results.find((item) => item.key === 'indentation-style');
  assert.equal(stableHit.verificationRequired, false);
  assert.equal(Object.hasOwn(stableResult, 'rawTailLimit'), false);
});

test('bootstrapContext reuses one query embedding across repo and shared retrieval', async () => {
  const dataDir = await makeTempDir();
  let embedCalls = 0;
  const provider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      embedCalls += 1;
      return texts.map(() => [1, 0, 0]);
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: provider,
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'repo-bootstrap-embed',
    key: 'repo-bootstrap-memory',
    content: 'Repo bootstrap retrieval should reuse embeddings.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'global',
    key: 'shared-bootstrap-memory',
    content: 'Shared bootstrap retrieval should reuse embeddings.',
  });

  const result = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'repo-bootstrap-embed',
    query: 'bootstrap retrieval',
    includeShared: true,
  });

  assert.equal(embedCalls, 1);
  assert.equal(result.sharedLimit, 3);
  assert.ok(result.results.some((item) => item.group === 'primary'));
  assert.ok(result.results.some((item) => item.group === 'shared'));
});

test('syncResumeContext returns handoff context without promotion proposals', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'resume_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      resume_provider: async () => ({
        summaryShort: 'Resume handoff for usage observability.',
        summaryText:
          'Usage observability work left unfinished migration checks and PR verification for the next agent.',
        decisions: ['Use checkpoint handoff for prior intent.'],
        todos: ['Verify CI before acting.'],
        openQuestions: [],
        structured: {
          schemaVersion: STRUCTURED_CHECKPOINT_SCHEMA_VERSION,
          work: {
            intent: 'Resume usage observability verification.',
            status: 'in_progress',
            outcome: 'Next agent should verify CI live.',
          },
          liveState: {
            prNumber: 321,
            ciStatus: 'unknown',
            observedAt: '2026-06-03T00:00:00Z',
            verificationRequired: true,
            staleReasons: ['PR and CI state can change after checkpoint creation'],
            verifyHints: ['gh pr view 321 --json statusCheckRollup'],
          },
          changes: [],
          verification: [],
          risks: [],
          nextActions: [
            {
              action: 'Verify CI before acting.',
              priority: 'high',
              requiresLiveVerification: true,
            },
          ],
        },
        sessionWorkingContext: {
          currentTask: 'Continue usage observability closeout verification.',
          currentUserIntent: 'Resume unfinished PR verification without proposing memory promotions.',
          targetSubject: 'usage observability',
          openQuestion: 'Has CI passed on the latest PR commit?',
          nonGoals: ['memory promotion review during resume'],
          avoidMisreadings: ['checkpoint is weak memory'],
          confidence: 0.82,
        },
        memoryCandidates: [
          {
            key: 'resume-candidate-runbook',
            content: 'Review usage observability closeout candidates only at closeout.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });

  app.remember({
    scope: 'repo',
    scopeKey: 'resume-repo',
    key: 'resume-durable-rule',
    content: 'Usage observability resume must verify CI live.',
    category: 'runbook',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
    role: 'assistant',
    content: 'Usage observability checkpoint should preserve unfinished work.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
  });

  const result = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'resume-repo',
    sessionId: 'resume-session',
    query: 'usage observability resume unfinished work closeout candidates',
  });

  assert.equal(result.kind, 'resume_context');
  assert.equal(result.handoff.latestHandoff.structured.work.status, 'in_progress');
  assert.equal(result.handoff.latestHandoff.structuredWarnings[0].code, 'live_state_may_be_stale');
  assert.equal(result.handoff.structuredWorkingContext.type, 'session_working_context');
  assert.equal(result.handoff.structuredWorkingContext.trust, 'mutable_session_state');
  assert.match(result.handoff.structuredWorkingContext.currentTask, /usage observability/);
  assert.deepEqual(result.handoff.structuredWorkingContext.nonGoals, ['memory promotion review during resume']);
  assert.equal(result.handoff.recentCheckpoints[0].trust, 'credible_recent_handoff');
  assert.match(result.handoff.recentCheckpoints[0].useHint, /Use actively/);
  assert.equal(result.handoff.memoryCandidates.count, 1);
  assert.equal(result.handoff.memoryCandidates.items[0].trust, 'review_material');
  assert.equal(Object.hasOwn(result, 'proposals'), false);
  assert.ok(result.nextActions.includes('Do not propose memory promotions during resume sync.'));
});

test('syncResumeContext handles empty bootstrap results without proposals', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const result = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'empty-resume-repo',
    query: 'no matching resume context',
  });

  assert.equal(result.kind, 'resume_context');
  assert.deepEqual(result.handoff.durableMemories, []);
  assert.deepEqual(result.handoff.recentCheckpoints, []);
  assert.equal(result.handoff.memoryCandidates.count, 0);
  assert.equal(Object.hasOwn(result, 'proposals'), false);
});

test('suggestMemoryPromotions avoids scope fallback unless explicitly allowed', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'suggest_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      suggest_provider: async () => ({
        summaryShort: 'Promotion suggestion checkpoint.',
        summaryText: 'Closeout produced a stable runbook candidate.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'closeout-runbook',
            content: 'Closeout should verify branch parity before follow-up work starts.',
            reason: 'Branch parity verification is a reusable closeout runbook.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.91,
            stability: 0.92,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    sessionId: 'suggest-session',
    role: 'assistant',
    content: 'Closeout candidate: branch parity runbook.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    sessionId: 'suggest-session',
  });

  const noFallback = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    trigger: 'manual_closeout',
  });
  assert.deepEqual(noFallback.proposals, []);
  assert.equal(noFallback.source.mode, 'none');
  assert.ok(noFallback.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));
  assert.ok(
    noFallback.nextActions.some((action) =>
      action.includes('No current-session closeout candidates were reviewed'),
    ),
  );

  await assert.rejects(
    () =>
      app.suggestMemoryPromotions({
        scope: 'repo',
        scopeKey: 'suggest-repo',
        trigger: 'agent_merged_pr',
        allowScopeFallback: true,
      }),
    /allowScopeFallback/,
  );

  const fallback = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'suggest-repo',
    trigger: 'manual_closeout',
    allowScopeFallback: true,
  });
  assert.equal(fallback.source.mode, 'scope_fallback');
  assert.equal(fallback.proposals.length, 1);
  assert.equal(fallback.proposals[0].key, 'closeout-runbook');
});

test('suggestMemoryPromotions honors scanLimit and reports capped proposal limits', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'scan_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: null,
    distillProviders: {
      scan_provider: async () => ({
        summaryShort: 'Many candidates.',
        summaryText: 'Closeout produced many promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: Array.from({ length: 5 }, (_, index) => ({
          key: `scan-runbook-${index + 1}`,
          content: `Runbook candidate ${index + 1}.`,
          category: 'runbook',
          candidateType: 'runbook',
          confidence: 0.9,
          stability: 0.9,
          sensitivity: 'low',
          promotionRecommendation: 'promote',
        })),
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
    role: 'assistant',
    content: 'Many closeout candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
  });

  const result = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'scan-repo',
    sessionId: 'scan-session',
    trigger: 'manual_closeout',
    scanLimit: 2,
    limit: 5,
  });

  assert.equal(result.proposals.length, 2);
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'limit_capped'));
});

test('suggestMemoryPromotions uses only latest checkpoint for a session and skips risky candidates', async () => {
  const dataDir = await makeTempDir();
  let callCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'latest_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      latest_provider: async () => {
        callCount += 1;
        return {
          summaryShort: `Checkpoint ${callCount}.`,
          summaryText: `Checkpoint ${callCount} contains candidates.`,
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates:
            callCount === 1
              ? [
                  {
                    key: 'old-runbook',
                    content: 'Old checkpoint candidate should not be suggested from latest session closeout.',
                    category: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'low',
                    promotionRecommendation: 'promote',
                  },
                ]
              : [
                  {
                    key: 'latest-runbook',
                    content: 'Latest checkpoint candidate should be suggested.',
                    category: 'runbook',
                    candidateType: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'low',
                    promotionRecommendation: 'promote',
                  },
                  {
                    key: 'latest-secret',
                    content: 'Risky candidate should not be suggested.',
                    category: 'runbook',
                    candidateType: 'runbook',
                    confidence: 0.95,
                    stability: 0.95,
                    sensitivity: 'high',
                    promotionRecommendation: 'promote',
                  },
                ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    role: 'assistant',
    content: 'First checkpoint raw.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    role: 'assistant',
    content: 'Second checkpoint raw.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
  });

  const result = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'latest-repo',
    sessionId: 'latest-session',
    trigger: 'user_declared_work_done',
  });

  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key),
    ['latest-runbook'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('high_sensitivity')));
});

test('autoPromoteMemoryCandidates requires closeout scope and defaults to dry-run', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      auto_provider: async () => ({
        summaryShort: 'Auto promote checkpoint.',
        summaryText: 'Closeout produced strict automatic promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'auto-runbook',
            content: 'Closeout automation can promote strict runbook candidates.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
    role: 'assistant',
    content: 'Strict auto promotion candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
  });

  const noSource = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    trigger: 'manual_closeout',
  });
  assert.equal(noSource.kind, 'auto_memory_promotion_result');
  assert.deepEqual(noSource.wouldPromote, []);
  assert.equal(noSource.source.mode, 'none');
  assert.ok(noSource.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));
  assert.ok(
    noSource.nextActions.some((action) =>
      action.includes('No current-session closeout candidates were reviewed'),
    ),
  );

  const dryRun = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    sessionId: 'auto-session',
    trigger: 'user_declared_work_done',
    limit: 5,
  });
  assert.equal(dryRun.kind, 'auto_memory_promotion_result');
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.wouldPromote.length, 1);
  assert.deepEqual(dryRun.promoted, []);
  assert.equal(dryRun.wouldPromote[0].key, 'auto-runbook');
  assert.ok(dryRun.requestWarnings.some((warning) => warning.code === 'limit_capped'));
  assert.equal(app.listMemoryCandidates({ scope: 'repo', scopeKey: 'auto-repo', status: 'promoted' }).length, 0);

  const checkpointOnly = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(checkpointOnly.source.mode, 'checkpoint');
  assert.equal(checkpointOnly.wouldPromote.length, 1);

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        minConfidence: 1.5,
      }),
    /minConfidence/,
  );

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        minStability: -1,
      }),
    /minStability/,
  );

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'auto-repo',
        sessionId: 'auto-session',
        trigger: 'manual_closeout',
        dryRun: false,
      }),
    /CONTEXTFORGE_AUTO_PROMOTE_ENABLED/,
  );
});

test('auditMemoryCandidates persists audit metadata without promoting durable memory', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_suggestions_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate, warnings, checkpoint }) => {
      auditInvocations.push({ candidate, warnings, checkpoint });
      return {
        approved: true,
        decision: 'approve',
        reason: 'Candidate is stable enough to offer as a closeout recommendation.',
        riskCodes: [],
        metadata: {
          provider: 'codex_exec',
          model: 'gpt-5.5',
          reasoningEffort: 'low',
          usage: {
            prompt_tokens: 100,
            completion_tokens: 25,
            total_tokens: 125,
            prompt_tokens_details: {
              cached_tokens: 40,
            },
            completion_tokens_details: {
              reasoning_tokens: 7,
            },
          },
        },
      };
    },
    distillProviders: {
      audit_suggestions_provider: async () => ({
        summaryShort: 'Audit suggestions checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited without mutation.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audited-readonly-runbook',
            content: 'Agents should audit closeout memory candidates before suggesting promotion.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
    role: 'assistant',
    content: 'Read-only audited candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
  });

  const noSource = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    trigger: 'manual_closeout',
  });
  assert.equal(noSource.kind, 'memory_candidate_audit_suggestions');
  assert.deepEqual(noSource.proposals, []);
  assert.equal(noSource.source.mode, 'none');
  assert.equal(noSource.policy.mutatesDurableMemory, false);
  assert.equal(noSource.policy.persistsAuditMetadata, false);
  assert.ok(noSource.requestWarnings.some((warning) => warning.code === 'missing_closeout_source'));

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    checkpointId: checkpoint.id,
    trigger: 'user_declared_work_done',
    limit: 50,
  });

  assert.equal(result.kind, 'memory_candidate_audit_suggestions');
  assert.equal(result.policy.mutatesDurableMemory, false);
  assert.equal(result.policy.persistsAuditMetadata, true);
  assert.equal(result.policy.audit.executed, true);
  assert.equal(result.policy.audit.provider, 'none');
  assert.equal(result.source.mode, 'checkpoint');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].key, 'audited-readonly-runbook');
  assert.equal(result.proposals[0].recommendedAction, 'promote');
  assert.equal(result.proposals[0].audit.metadata.model, 'gpt-5.5');
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'limit_capped'));
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].checkpoint.id, checkpoint.id);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-suggestions-repo', key: 'audited-readonly-runbook' }), null);
  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-suggestions-repo',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 1);
  assert.equal(pendingCandidates[0].candidate.key, 'audited-readonly-runbook');
  assert.ok(pendingCandidates[0].reviewedAt);
  assert.equal(
    pendingCandidates[0].reviewReason,
    'Candidate is stable enough to offer as a closeout recommendation.',
  );
  assert.equal(pendingCandidates[0].reviewMetadata.audit.decision, 'approve');
  assert.equal(pendingCandidates[0].reviewMetadata.auditMetadata.mutatesDurableMemory, false);
  assert.equal(pendingCandidates[0].reviewMetadata.auditMetadata.persistsAuditMetadata, true);

  const store = new ContextForgeStore({ dataDir });
  const events = store.listLlmUsageEvents({
    scopeType: 'repo',
    scopeKey: 'audit-suggestions-repo',
    sessionId: 'audit-suggestions-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'candidate_audit');
  assert.equal(events[0].provider, 'codex_exec');
  assert.equal(events[0].model, 'gpt-5.5');
  assert.equal(events[0].checkpointId, checkpoint.id);
  assert.equal(events[0].candidateId, pendingCandidates[0].id);
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].cachedInputTokens, 40);
  assert.equal(events[0].uncachedInputTokens, 60);
  assert.equal(events[0].outputTokens, 25);
  assert.equal(events[0].reasoningTokens, 7);
  assert.equal(events[0].totalTokens, 125);
  store.close();
});

test('concurrent duplicate candidate audits share one provider call and metadata write', async () => {
  const dataDir = await makeTempDir();
  let releaseAudit;
  let auditInvocations = 0;
  const auditor = async () => {
    auditInvocations += 1;
    await new Promise((resolve) => {
      releaseAudit = resolve;
    });
    return {
      approved: true,
      decision: 'approve',
      reason: 'Synthetic concurrent audit approved the candidate.',
      riskCodes: [],
      metadata: {
        provider: 'synthetic_auditor',
        model: 'synthetic-model',
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    };
  };
  auditor.metadata = { provider: 'synthetic_auditor', model: 'synthetic-model', timeoutMs: 1000 };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'concurrent_audit_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      concurrent_audit_provider: async () => ({
        summaryShort: 'Concurrent audit checkpoint.',
        summaryText: 'One candidate is available for concurrent audit retries.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'concurrent-audit-runbook',
            content: 'Concurrent candidate audit retries share one provider execution.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'concurrent-audit-repo', sessionId: 'concurrent-audit-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Concurrent audit raw evidence.' });
  const checkpoint = await app.distillCheckpoint(source);
  const options = {
    ...source,
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  };

  const first = app.auditMemoryCandidates(options);
  const retry = app.auditMemoryCandidates(options);
  await waitForCondition(() => typeof releaseAudit === 'function', 'candidate audit did not start');
  assert.equal(auditInvocations, 1);
  releaseAudit();
  const [firstResult, retryResult] = await Promise.all([first, retry]);

  assert.equal(auditInvocations, 1);
  assert.deepEqual(firstResult.proposals, retryResult.proposals);
  assert.equal(firstResult.proposals.length, 1);
  assert.equal(app.listLlmUsageEvents({ ...source, operation: 'candidate_audit' }).length, 1);
  const [candidate] = app.listMemoryCandidates({ ...source, checkpointId: checkpoint.id, status: 'pending' });
  assert.equal(candidate.reviewMetadata.audit.decision, 'approve');
});

test('retryable candidate audit failures can be safely retried without force', async () => {
  const dataDir = await makeTempDir();
  let auditInvocations = 0;
  const auditor = async () => {
    auditInvocations += 1;
    if (auditInvocations === 1) {
      const error = new ProviderTimeoutError('retryable_auditor', 25);
      error.metadata = {
        provider: 'retryable_auditor',
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      };
      throw error;
    }
    return {
      approved: true,
      decision: 'approve',
      reason: 'Retry succeeded without a duplicate concurrent write.',
      riskCodes: [],
      metadata: {
        provider: 'retryable_auditor',
        usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
      },
    };
  };
  auditor.metadata = { provider: 'retryable_auditor', timeoutMs: 1000 };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'retryable_audit_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: auditor,
    distillProviders: {
      retryable_audit_provider: async () => ({
        summaryShort: 'Retryable audit checkpoint.',
        summaryText: 'The candidate audit may be retried after a transient timeout.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'retryable-audit-runbook',
            content: 'Retry transient audit failures without force.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  const source = { scope: 'repo', scopeKey: 'retryable-audit-repo', sessionId: 'retryable-audit-session' };
  app.appendRaw({ ...source, role: 'assistant', content: 'Retryable audit raw evidence.' });
  const checkpoint = await app.distillCheckpoint(source);
  const options = { ...source, checkpointId: checkpoint.id, trigger: 'manual_closeout' };

  const failed = await app.auditMemoryCandidates(options);
  assert.equal(failed.proposals[0].audit.retryable, true);
  const retried = await app.auditMemoryCandidates(options);
  assert.equal(retried.proposals[0].audit.decision, 'approve');
  assert.equal(retried.proposals[0].audit.retryable, undefined);
  assert.equal(auditInvocations, 2);
  assert.equal(app.listLlmUsageEvents({ ...source, operation: 'candidate_audit' }).length, 2);
  const [candidate] = app.listMemoryCandidates({ ...source, checkpointId: checkpoint.id, status: 'pending' });
  assert.equal(candidate.reviewMetadata.audit.decision, 'approve');
});

test('auditMemoryCandidates records failed audit usage when error metadata includes usage', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_failure_usage_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      const error = new Error('Synthetic audit transport failure.');
      error.metadata = {
        provider: 'codex_sdk_python',
        model: 'gpt-5.5',
        usage: {
          input_tokens: 30,
          output_tokens: 4,
          total_tokens: 34,
          input_tokens_details: {
            cached_tokens: 12,
          },
        },
      };
      throw error;
    },
    distillProviders: {
      audit_failure_usage_provider: async () => ({
        summaryShort: 'Audit failure usage checkpoint.',
        summaryText: 'Closeout produced a candidate whose audit fails after usage is known.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-failure-usage-runbook',
            content: 'Failed audit calls should preserve token usage when providers expose it.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
    role: 'assistant',
    content: 'Failed audit usage should be preserved.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
  });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].recommendedAction, 'review');

  const events = app.listLlmUsageEvents({
    scope: 'repo',
    scopeKey: 'audit-failure-usage-repo',
    sessionId: 'audit-failure-usage-session',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'candidate_audit');
  assert.equal(events[0].status, 'failed');
  assert.equal(events[0].provider, 'codex_sdk_python');
  assert.equal(events[0].inputTokens, 30);
  assert.equal(events[0].cachedInputTokens, 12);
  assert.equal(events[0].uncachedInputTokens, 18);
  assert.equal(events[0].totalTokens, 34);
});

test('auditMemoryCandidates audits review candidates and skips noisy events before runner', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_review_selection_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '99',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Reviewed ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      audit_review_selection_provider: async () => ({
        summaryShort: 'Audit review selection checkpoint.',
        summaryText: 'Closeout produced review and noisy candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'review-worthy-policy',
            content: 'Agents must verify mutable live state before using structured checkpoint liveState values.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.82,
            stability: 0.82,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-api-contract',
            content: 'GET /healthz must return 200 for the server health contract.',
            category: 'api_contract',
            candidateType: 'api_contract',
            confidence: 0.83,
            stability: 0.83,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-ci-policy',
            content: 'CI must run lint and tests on every PR before merge.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.84,
            stability: 0.84,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-worthy-draft-policy',
            content: 'Open work as a draft PR until checks are ready for review.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.81,
            stability: 0.81,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'pr-status-noise',
            content: 'PR #126 passed npm test 142/142 and CI was green.',
            category: 'project_status',
            candidateType: 'fact',
            confidence: 0.98,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'local-runtime-noise',
            content: 'Restart `/home/ubuntu/contextforge` with systemctl on this host.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.97,
            stability: 0.91,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    sessionId: 'audit-review-selection-session',
    role: 'assistant',
    content: 'Review candidates should be filtered before audit.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    sessionId: 'audit-review-selection-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-review-selection-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    limit: 5,
  });

  assert.deepEqual(auditInvocations.sort(), [
    'review-worthy-api-contract',
    'review-worthy-ci-policy',
    'review-worthy-draft-policy',
    'review-worthy-policy',
  ]);
  assert.equal(result.policy.audit.executed, true);
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key).sort(),
    [
      'review-worthy-api-contract',
      'review-worthy-ci-policy',
      'review-worthy-draft-policy',
      'review-worthy-policy',
    ],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_transient_category')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_one_off_event')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_environment_specific')));
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'audit-review-selection-repo', key: 'review-worthy-policy' }),
    null,
  );
});

test('auditMemoryCandidates honors narrowed allowedCategories', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_allowed_categories_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Reviewed ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      audit_allowed_categories_provider: async () => ({
        summaryShort: 'Audit allowed categories checkpoint.',
        summaryText: 'Closeout produced candidates in different durable categories.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'allowed-runbook',
            content: 'Use scoped bootstrap before editing ContextForge runtime code.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'blocked-policy',
            content: 'Agents must verify mutable live state before using checkpoint liveState.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    sessionId: 'audit-allowed-categories-session',
    role: 'assistant',
    content: 'Allowed categories should narrow audit candidate selection.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    sessionId: 'audit-allowed-categories-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-allowed-categories-repo',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    allowedCategories: ['runbook'],
    limit: 5,
  });

  assert.deepEqual(auditInvocations, ['allowed-runbook']);
  assert.deepEqual(result.policy.allowedCategories, ['runbook']);
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.key),
    ['allowed-runbook'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('audit_disallowed_category')));
});

test('distillCheckpoint automatically audits session candidate batches', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'batch_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.id);
      return {
        approved: true,
        decision: 'approve',
        reason: `Audited ${candidate.candidate.key} in a batch.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
          reasoningEffort: 'low',
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            total_tokens: 25,
          },
        },
      };
    },
    distillProviders: {
      batch_audit_provider: async () => ({
        summaryShort: 'Batch audit checkpoint.',
        summaryText: 'The checkpoint produced enough candidates for automatic batched audit.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'batch-audit-runbook',
            content: 'Run automatic candidate audits in batches.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'batch-audit-contract',
            content: 'Automatic promotion writes require audit approval.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    role: 'assistant',
    content: 'Create enough candidates for batch audit.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
  });

  assert.equal(checkpoint.candidateAudit.executed, true);
  assert.equal(checkpoint.candidateAudit.reason, 'batch_threshold');
  assert.equal(checkpoint.candidateAudit.audited, 2);
  assert.equal(checkpoint.candidateAudit.promoted, 0);
  assert.equal(auditInvocations.length, 2);
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    status: 'pending',
  });
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.reviewMetadata.audit?.metadata?.model === 'gpt-5.5'));
  assert.ok(candidates.every((candidate) => candidate.reviewMetadata.auditMetadata?.sourceMode === 'checkpoint'));
  const attempts = app.listMemoryCandidateAuditAttempts({ scope: 'repo', scopeKey: 'batch-audit-repo', candidateId: candidates[0].id });
  assert.ok(attempts.every((attempt) => attempt.sourceMode === 'checkpoint'));
  const usageEvents = app.listLlmUsageEvents({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    operation: 'candidate_audit',
    order: 'asc',
  });
  assert.equal(usageEvents.length, 2);
  assert.ok(usageEvents.every((event) => event.distillRunId === checkpoint.distillRunId));
  assert.deepEqual(
    usageEvents.map((event) => event.candidateId).sort(),
    candidates.map((candidate) => candidate.id).sort(),
  );
  assert.deepEqual(
    usageEvents.map((event) => event.totalTokens),
    [25, 25],
  );

  const storedAudit = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'batch-audit-repo',
    sessionId: 'batch-audit-session',
    trigger: 'manual_closeout',
    limit: 2,
  });
  assert.equal(storedAudit.proposals.length, 2);
  assert.equal(storedAudit.proposals[0].audit.metadata.model, 'gpt-5.5');
  assert.equal(auditInvocations.length, 2);
});

test('distillCheckpoint automatically audits review-worthy non-promote candidate batches', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'review_batch_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: false,
        decision: 'needs_review',
        reason: `Audited review candidate ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      review_batch_audit_provider: async () => ({
        summaryShort: 'Review batch audit checkpoint.',
        summaryText: 'The checkpoint produced review-worthy candidates for batched audit.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'review-batch-policy',
            content: 'Agents must verify mutable live state before relying on checkpoint liveState values.',
            category: 'policy',
            candidateType: 'policy',
            confidence: 0.82,
            stability: 0.82,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
          {
            key: 'review-batch-architecture',
            content: 'Structured checkpoint handoff should be exposed separately from ordinary search results.',
            category: 'architecture',
            candidateType: 'decision',
            confidence: 0.81,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'review-batch-audit-repo',
    sessionId: 'review-batch-audit-session',
    role: 'assistant',
    content: 'Create enough review candidates for batch audit.',
  });

  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'review-batch-audit-repo',
    sessionId: 'review-batch-audit-session',
  });

  assert.equal(checkpoint.candidateAudit.executed, true);
  assert.equal(checkpoint.candidateAudit.reason, 'batch_threshold');
  assert.equal(checkpoint.candidateAudit.audited, 2);
  assert.deepEqual(auditInvocations.sort(), ['review-batch-architecture', 'review-batch-policy']);
});

test('distillCheckpoint audits new candidates even when audited pending candidates fill the first window', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  let distillCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'batch_window_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '2',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_BATCH_LIMIT: '2',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async ({ candidate }) => {
      auditInvocations.push(candidate.candidate.key);
      return {
        approved: true,
        decision: 'approve',
        reason: `Audited ${candidate.candidate.key}.`,
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      batch_window_provider: async () => {
        distillCount += 1;
        return {
          summaryShort: `Batch audit checkpoint ${distillCount}.`,
          summaryText: 'The checkpoint produced enough candidates for automatic batched audit.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [
            {
              key: `batch-window-${distillCount}-a`,
              content: `Batch audit candidate A ${distillCount}.`,
              category: 'runbook',
              candidateType: 'runbook',
              confidence: 0.96,
              stability: 0.96,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
            {
              key: `batch-window-${distillCount}-b`,
              content: `Batch audit candidate B ${distillCount}.`,
              category: 'api-contract',
              candidateType: 'api-contract',
              confidence: 0.95,
              stability: 0.95,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
          ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
    role: 'assistant',
    content: 'First audit batch.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
  });
  assert.equal(first.candidateAudit.audited, 2);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
    role: 'assistant',
    content: 'Second audit batch should not be blocked by the first audited pending batch.',
  });
  const second = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'batch-window-repo',
    sessionId: 'batch-window-session',
  });

  assert.equal(second.candidateAudit.executed, true);
  assert.equal(second.candidateAudit.audited, 2);
  assert.deepEqual(auditInvocations, [
    'batch-window-1-a',
    'batch-window-1-b',
    'batch-window-2-a',
    'batch-window-2-b',
  ]);
});

test('distillCheckpoint waits below audit threshold but closeout trigger forces audit', async () => {
  const dataDir = await makeTempDir();
  let auditCount = 0;
  let distillCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'closeout_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_MIN_BATCH_CANDIDATES: '5',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditCount += 1;
      return {
        approved: false,
        decision: 'needs_review',
        reason: 'Closeout audit should run even below the batch threshold.',
        riskCodes: [],
        metadata: {
          provider: 'codex_sdk_python',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      closeout_audit_provider: async () => {
        distillCount += 1;
        return {
          summaryShort: 'Closeout audit checkpoint.',
          summaryText: 'The checkpoint produced one candidate.',
          decisions: [],
          todos: [],
          openQuestions: [],
          memoryCandidates: [
            {
              key: `closeout-audit-${distillCount}`,
              content: `Closeout audits force candidate review ${distillCount}.`,
              category: 'runbook',
              candidateType: 'runbook',
              confidence: 0.96,
              stability: 0.96,
              sensitivity: 'low',
              promotionRecommendation: 'promote',
            },
          ],
        };
      },
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    role: 'assistant',
    content: 'First candidate should wait below threshold.',
  });
  const first = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
  });
  assert.equal(first.candidateAudit.executed, false);
  assert.equal(first.candidateAudit.reason, 'below_batch_threshold');
  assert.equal(auditCount, 0);

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    role: 'assistant',
    content: 'Closeout should force audit.',
  });
  const second = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'closeout-audit-repo',
    sessionId: 'closeout-audit-session',
    auditTrigger: 'manual_closeout',
  });
  assert.equal(second.candidateAudit.executed, true);
  assert.equal(second.candidateAudit.reason, 'closeout_trigger');
  assert.equal(second.candidateAudit.audited, 2);
  assert.equal(auditCount, 2);
});

test('auditMemoryCandidates keeps recommendations conservative when audit is disabled', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_disabled_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_ENABLED: 'false',
    },
    cwd: process.cwd(),
    distillProviders: {
      audit_disabled_provider: async () => ({
        summaryShort: 'Audit disabled checkpoint.',
        summaryText: 'Closeout produced a candidate while the audit provider is disabled.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-disabled-runbook',
            content: 'Read-only audit suggestions should not recommend promotion when audit is disabled.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    role: 'assistant',
    content: 'Audit disabled read-only candidate.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    auditTrigger: 'manual_closeout',
  });
  assert.equal(checkpoint.candidateAudit.executed, false);
  assert.equal(checkpoint.candidateAudit.reason, 'audit_disabled');

  const pendingBeforeAudit = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    status: 'pending',
  });
  assert.equal(pendingBeforeAudit.length, 1);
  assert.equal(pendingBeforeAudit[0].reviewMetadata.audit, undefined);

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    trigger: 'manual_closeout',
  });

  assert.equal(result.policy.audit.enabled, false);
  assert.equal(result.policy.audit.executed, false);
  assert.equal(result.proposals.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'audit_disabled');
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'audit_disabled'));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-disabled-repo', key: 'audit-disabled-runbook' }), null);
  const pendingAfterAudit = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-disabled-repo',
    sessionId: 'audit-disabled-session',
    status: 'pending',
  });
  assert.equal(pendingAfterAudit[0].reviewMetadata.audit, undefined);
});

test('autoPromoteMemoryCandidates returns stable empty arrays and preference input warnings', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_empty_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      auto_empty_provider: async () => ({
        summaryShort: 'No candidates.',
        summaryText: 'Closeout produced no memory candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
    role: 'assistant',
    content: 'No candidates here.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-empty-repo',
    sessionId: 'auto-empty-session',
    trigger: 'manual_closeout',
    allowedCategories: ['preference'],
  });
  assert.equal(result.kind, 'auto_memory_promotion_result');

  assert.deepEqual(result.wouldPromote, []);
  assert.deepEqual(result.promoted, []);
  assert.deepEqual(result.policy.allowedCategories, []);
  assert.ok(result.requestWarnings.some((warning) => warning.code === 'preference_input_stripped'));
});

test('autoPromoteMemoryCandidates promotes only strict safe candidates when enabled', async () => {
  const dataDir = await makeTempDir();
  const embeddingProvider = {
    name: 'test-vector',
    model: 'test-embedding',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => (String(text).includes('safe-api-contract') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_enabled_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'openai',
      CONTEXTFORGE_EMBEDDINGS_DIMENSIONS: '3',
    },
    cwd: process.cwd(),
    embeddingProviders: {
      openai: embeddingProvider,
    },
    autoPromoteAuditor: async () => ({
      approved: true,
      decision: 'approve',
      reason: 'Test auditor approved strict safe candidate.',
      riskCodes: [],
      metadata: {
        provider: 'codex_exec',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
      },
    }),
    distillProviders: {
      auto_enabled_provider: async () => ({
        summaryShort: 'Auto enabled checkpoint.',
        summaryText: 'Closeout produced mixed automatic promotion candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'safe-api-contract',
            content: 'The API contract requires idempotent delete retries.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'safe-runbook',
            content: 'The runbook requires processing embeddings after promoted memory writes.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.94,
            stability: 0.93,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'user-pref',
            content: 'The user prefers a particular closing phrase.',
            category: 'preference',
            candidateType: 'preference',
            confidence: 0.99,
            stability: 0.99,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'low-confidence-runbook',
            content: 'This runbook is not stable enough.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.7,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
    role: 'assistant',
    content: 'Mixed auto promotion candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
  });
  const processedDistillEmbeddings = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
  });
  assert.deepEqual(processedDistillEmbeddings.bySourceType, {
    checkpoint: 1,
    memory_candidate: 4,
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    sessionId: 'auto-enabled-session',
    trigger: 'agent_merged_pr',
    dryRun: false,
  });

  assert.equal(result.kind, 'auto_memory_promotion_result');
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.wouldPromote, []);
  assert.deepEqual(
    result.promoted.map((item) => item.key),
    ['safe-api-contract', 'safe-runbook'],
  );
  assert.ok(result.promoted[0].evidence);
  assert.equal(result.promoted[0].promotionResult.status, 'promoted');
  const pendingEmbeddingJobs = await app.listEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    status: 'pending',
  });
  assert.deepEqual(
    pendingEmbeddingJobs.map((job) => job.sourceType),
    ['memory', 'memory'],
  );
  assert.ok(result.skipped.some((item) => item.reason.includes('preference_auto_excluded')));
  assert.ok(result.skipped.some((item) => item.reason.includes('auto_low_confidence')));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-enabled-repo', key: 'safe-api-contract' }).status, 'active');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-enabled-repo', key: 'user-pref' }), null);
  const promotedCandidates = app.listMemoryCandidates({ scope: 'repo', scopeKey: 'auto-enabled-repo', status: 'promoted' });
  assert.equal(promotedCandidates.length, 2);
  assert.ok(promotedCandidates.every((candidate) => candidate.reviewMetadata.autoPromoted === true));
  assert.ok(promotedCandidates.every((candidate) => candidate.reviewMetadata.autoPromotionAudit?.metadata?.model === 'gpt-5.5'));
  assert.deepEqual(
    promotedCandidates.map((candidate) => candidate.reviewMetadata.memoryId).sort(),
    result.promoted.map((item) => item.memoryId).sort(),
  );
  const promotedApiCandidate = promotedCandidates.find((candidate) => candidate.candidate.key === 'safe-api-contract');
  assert.ok(promotedApiCandidate, 'expected safe-api-contract promoted candidate');
  const autoEvents = app.listMemoryEvents({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    key: 'safe-api-contract',
  });
  assert.equal(autoEvents[0].metadata.sourceCandidateId, promotedApiCandidate.id);
  assert.equal(autoEvents[0].metadata.autoPromoted, true);
  const processedMemoryEmbedding = await app.processEmbeddingJobs({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
  });
  assert.deepEqual(processedMemoryEmbedding.bySourceType, {
    memory: 2,
  });
  const memoryResults = await app.search({
    scope: 'repo',
    scopeKey: 'auto-enabled-repo',
    query: 'safe-api-contract',
  });
  const safeApiMemoryResult = memoryResults.find(
    (entry) => entry.type === 'memory' && entry.memory.key === 'safe-api-contract',
  );
  assert.ok(safeApiMemoryResult, 'expected safe-api-contract memory result');
  assert.equal(safeApiMemoryResult.retrieval.vectorModel, 'test-embedding');
});

test('autoPromoteMemoryCandidates rejects one-off and environment-specific candidates before audit', async () => {
  const dataDir = await makeTempDir();
  let auditCount = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'auto_strict_durability_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditCount += 1;
      return {
        approved: true,
        decision: 'approve',
        reason: 'The test auditor would approve if local policy allowed it.',
        riskCodes: [],
        metadata: {
          provider: 'codex_exec',
          model: 'gpt-5.5',
        },
      };
    },
    distillProviders: {
      auto_strict_durability_provider: async () => ({
        summaryShort: 'Strict durability checkpoint.',
        summaryText: 'Closeout produced candidates with mixed durability.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'repo-common-api-contract',
            content: 'The API contract requires idempotent delete retries.',
            category: 'api-contract',
            candidateType: 'api-contract',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'pr-ci-snapshot',
            content: 'PR #126 passed npm test 142/142 and CI was green.',
            category: 'project_state',
            candidateType: 'fact',
            confidence: 0.98,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
          {
            key: 'local-service-restart',
            content: 'Restart `/home/ubuntu/contextforge` service with systemctl after this local deployment.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.97,
            stability: 0.91,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
    role: 'assistant',
    content: 'Mixed strict durability candidates.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'auto-strict-durability-repo',
    sessionId: 'auto-strict-durability-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(
    result.promoted.map((item) => item.key),
    ['repo-common-api-contract'],
  );
  assert.equal(auditCount, 1);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'auto-strict-durability-repo', key: 'pr-ci-snapshot' }), null);
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'auto-strict-durability-repo', key: 'local-service-restart' }),
    null,
  );
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_transient_category')));
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_one_off_event')));
  assert.ok(result.skipped.some((item) => item.candidateId && item.reason.includes('auto_environment_specific')));
});

test('autoPromoteMemoryCandidates skips candidates rejected by the audit runner', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_reject_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => ({
      approved: false,
      decision: 'needs_review',
      reason: 'Candidate is plausible but needs human review.',
      riskCodes: ['needs_human_review'],
      metadata: {
        provider: 'codex_exec',
        model: 'gpt-5.5',
        reasoningEffort: 'low',
      },
    }),
    distillProviders: {
      audit_reject_provider: async () => ({
        summaryShort: 'Audit rejected checkpoint.',
        summaryText: 'Closeout produced a candidate that local checks would otherwise promote.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-gated-runbook',
            content: 'The runbook requires audit approval before automatic durable promotion.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
    role: 'assistant',
    content: 'Audit-gated candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    sessionId: 'audit-reject-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(result.promoted, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'audit_needs_review: needs_human_review');
  assert.equal(result.skipped[0].audit.metadata.model, 'gpt-5.5');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-reject-repo', key: 'audit-gated-runbook' }), null);
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-reject-repo',
    status: 'pending',
  });
  assert.equal(candidates.length, 1);
});

test('autoPromoteMemoryCandidates keeps candidates pending when audit runner fails', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'audit_fail_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      throw new Error('audit runner unavailable');
    },
    distillProviders: {
      audit_fail_provider: async () => ({
        summaryShort: 'Audit failed checkpoint.',
        summaryText: 'Closeout produced a candidate that local checks would otherwise promote.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'audit-failed-runbook',
            content: 'The runbook requires audit success before automatic durable promotion.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
    role: 'assistant',
    content: 'Audit failure candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'audit-fail-repo',
    sessionId: 'audit-fail-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.deepEqual(result.promoted, []);
  assert.equal(result.skipped[0].reason, 'audit_needs_review: audit_failed');
  assert.match(result.skipped[0].audit.reason, /audit runner unavailable/);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'audit-fail-repo', key: 'audit-failed-runbook' }), null);
});

test('autoPromoteMemoryCandidates can audit through the Codex Python SDK provider', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'python_sdk_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'codex_sdk_python',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN: '/home/ubuntu/.local/bin/codex',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND: 'python3',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH: '/tmp/contextforge-codex-sdk',
    },
    cwd: process.cwd(),
    autoPromoteAuditRunner: async (invocation) => {
      auditInvocations.push(invocation);
      return {
        stdout: JSON.stringify({
          final_response: JSON.stringify({
            approved: true,
            decision: 'approve',
            reason: 'The candidate is stable and supported by checkpoint evidence.',
            riskCodes: [],
          }),
          elapsed_ms: 12,
        }),
        stderr: '',
      };
    },
    distillProviders: {
      python_sdk_audit_provider: async () => ({
        summaryShort: 'Python SDK audit checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited through the Python SDK provider.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'python-sdk-audit-runbook',
            content: 'The runbook is stable and safe enough for automatic durable promotion after audit.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
    role: 'assistant',
    content: 'Python SDK audit candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
  });

  const result = await app.autoPromoteMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-repo',
    sessionId: 'python-sdk-audit-session',
    trigger: 'manual_closeout',
    dryRun: false,
  });

  assert.equal(result.policy.audit.provider, 'codex_sdk_python');
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].audit.metadata.provider, 'codex_sdk_python');
  assert.equal(result.promoted[0].audit.metadata.codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(result.promoted[0].audit.metadata.pythonPath, '/tmp/contextforge-codex-sdk');
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(auditInvocations[0].pythonCommand, 'python3');
  assert.equal(auditInvocations[0].pythonPath, '/tmp/contextforge-codex-sdk');
  assert.match(auditInvocations[0].prompt, /ContextForge automatic memory promotion auditor/);
  assert.match(auditInvocations[0].prompt, /human-readable reason in Korean/);
  assert.ok(
    app.getMemory({ scope: 'repo', scopeKey: 'python-sdk-audit-repo', key: 'python-sdk-audit-runbook' }),
  );
});

test('auditMemoryCandidates can use the Codex Python SDK provider without enabling auto-promotion', async () => {
  const dataDir = await makeTempDir();
  const auditInvocations = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'python_sdk_audit_suggestions_provider',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'codex_sdk_python',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_CODEX_BIN: '/home/ubuntu/.local/bin/codex',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHON_COMMAND: 'python3',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PYTHONPATH: '/tmp/contextforge-codex-sdk',
    },
    cwd: process.cwd(),
    autoPromoteAuditRunner: async (invocation) => {
      auditInvocations.push(invocation);
      return {
        stdout: JSON.stringify({
          final_response: JSON.stringify({
            approved: false,
            decision: 'needs_review',
            reason: 'The agent should review this candidate before promotion.',
            riskCodes: ['needs_human_review'],
          }),
          elapsed_ms: 21,
        }),
        stderr: '',
      };
    },
    distillProviders: {
      python_sdk_audit_suggestions_provider: async () => ({
        summaryShort: 'Python SDK audit suggestions checkpoint.',
        summaryText: 'Closeout produced a candidate that should be audited without auto-promotion.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'python-sdk-readonly-audit',
            content: 'The Python SDK audit provider can produce read-only closeout recommendations.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
    role: 'assistant',
    content: 'Python SDK read-only audited candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
  });

  const result = await app.auditMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    sessionId: 'python-sdk-audit-suggestions-session',
    trigger: 'manual_closeout',
  });

  assert.equal(result.policy.audit.provider, 'codex_sdk_python');
  assert.equal(result.policy.audit.executed, true);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].recommendedAction, 'review');
  assert.equal(result.proposals[0].audit.metadata.provider, 'codex_sdk_python');
  assert.equal(result.proposals[0].audit.metadata.codexBin, '/home/ubuntu/.local/bin/codex');
  assert.equal(auditInvocations.length, 1);
  assert.equal(auditInvocations[0].pythonCommand, 'python3');
  assert.equal(
    app.getMemory({
      scope: 'repo',
      scopeKey: 'python-sdk-audit-suggestions-repo',
      key: 'python-sdk-readonly-audit',
    }),
    null,
  );
  const pendingCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'python-sdk-audit-suggestions-repo',
    status: 'pending',
  });
  assert.equal(pendingCandidates.length, 1);
});

test('Codex Python SDK auditor treats empty final_response as needs_review', async () => {
  const auditor = createCodexSdkPythonAutoPromoteAuditor({
    codexBin: '/home/ubuntu/.local/bin/codex',
    pythonCommand: 'python3',
    runner: async () => ({
      stdout: JSON.stringify({
        final_response: null,
        elapsed_ms: 7,
      }),
      stderr: '',
    }),
  });

  const result = await auditor({
    candidate: {
      candidate: {
        key: 'empty-final-response',
        content: 'The audit runner returned no final response.',
        category: 'runbook',
      },
    },
    warnings: [],
    checkpoint: null,
  });

  assert.equal(result.approved, false);
  assert.equal(result.decision, 'needs_review');
  assert.deepEqual(result.riskCodes, ['empty_final_response']);
  assert.equal(result.metadata.runnerElapsedMs, 7);
});

test('autoPromoteMemoryCandidates rejects unsupported audit providers', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'unsupported_audit_provider',
      CONTEXTFORGE_AUTO_PROMOTE_ENABLED: 'true',
      CONTEXTFORGE_AUTO_PROMOTE_AUDIT_PROVIDER: 'unknown_audit',
    },
    cwd: process.cwd(),
    distillProviders: {
      unsupported_audit_provider: async () => ({
        summaryShort: 'Unsupported audit provider checkpoint.',
        summaryText: 'Closeout produced a candidate while audit is misconfigured.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'unsupported-audit-runbook',
            content: 'The runbook should not promote when audit provider is unsupported.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.96,
            stability: 0.96,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'unsupported-audit-repo',
    sessionId: 'unsupported-audit-session',
    role: 'assistant',
    content: 'Unsupported audit provider candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'unsupported-audit-repo',
    sessionId: 'unsupported-audit-session',
  });

  await assert.rejects(
    () =>
      app.autoPromoteMemoryCandidates({
        scope: 'repo',
        scopeKey: 'unsupported-audit-repo',
        sessionId: 'unsupported-audit-session',
        trigger: 'manual_closeout',
        dryRun: false,
      }),
    /Unsupported auto-promotion audit provider/,
  );
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'unsupported-audit-repo', key: 'unsupported-audit-runbook' }), null);
});

test('preference candidates record merged occurrences across checkpoints', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'preference_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      preference_provider: async () => ({
        summaryShort: 'Preference checkpoint.',
        summaryText: 'A repeated user preference was observed.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'closing-style',
            content: 'The user prefers concise Korean closeout summaries with command evidence.',
            category: 'preference',
            candidateType: 'preference',
            confidence: 0.9,
            stability: 0.86,
            sensitivity: 'low',
            promotionRecommendation: 'review',
            sourceEventIds: ['event-a'],
          },
        ],
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-a',
    role: 'user',
    content: 'Keep closeout summaries concise and in Korean.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-a',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-b',
    role: 'user',
    content: 'Again, keep closeout summaries concise and in Korean.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-repo',
    sessionId: 'preference-session-b',
  });

  const occurrences = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-repo',
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].mergeKey, 'key:closing-style');
  assert.equal(occurrences[0].occurrenceCount, 2);
  assert.deepEqual(occurrences[0].sessionIds.sort(), ['preference-session-a', 'preference-session-b']);
  assert.equal(occurrences[0].checkpointIds.length, 2);
  assert.equal(occurrences[0].confidence, 0.9);
  assert.equal(occurrences[0].stability, 0.86);
});

test('preference occurrence backfill covers existing preference candidates', async () => {
  const dataDir = await makeTempDir();
  const env = {
    CONTEXTFORGE_DATA_DIR: dataDir,
    CONTEXTFORGE_DISTILL_PROVIDER: 'preference_backfill_provider',
  };
  const distillProviders = {
    preference_backfill_provider: async () => ({
      summaryShort: 'Preference backfill checkpoint.',
      summaryText: 'A preference candidate existed before occurrence tracking.',
      decisions: [],
      todos: [],
      openQuestions: [],
      memoryCandidates: [
        {
          key: 'review-style',
          content: 'The user prefers review comments grouped by severity.',
          category: 'Preference',
          candidateType: 'preference',
          confidence: 0.88,
          stability: 0.82,
          sensitivity: 'low',
          promotionRecommendation: 'review',
        },
      ],
    }),
  };
  const app = createContextForge({ env, cwd: process.cwd(), distillProviders });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
    sessionId: 'preference-backfill-session',
    role: 'assistant',
    content: 'Preference candidate exists before backfill.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
    sessionId: 'preference-backfill-session',
  });

  const db = new Database(path.join(dataDir, 'contextforge.db'));
  try {
    db.prepare('DELETE FROM preference_occurrences').run();
    db.prepare("DELETE FROM schema_meta WHERE key = 'preference_occurrences_backfill_completed_at'").run();
  } finally {
    db.close();
  }

  const reopened = createContextForge({ env, cwd: process.cwd(), distillProviders });
  const occurrences = reopened.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-backfill-repo',
  });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].mergeKey, 'key:review-style');
  assert.equal(occurrences[0].occurrenceCount, 1);
});

test('reconcileMemory apply_safe weakens preference occurrences when rejecting contradicted candidates', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'preference_reconcile_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      preference_reconcile_provider: async () => ({
        summaryShort: 'Preference correction checkpoint.',
        summaryText: 'A preference candidate should be rejected after correction.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'summary-style',
            content: 'The user always wants long exhaustive closeout summaries.',
            category: 'Preference',
            candidateType: 'preference',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'review',
          },
        ],
      }),
    },
  });

  app.appendRaw({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
    role: 'assistant',
    content: 'Preference candidate: long exhaustive summaries.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
  });

  const before = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
  });
  assert.equal(before[0].status, 'active');
  assert.equal(before[0].negativeCount, 0);

  const result = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
    sessionId: 'preference-correction-session',
    query: 'summary style preference',
    correction: 'That is wrong; prefer concise summaries unless I ask for exhaustive detail.',
    mode: 'apply_safe',
  });

  assert.ok(result.appliedActions.some((action) => action.action === 'reject_memory_candidate'));
  assert.ok(result.appliedActions.some((action) => action.action === 'weaken_preference_occurrence'));
  const after = app.listPreferenceOccurrences({
    scope: 'repo',
    scopeKey: 'preference-correction-repo',
  });
  assert.equal(after[0].status, 'weakened');
  assert.equal(after[0].negativeCount, 1);
  assert.match(after[0].lastCorrection, /prefer concise/);
});

test('reconcileMemory proposes by default and apply_safe only changes unambiguous non-live memory', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'reconcile_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      reconcile_provider: async () => ({
        summaryShort: 'Reconcile checkpoint.',
        summaryText: 'Prior note incorrectly said the API uses REST only.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'api-rest-only-candidate',
            content: 'The API uses REST only.',
            category: 'api-contract',
            confidence: 0.8,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    key: 'api-transport',
    content: 'The API uses REST only.',
    category: 'api-contract',
    tags: ['api', 'transport'],
    importance: 6,
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    role: 'assistant',
    content: 'The API uses REST only.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
  });

  const proposedWithoutQuery = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    correction: 'API REST only transport is wrong; the API supports REST and GraphQL.',
  });
  assert.equal(
    proposedWithoutQuery.query,
    'API REST only transport is wrong; the API supports REST and GraphQL.',
  );
  assert.ok(proposedWithoutQuery.basis.some((item) => item.type === 'memory'));

  const proposed = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
  });
  assert.equal(proposed.mode, 'propose');
  assert.ok(proposed.basis.some((item) => item.type === 'memory'));
  assert.ok(proposed.basis.some((item) => item.type === 'checkpoint'));
  assert.ok(proposed.basis.some((item) => item.type === 'memory_candidate'));
  assert.ok(proposed.proposedActions.some((item) => item.action === 'correct_memory'));
  assert.ok(proposed.proposedActions.some((item) => item.action === 'reject_memory_candidate'));
  assert.ok(proposed.updateCandidates.some((item) => item.action === 'correct_memory'));
  assert.ok(proposed.updateCandidates.some((item) => item.action === 'add_corrective_note'));
  assert.equal(
    app.listMemoryUpdateCandidates({
      scope: 'repo',
      scopeKey: 'reconcile-repo',
      status: 'pending',
    }).length,
    0,
  );
  const persisted = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    createUpdateCandidates: true,
  });
  assert.ok(persisted.updateCandidates.every((item) => item.status === 'pending'));
  await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    createUpdateCandidates: true,
  });
  const pendingUpdates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    status: 'pending',
  });
  assert.equal(pendingUpdates.length, 2);
  assert.ok(pendingUpdates.some((item) => item.targetMemoryKey === 'api-transport'));
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content, 'The API uses REST only.');

  const updateCandidate = pendingUpdates.find((item) => item.action === 'correct_memory');
  const appliedUpdate = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    candidateId: updateCandidate.id,
    content: 'The API supports REST, GraphQL, and webhooks.',
    reason: 'Approved correction candidate in test.',
  });
  assert.equal(appliedUpdate.kind, 'memory_update_candidate_apply_result');
  assert.equal(appliedUpdate.candidate.status, 'applied');
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content,
    'The API supports REST, GraphQL, and webhooks.',
  );

  const applied = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'API REST only transport',
    correction: 'The API supports REST and GraphQL.',
    mode: 'apply_safe',
  });
  assert.ok(applied.appliedActions.some((item) => item.action === 'correct_memory'));
  assert.ok(applied.appliedActions.some((item) => item.action === 'reject_memory_candidate'));
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' }).content,
    'The API supports REST and GraphQL.',
  );
  const corrected = app.getMemory({ scope: 'repo', scopeKey: 'reconcile-repo', key: 'api-transport' });
  assert.deepEqual(corrected.tags, ['api', 'transport']);
  assert.equal(corrected.importance, 6);

  const live = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    query: 'PR status on main',
    correction: 'PR #12 is not merged.',
    mode: 'apply_safe',
  });
  assert.ok(live.warnings.some((warning) => warning.code === 'live_state_verification_required'));
  assert.equal(live.appliedActions.length, 0);

  const koreanLive = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'reconcile-repo',
    sessionId: 'reconcile-session',
    correction: '그 PR 아직 안 머지됐잖아. 이슈 상태랑 원격 브랜치를 확인해야 해.',
    mode: 'apply_safe',
  });
  assert.ok(koreanLive.warnings.some((warning) => warning.code === 'live_state_verification_required'));
  assert.equal(koreanLive.appliedActions.length, 0);
});

test('memory update candidates can be rejected without mutating memory', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const original = app.remember({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    key: 'closeout-rule',
    content: 'Closeout requires local tests.',
    category: 'runbook',
  });
  const store = new ContextForgeStore({ dataDir });
  try {
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-reject-repo',
      action: 'deactivate_memory',
      targetMemoryId: original.id,
      targetMemoryKey: original.key,
      reason: 'Proposed stale rule deactivation.',
      confidence: 0.6,
    });
  } finally {
    store.close();
  }

  const candidates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    status: 'pending',
  });
  assert.equal(candidates.length, 1);
  const rejected = app.rejectMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    candidateId: candidates[0].id,
    reason: 'Keep the runbook active.',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(
    app.getMemory({ scope: 'repo', scopeKey: 'update-reject-repo', key: 'closeout-rule' }).status,
    'active',
  );

  const storeAgain = new ContextForgeStore({ dataDir });
  try {
    storeAgain.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-reject-repo',
      action: 'add_corrective_note',
      proposedKey: 'closeout-rule-note',
      proposedContent: 'Closeout requirements were reviewed but not changed.',
      reason: 'Optional note.',
    });
  } finally {
    storeAgain.close();
  }
  const skippedCandidate = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    status: 'pending',
  })[0];
  const skipped = app.skipMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-reject-repo',
    candidateId: skippedCandidate.id,
  });
  assert.equal(skipped.status, 'skipped');
});

test('memory update candidates apply deactivation and duplicate merge actions', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  const stale = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'stale-runbook',
    content: 'This runbook is stale.',
    category: 'runbook',
  });
  const canonical = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'canonical-runbook',
    content: 'This runbook is canonical.',
    category: 'runbook',
  });
  const duplicate = app.remember({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    key: 'duplicate-runbook',
    content: 'Duplicate runbook.',
    category: 'runbook',
  });
  const store = new ContextForgeStore({ dataDir });
  try {
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-apply-repo',
      action: 'deactivate_memory',
      targetMemoryId: stale.id,
      targetMemoryKey: stale.key,
      reason: 'Stale after product change.',
    });
    store.createMemoryUpdateCandidate({
      scopeType: 'repo',
      scopeKey: 'update-apply-repo',
      action: 'merge_duplicate_memories',
      targetMemoryId: duplicate.id,
      targetMemoryKey: duplicate.key,
      proposedKey: canonical.key,
      reason: 'Duplicate durable memory.',
    });
  } finally {
    store.close();
  }

  const updates = app.listMemoryUpdateCandidates({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    status: 'pending',
  });
  const deactivate = updates.find((item) => item.action === 'deactivate_memory');
  const merge = updates.find((item) => item.action === 'merge_duplicate_memories');

  const deactivated = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    candidateId: deactivate.id,
  });
  assert.equal(deactivated.candidate.status, 'applied');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: stale.key }).status, 'inactive');

  const merged = app.applyMemoryUpdateCandidate({
    scope: 'repo',
    scopeKey: 'update-apply-repo',
    candidateId: merge.id,
  });
  assert.equal(merged.candidate.status, 'applied');
  assert.equal(merged.candidate.reviewMetadata.mergedIntoKey, canonical.key);
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: duplicate.key }).status, 'inactive');
  assert.equal(app.getMemory({ scope: 'repo', scopeKey: 'update-apply-repo', key: canonical.key }).status, 'active');
});

test('reconcileMemory apply_safe rejects matching candidates when no durable memory matches', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_only_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_only_provider: async () => ({
        summaryShort: 'Candidate only checkpoint.',
        summaryText: 'Only a candidate exists for this correction.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'candidate-only',
            content: 'Candidate-only stale claim.',
            category: 'runbook',
            confidence: 0.8,
            stability: 0.8,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
    role: 'assistant',
    content: 'Candidate-only stale claim.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
  });

  const result = await app.reconcileMemory({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    sessionId: 'candidate-only-session',
    query: 'candidate-only stale claim',
    correction: 'Candidate-only claim is wrong.',
    mode: 'apply_safe',
  });
  assert.deepEqual(
    result.appliedActions.map((action) => action.action),
    ['reject_memory_candidate'],
  );
  const candidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'candidate-only-repo',
    status: 'rejected',
  });
  assert.equal(candidates.length, 1);
});

test('listScopeKeys returns real scopes from memories, candidates, and distill runs', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'scope_keys_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      scope_keys_provider: async () => ({
        summaryShort: 'Scope key checkpoint.',
        summaryText: 'A checkpoint that creates a candidate for scope key discovery.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'scope-key-candidate',
            content: 'Candidate used for scope key discovery.',
            category: 'note',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });

  app.remember({
    scope: 'shared',
    scopeKey: 'team-shared',
    key: 'scope-key-memory',
    content: 'Durable memory used for scope key discovery.',
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'repo-scope-keys',
    sessionId: 'scope-key-session',
    role: 'user',
    content: 'Create a checkpoint and candidate.',
  });
  await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'repo-scope-keys',
    sessionId: 'scope-key-session',
  });

  const allKeys = app.listScopeKeys();
  const repoKey = allKeys.find((item) => item.scopeType === 'repo' && item.scopeKey === 'repo-scope-keys');
  assert.equal(repoKey.candidates, 1);
  assert.equal(repoKey.distillRuns, 1);
  assert.equal(repoKey.rawEvents, 1);
  assert.equal(repoKey.checkpoints, 1);
  const sharedKeys = app.listScopeKeys({ scope: 'shared' });
  assert.deepEqual(
    sharedKeys.map((item) => item.scopeKey),
    ['team-shared'],
  );
  assert.equal(sharedKeys[0].memories, 1);
});

test('REMOTE_METHODS exposes resume, suggestion, auto-promotion, and reconciliation wrappers', () => {
  assert.ok(REMOTE_METHODS.includes('readiness'));
  assert.ok(REMOTE_METHODS.includes('operationalMetrics'));
  assert.ok(REMOTE_METHODS.includes('migrateScope'));
  assert.ok(REMOTE_METHODS.includes('syncResumeContext'));
  assert.ok(REMOTE_METHODS.includes('agentStart'));
  assert.ok(REMOTE_METHODS.includes('agentCloseout'));
  assert.ok(REMOTE_METHODS.includes('getRuntimeSettings'));
  assert.ok(REMOTE_METHODS.includes('updateRuntimeSettings'));
  assert.ok(REMOTE_METHODS.includes('checkDistillProvider'));
  assert.ok(REMOTE_METHODS.includes('upsertWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('getWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('listWorkspaceProfiles'));
  assert.ok(REMOTE_METHODS.includes('deleteWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('deactivateWorkspaceProfile'));
  assert.ok(REMOTE_METHODS.includes('upsertWorkspaceMember'));
  assert.ok(REMOTE_METHODS.includes('removeWorkspaceMember'));
  assert.ok(REMOTE_METHODS.includes('upsertWorkspaceRoutingRule'));
  assert.ok(REMOTE_METHODS.includes('removeWorkspaceRoutingRule'));
  assert.ok(REMOTE_METHODS.includes('resolveWorkspace'));
  assert.ok(REMOTE_METHODS.includes('listScopeKeys'));
  assert.ok(REMOTE_METHODS.includes('listRecentDistillRuns'));
  assert.ok(REMOTE_METHODS.includes('expandMemoryCluster'));
  assert.ok(REMOTE_METHODS.includes('listLlmUsageEvents'));
  assert.ok(REMOTE_METHODS.includes('llmUsageRollup'));
  assert.ok(REMOTE_METHODS.includes('listDueDistillSessions'));
  assert.ok(REMOTE_METHODS.includes('processDueDistills'));
  assert.ok(REMOTE_METHODS.includes('submitDistillJob'));
  assert.ok(REMOTE_METHODS.includes('submitAuditJob'));
  assert.ok(REMOTE_METHODS.includes('getJob'));
  assert.ok(REMOTE_METHODS.includes('listJobs'));
  assert.ok(REMOTE_METHODS.includes('processJobs'));
  assert.ok(REMOTE_METHODS.includes('cancelJob'));
  assert.ok(REMOTE_METHODS.includes('listMemories'));
  assert.ok(REMOTE_METHODS.includes('suggestMemoryPromotions'));
  assert.ok(REMOTE_METHODS.includes('auditMemoryCandidates'));
  assert.ok(REMOTE_METHODS.includes('autoPromoteMemoryCandidates'));
  assert.ok(REMOTE_METHODS.includes('reconcileMemory'));
  assert.ok(REMOTE_METHODS.includes('listPreferenceOccurrences'));
  assert.ok(REMOTE_METHODS.includes('listMemoryUpdateCandidates'));
  assert.ok(REMOTE_METHODS.includes('auditMemoryDuplicates'));
  assert.ok(REMOTE_METHODS.includes('applyMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('rejectMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('skipMemoryUpdateCandidate'));
  assert.ok(REMOTE_METHODS.includes('embeddingInventory'));
  assert.ok(REMOTE_METHODS.includes('pruneEmbeddingArtifacts'));
  assert.ok(REMOTE_METHODS.includes('processEmbeddingJobs'));
  assert.ok(REMOTE_METHODS.includes('listEmbeddingJobs'));
  assert.ok(REMOTE_METHODS.includes('listCheckpoints'));
  assert.ok(REMOTE_METHODS.includes('getSessionWorkingContext'));
  assert.ok(REMOTE_METHODS.includes('upsertSessionWorkingContext'));
});

test('workspace profiles persist members and resolve explainable scope plans', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const profile = app.upsertWorkspaceProfile({
    workspaceKey: 'synthetic-product',
    displayName: 'Synthetic Product',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/suite',
    repoPath: '/private/should-not-persist',
  });
  assert.equal(profile.workspaceKey, 'synthetic-product');
  assert.equal(profile.status, 'active');

  app.upsertWorkspaceMember({
    workspaceKey: 'synthetic-product',
    name: 'suite',
    scope: 'repo',
    scopeKey: 'github.com/example/suite',
    role: 'cross-repo-contract',
    priority: 100,
    includeByDefault: true,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'synthetic-product',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
    priority: 90,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'synthetic-product',
    name: 'web',
    scope: 'repo',
    scopeKey: 'github.com/example/web',
    role: 'desktop-web-consumer',
    priority: 60,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'synthetic-product',
    name: 'docs',
    scope: 'repo',
    scopeKey: 'github.com/example/docs',
    role: 'docs',
    priority: 10,
  });
  assert.throws(() =>
    app.upsertWorkspaceMember({
      workspaceKey: 'synthetic-product',
      name: 'duplicate-suite',
      scope: 'repo',
      scopeKey: 'github.com/example/suite',
      role: 'docs',
    }),
  );
  assert.throws(() =>
    app.upsertWorkspaceMember({
      workspaceKey: 'synthetic-product',
      name: 'local-machine',
      scope: 'local',
      scopeKey: 'machine-only',
    }),
  );

  app.upsertWorkspaceRoutingRule({
    workspaceKey: 'synthetic-product',
    ruleKey: 'contract_terms',
    priority: 100,
    matchJson: '{"termsAny":["contract","OpenAPI","permission","E2E","frontend"]}',
    includeJson: '{"roles":["cross-repo-contract","api-domain-ssot","desktop-web-consumer","docs"]}',
    excludeJson: '{"roles":["docs"]}',
    includeShared: false,
  });
  app.upsertWorkspaceRoutingRule({
    workspaceKey: 'synthetic-product',
    ruleKey: 'primary_exclude_attempt',
    priority: 90,
    match: { termsAny: ['OpenAPI'] },
    exclude: { members: ['backend'] },
  });

  const fetched = app.getWorkspaceProfile({ workspaceKey: 'synthetic-product' });
  assert.equal(fetched.members.length, 4);
  assert.equal(fetched.routingRules.length, 2);
  assert.equal(JSON.stringify(fetched).includes('/private/should-not-persist'), false);

  const plan = app.resolveWorkspace({
    workspaceKey: 'synthetic-product',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'OpenAPI permission frontend contract',
    consultReason: 'startup',
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.primaryScope.memberName, 'backend');
  assert.deepEqual(
    plan.includedScopes.map((scope) => scope.memberName),
    ['suite', 'backend', 'web'],
  );
  assert.equal(plan.includeShared, false);
  assert.deepEqual(plan.excludedScopes.map((scope) => scope.memberName), ['docs']);
  assert.deepEqual(plan.excludedScopes[0].excludedBecause, ['excluded_by_rule:contract_terms']);
  assert.equal(plan.includedScopes.find((scope) => scope.memberName === 'backend').includedBecause.includes('excluded_by_rule:primary_exclude_attempt'), false);
  assert.equal(plan.warnings.find((warning) => warning.code === 'primary_scope_matched_exclude_rule').reason, 'excluded_by_rule:primary_exclude_attempt');
  assert.equal(plan.matchedRules[0].ruleKey, 'contract_terms');
  assert.deepEqual(plan.matchedRules[0].matchedTerms, ['contract', 'OpenAPI', 'permission', 'frontend']);

  const quietPlan = app.resolveWorkspace({
    workspaceKey: 'synthetic-product',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'ordinary backend task',
  });
  assert.deepEqual(
    quietPlan.includedScopes.map((scope) => scope.memberName),
    ['suite', 'backend'],
  );

  const offPlan = app.resolveWorkspace({
    workspaceKey: 'synthetic-product',
    workspaceMode: 'off',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
  });
  assert.equal(offPlan.enabled, false);
  assert.equal(offPlan.warnings[0].code, 'workspace_mode_off');

  const missingPlan = app.resolveWorkspace({
    workspaceKey: 'missing-workspace',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
  });
  assert.equal(missingPlan.enabled, false);
  assert.equal(missingPlan.warnings[0].code, 'workspace_not_found');

  const outsideAuto = app.resolveWorkspace({
    workspaceKey: 'synthetic-product',
    scope: 'repo',
    scopeKey: 'github.com/example/other',
    query: 'OpenAPI',
  });
  assert.equal(outsideAuto.enabled, false);
  assert.equal(outsideAuto.warnings[0].code, 'primary_scope_not_workspace_member');
  assert.throws(() =>
    app.resolveWorkspace({
      workspaceKey: 'synthetic-product',
      workspaceMode: 'strict',
      scope: 'repo',
      scopeKey: 'github.com/example/other',
    }),
  );

  const inactive = app.deleteWorkspaceProfile({ workspaceKey: 'synthetic-product' });
  assert.equal(inactive.status, 'inactive');
  const inactivePlan = app.resolveWorkspace({
    workspaceKey: 'synthetic-product',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
  });
  assert.equal(inactivePlan.enabled, false);
  assert.equal(inactivePlan.warnings[0].code, 'workspace_inactive');
  const reactivated = app.upsertWorkspaceProfile({
    workspaceKey: 'synthetic-product',
    displayName: 'Synthetic Product Reactivated',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/suite',
  });
  assert.equal(reactivated.id, profile.id);
  assert.equal(reactivated.status, 'active');
});

test('workspace resolver warns when canonical scope is not an active member', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.upsertWorkspaceProfile({
    workspaceKey: 'missing-canonical',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/suite',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'missing-canonical',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
  });

  const plan = app.resolveWorkspace({
    workspaceKey: 'missing-canonical',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'contract',
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.warnings[0].code, 'canonical_scope_not_member');
});

test('workspace routing JSON validation rejects unsupported shapes', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.upsertWorkspaceProfile({ workspaceKey: 'validation-demo' });
  assert.throws(() =>
    app.upsertWorkspaceRoutingRule({
      workspaceKey: 'validation-demo',
      ruleKey: 'bad_array',
      matchJson: '[]',
    }),
  );
  assert.throws(() =>
    app.upsertWorkspaceRoutingRule({
      workspaceKey: 'validation-demo',
      ruleKey: 'bad_key',
      matchJson: '{"regex":"nope"}',
    }),
  );
  assert.throws(() =>
    app.upsertWorkspaceRoutingRule({
      workspaceKey: 'validation-demo',
      ruleKey: 'too_many_terms',
      match: { termsAny: Array.from({ length: 51 }, (_, index) => `term-${index}`) },
    }),
  );
});

test('remote long-running provider calls include the client timeout contract', async () => {
  const calls = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_REMOTE_TIMEOUT_MS: '4321',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: { id: 'checkpoint-remote' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await app.distillCheckpoint({ scope: 'repo', scopeKey: 'remote-timeout-repo', sessionId: 'remote-timeout-session' });
  assert.equal(calls[0].url, 'https://memory.example.test/v0/distillCheckpoint');
  assert.equal(calls[0].body._clientTimeoutMs, 4321);
});

test('remote workspace profile calls dispatch to the canonical server without scoped fallback', async () => {
  const calls = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: { workspaceKey: 'remote-workspace', ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await app.upsertWorkspaceProfile({ workspaceKey: 'remote-workspace' });
  assert.equal(result.workspaceKey, 'remote-workspace');
  assert.equal(calls[0].url, 'https://memory.example.test/v0/upsertWorkspaceProfile');
  assert.deepEqual(calls[0].body, { workspaceKey: 'remote-workspace' });
});

test('remote agentStart resolves local path hints before canonical server dispatch', async () => {
  const calls = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_DEFAULT_SCOPE_KEY: 'github.com/example/backend',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          result: {
            kind: 'agent_start_context',
            agent: body.agent,
            scope: { scopeType: body.scopeType, scopeKey: body.scopeKey },
            context: {
              scope: { scopeType: body.scopeType, scopeKey: body.scopeKey },
              storage: {
                mode: 'local',
                authority: 'local',
                connection: { mode: 'http-server', accessPath: 'in-process' },
              },
              results: [],
            },
            summary: {
              storage: {
                mode: 'local',
                authority: 'local',
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });

  const result = await app.agentStart({
    agent: 'codex',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    repoPath: process.cwd(),
    query: 'remote agent start',
  });
  assert.equal(calls[0].url, 'https://memory.example.test/v0/agentStart');
  assert.equal(calls[0].body.repoPath, undefined);
  assert.equal(calls[0].body.scopeKey, 'github.com/example/backend');
  assert.equal(result.context.storage.mode, 'remote');
  assert.equal(result.context.storage.authority, 'canonical');
  assert.equal(result.context.storage.serverMode, 'local');
});

test('remote agentCloseout resolves local path hints and marks canonical storage', async () => {
  const calls = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_DEFAULT_SCOPE_KEY: 'github.com/example/backend',
    },
    cwd: process.cwd(),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          result: {
            kind: 'agent_closeout_review',
            agent: body.agent,
            scope: { scopeType: body.scopeType, scopeKey: body.scopeKey },
            source: {
              sessionId: body.sessionId,
              checkpointId: body.checkpointId || null,
              mode: 'session_pending_batch',
            },
            storage: {
              mode: 'local',
              authority: 'local',
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });

  const result = await app.agentCloseout({
    agent: 'codex',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    repoPath: process.cwd(),
    sessionId: 'codex:remote-closeout-session',
  });
  assert.equal(calls[0].url, 'https://memory.example.test/v0/agentCloseout');
  assert.equal(calls[0].body.repoPath, undefined);
  assert.equal(calls[0].body.scopeKey, 'github.com/example/backend');
  assert.equal(result.storage.mode, 'remote');
  assert.equal(result.storage.authority, 'canonical');
  assert.equal(result.storage.serverMode, 'local');
});

test('CLI supports workspace profile upsert member rule and resolve commands', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'workspaceUpsert',
      '--workspaceKey',
      'cli-workspace',
      '--displayName',
      'CLI Workspace',
      '--canonicalScope',
      'repo',
      '--canonicalScopeKey',
      'github.com/example/suite',
    ],
    { env },
  );
  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'workspaceMemberUpsert',
      '--workspaceKey',
      'cli-workspace',
      '--name',
      'suite',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/suite',
      '--role',
      'cross-repo-contract',
      '--priority',
      '100',
      '--includeByDefault',
      'true',
    ],
    { env },
  );
  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'workspaceMemberUpsert',
      '--workspaceKey',
      'cli-workspace',
      '--name',
      'backend',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--role',
      'api-domain-ssot',
      '--priority',
      '90',
    ],
    { env },
  );
  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'workspaceRuleUpsert',
      '--workspaceKey',
      'cli-workspace',
      '--ruleKey',
      'contract_terms',
      '--matchJson',
      '{"termsAny":["OpenAPI"]}',
      '--includeJson',
      '{"roles":["api-domain-ssot"]}',
    ],
    { env },
  );
  const resolved = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'workspaceResolve',
      '--workspaceKey',
      'cli-workspace',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--query',
      'OpenAPI',
    ],
    { env },
  );
  const plan = JSON.parse(resolved.stdout);
  assert.equal(plan.enabled, true);
  assert.deepEqual(
    plan.includedScopes.map((scope) => scope.memberName),
    ['suite', 'backend'],
  );
});

test('bootstrapContext adds bounded supplemental workspace results when workspaceKey is provided', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.upsertWorkspaceProfile({
    workspaceKey: 'bootstrap-workspace',
    displayName: 'Bootstrap Workspace',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/suite',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'bootstrap-workspace',
    name: 'suite',
    scope: 'repo',
    scopeKey: 'github.com/example/suite',
    role: 'cross-repo-contract',
    priority: 100,
    includeByDefault: true,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'bootstrap-workspace',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
    priority: 90,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'bootstrap-workspace',
    name: 'web',
    scope: 'repo',
    scopeKey: 'github.com/example/web',
    role: 'desktop-web-consumer',
    priority: 60,
  });
  app.upsertWorkspaceRoutingRule({
    workspaceKey: 'bootstrap-workspace',
    ruleKey: 'contract_terms',
    priority: 100,
    match: { termsAny: ['OpenAPI', 'contract', 'frontend'] },
    include: { roles: ['cross-repo-contract', 'api-domain-ssot', 'desktop-web-consumer'] },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    key: 'backend-openapi-contract',
    content: 'Backend owns the OpenAPI permission contract.',
    category: 'contract',
    importance: 8,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/suite',
    key: 'suite-openapi-contract',
    content: 'Suite records the cross-repo OpenAPI frontend contract.',
    category: 'contract',
    importance: 8,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/web',
    key: 'web-openapi-consumer',
    content: 'Web frontend consumes the OpenAPI contract.',
    category: 'consumer',
    importance: 5,
  });

  const withoutWorkspace = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'OpenAPI frontend contract',
    consultReason: 'startup',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(withoutWorkspace, 'workspace'), false);

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'OpenAPI frontend contract',
    consultReason: 'startup',
    workspaceKey: 'bootstrap-workspace',
    workspaceResultLimit: 2,
    workspacePerScopeLimit: 1,
  });

  assert.equal(bootstrap.workspace.enabled, true);
  assert.equal(bootstrap.workspace.scopePlan.primaryScope.memberName, 'backend');
  assert.deepEqual(
    bootstrap.workspace.scopePlan.includedScopes.map((scope) => scope.memberName),
    ['suite', 'backend', 'web'],
  );
  assert.equal(bootstrap.results.some((result) => result.key === 'backend-openapi-contract'), true);
  assert.equal(bootstrap.workspace.results.length, 2);
  assert.equal(bootstrap.workspace.results.some((result) => result.key === 'backend-openapi-contract'), false);
  assert.deepEqual(
    bootstrap.workspace.results.map((result) => result.scope.memberName),
    ['suite', 'web'],
  );
  assert.deepEqual(bootstrap.workspace.results[0].includedBecause, ['include_by_default', 'canonical_scope', 'routing_rule:contract_terms']);
  assert.equal(bootstrap.workspace.results[0].scope.workspaceKey, 'bootstrap-workspace');
  assert.equal(bootstrap.workspace.memoryMap.kind, 'workspace_memory_map');
  assert.equal(
    bootstrap.workspace.memoryMap.scopes.find((scope) => scope.memberName === 'backend').resultCount,
    0,
  );
  assert.equal(bootstrap.workspace.limits.includeWorkspaceHandoffs, false);
});

test('bootstrapContext workspace shared retrieval is opt-in and provenance tagged', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_SHARED_SCOPE_KEY: 'team-shared',
    },
    cwd: process.cwd(),
  });
  app.upsertWorkspaceProfile({
    workspaceKey: 'shared-workspace',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/backend',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'shared-workspace',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
  });
  app.upsertWorkspaceRoutingRule({
    workspaceKey: 'shared-workspace',
    ruleKey: 'shared_terms',
    match: { termsAny: ['policy'] },
    include: { roles: ['api-domain-ssot'] },
    includeShared: true,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    key: 'backend-policy',
    content: 'Backend policy memory.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'team-shared',
    key: 'shared-policy',
    content: 'Shared policy memory for workspace retrieval.',
  });

  const ordinary = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'policy',
    consultReason: 'startup',
    workspaceKey: 'shared-workspace',
  });
  assert.equal(ordinary.workspace.scopePlan.includeShared, true);
  assert.equal(ordinary.workspace.results.some((result) => result.scope.scopeType === 'shared'), true);
  assert.equal(ordinary.workspace.results.find((result) => result.scope.scopeType === 'shared').scope.workspaceKey, 'shared-workspace');

  const off = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'policy',
    consultReason: 'startup',
    workspaceKey: 'shared-workspace',
    workspaceMode: 'off',
  });
  assert.equal(off.workspace.enabled, false);
  assert.equal(off.workspace.results.length, 0);
  assert.equal(off.workspace.scopePlan.warnings[0].code, 'workspace_mode_off');
});

test('bootstrapContext does not let primary includeShared enable workspace shared retrieval', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_SHARED_SCOPE_KEY: 'team-shared',
    },
    cwd: process.cwd(),
  });
  app.upsertWorkspaceProfile({
    workspaceKey: 'primary-shared-workspace',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/backend',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'primary-shared-workspace',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    key: 'backend-policy',
    content: 'Backend policy memory.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'team-shared',
    key: 'shared-policy',
    content: 'Shared policy memory should stay in top-level shared results only.',
  });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'policy',
    consultReason: 'startup',
    includeShared: true,
    workspaceKey: 'primary-shared-workspace',
  });

  assert.equal(bootstrap.results.some((result) => result.group === 'shared' && result.key === 'shared-policy'), true);
  assert.equal(bootstrap.workspace.scopePlan.includeShared, false);
  assert.equal(bootstrap.workspace.results.some((result) => result.scope.scopeType === 'shared'), false);
});

test('bootstrapContext ignores workspace-only limits when workspaceKey is absent', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'policy',
    consultReason: 'startup',
    workspaceKey: '   ',
    workspaceResultLimit: 0,
    workspacePerScopeLimit: 0,
  });

  assert.equal(Object.prototype.hasOwnProperty.call(bootstrap, 'workspace'), false);
});

test('search keeps the legacy array shape unless workspaceKey is provided', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    key: 'backend-openapi-contract',
    content: 'Backend owns the OpenAPI permission contract.',
    category: 'contract',
  });

  const results = await app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'OpenAPI permission',
  });

  assert.equal(Array.isArray(results), true);
  assert.equal(results[0].memory.key, 'backend-openapi-contract');

  const blankWorkspaceKey = await app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'OpenAPI permission',
    workspaceKey: '   ',
  });
  assert.equal(Array.isArray(blankWorkspaceKey), true);
  assert.equal(blankWorkspaceKey[0].memory.key, 'backend-openapi-contract');
});

test('search adds bounded supplemental workspace results when workspaceKey is provided', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.upsertWorkspaceProfile({
    workspaceKey: 'search-workspace',
    displayName: 'Search Workspace',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/suite',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'search-workspace',
    name: 'suite',
    scope: 'repo',
    scopeKey: 'github.com/example/suite',
    role: 'cross-repo-contract',
    priority: 100,
    includeByDefault: true,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'search-workspace',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
    priority: 90,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'search-workspace',
    name: 'web',
    scope: 'repo',
    scopeKey: 'github.com/example/web',
    role: 'desktop-web-consumer',
    priority: 60,
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'search-workspace',
    name: 'ops',
    scope: 'repo',
    scopeKey: 'github.com/example/ops',
    role: 'ops',
    priority: 10,
  });
  app.upsertWorkspaceRoutingRule({
    workspaceKey: 'search-workspace',
    ruleKey: 'contract_terms',
    priority: 100,
    match: { termsAny: ['OpenAPI', 'contract', 'frontend'] },
    include: { roles: ['cross-repo-contract', 'api-domain-ssot', 'desktop-web-consumer'] },
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    key: 'backend-openapi-contract',
    content: 'Backend owns the OpenAPI permission contract.',
    category: 'contract',
    importance: 8,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/suite',
    key: 'suite-openapi-contract',
    content: 'Suite records the cross-repo OpenAPI frontend contract.',
    category: 'contract',
    importance: 8,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/web',
    key: 'web-openapi-consumer',
    content: 'Web frontend consumes the OpenAPI contract.',
    category: 'consumer',
    importance: 5,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/ops',
    key: 'ops-openapi-note',
    content: 'Ops mentions the OpenAPI frontend contract but is not a workspace routing match.',
    category: 'ops',
    importance: 10,
  });

  const search = await app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'OpenAPI frontend contract',
    workspaceKey: 'search-workspace',
    workspaceResultLimit: 2,
    workspacePerScopeLimit: 1,
  });

  assert.equal(search.kind, 'workspace_search');
  assert.equal(search.scope.scopeKey, 'github.com/example/backend');
  assert.equal(search.results.some((result) => result.memory.key === 'backend-openapi-contract'), true);
  assert.equal(search.workspace.enabled, true);
  assert.equal(search.workspace.scopePlan.primaryScope.memberName, 'backend');
  assert.deepEqual(
    search.workspace.scopePlan.includedScopes.map((scope) => scope.memberName),
    ['suite', 'backend', 'web'],
  );
  assert.equal(
    search.workspace.scopePlan.excludedScopes.some((scope) => scope.memberName === 'ops'),
    true,
  );
  assert.equal(search.workspace.results.length, 2);
  assert.equal(search.workspace.results.some((result) => result.key === 'backend-openapi-contract'), false);
  assert.equal(search.workspace.results.some((result) => result.key === 'ops-openapi-note'), false);
  assert.deepEqual(
    search.workspace.results.map((result) => result.scope.memberName),
    ['suite', 'web'],
  );
  assert.equal(search.workspace.results[0].scope.workspaceKey, 'search-workspace');
  assert.deepEqual(search.workspace.results[0].includedBecause, [
    'include_by_default',
    'canonical_scope',
    'routing_rule:contract_terms',
  ]);
  assert.equal(search.workspace.memoryMap.kind, 'workspace_memory_map');
  assert.equal(search.workspace.limits.includePrimaryInWorkspaceResults, false);

  const withPrimary = await app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'OpenAPI frontend contract',
    workspaceKey: 'search-workspace',
    workspaceResultLimit: 3,
    workspacePerScopeLimit: 1,
    includePrimaryInWorkspaceResults: true,
  });
  assert.equal(withPrimary.workspace.limits.includePrimaryInWorkspaceResults, true);
  assert.equal(withPrimary.workspace.results.some((result) => result.key === 'backend-openapi-contract'), true);
});

test('search reports a workspace warning when a requested profile is missing', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    key: 'backend-policy',
    content: 'Backend policy memory remains searchable without workspace profile state.',
  });

  const search = await app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'policy',
    workspaceKey: 'missing-workspace',
  });

  assert.equal(search.kind, 'workspace_search');
  assert.equal(search.results[0].memory.key, 'backend-policy');
  assert.equal(search.workspace.enabled, false);
  assert.equal(search.workspace.results.length, 0);
  assert.equal(search.workspace.warnings[0].code, 'workspace_not_found');
});

test('search workspace shared retrieval stays routing-rule opt-in', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_SHARED_SCOPE_KEY: 'team-shared',
    },
    cwd: process.cwd(),
  });
  app.upsertWorkspaceProfile({
    workspaceKey: 'search-shared-workspace',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/backend',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'search-shared-workspace',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'search-shared-workspace',
    name: 'team',
    scope: 'shared',
    scopeKey: 'team-shared',
    role: 'shared-policy',
    includeByDefault: true,
  });
  app.upsertWorkspaceRoutingRule({
    workspaceKey: 'search-shared-workspace',
    ruleKey: 'shared_terms',
    match: { termsAny: ['policy'] },
    include: { roles: ['api-domain-ssot'] },
    includeShared: true,
  });
  app.remember({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    key: 'backend-policy',
    content: 'Backend policy memory.',
  });
  app.remember({
    scope: 'shared',
    scopeKey: 'team-shared',
    key: 'shared-policy',
    content: 'Shared policy memory for workspace search.',
  });

  const search = await app.search({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    query: 'policy',
    workspaceKey: 'search-shared-workspace',
  });
  assert.equal(search.workspace.scopePlan.includeShared, true);
  assert.equal(search.workspace.results.some((result) => result.scope.scopeType === 'shared'), true);
  assert.equal(
    search.workspace.results.find((result) => result.scope.scopeType === 'shared').scope.workspaceKey,
    'search-shared-workspace',
  );
  assert.equal(
    search.workspace.results.filter((result) => result.key === 'shared-policy').length,
    1,
  );
  assert.equal(
    search.workspace.warnings.some((warning) => warning.code === 'shared_scope_already_included'),
    true,
  );
});

test('evalRetrieval passes for the synthetic workspace fixture', async () => {
  const result = await execFileAsync('node', [
    'src/cli.js',
    'evalRetrieval',
    '--fixture',
    'docs/examples/workspace-eval/wastelite.synthetic.json',
  ]);
  const evalResult = JSON.parse(result.stdout);
  assert.equal(evalResult.kind, 'retrieval_eval');
  assert.equal(evalResult.queries, 3);
  assert.equal(evalResult.failed, 0);
  assert.equal(evalResult.passed, 3);
  assert.equal(evalResult.details.every((detail) => detail.passed), true);
  assert.ok(evalResult.details.every((detail) => detail.resultWindow.primary >= 0));
  assert.ok(evalResult.details.every((detail) => detail.resultWindow.workspace >= 0));
});

test('evalRetrieval fails with useful missing term and role details', async () => {
  const dataDir = await makeTempDir();
  const fixturePath = path.join(dataDir, 'failing-eval.json');
  const fixture = JSON.parse(await fs.readFile('docs/examples/workspace-eval/wastelite.synthetic.json', 'utf8'));
  fixture.queries = [
    {
      query: 'OpenAPI mirror frontend can edit?',
      primaryScopeKey: 'github.com/example/wastelite_frontend_react',
      expected: {
        mustContain: ['missing required phrase'],
        expectedScopeRoles: ['missing-role'],
      },
    },
  ];
  await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2));

  await assert.rejects(
    async () => execFileAsync('node', ['src/cli.js', 'evalRetrieval', '--fixture', fixturePath]),
    (error) => {
      const evalResult = JSON.parse(error.stdout);
      assert.equal(evalResult.kind, 'retrieval_eval');
      assert.equal(evalResult.failed, 1);
      assert.deepEqual(evalResult.details[0].missingRequiredTerms, ['missing required phrase']);
      assert.deepEqual(evalResult.details[0].missingScopeRoles, ['missing-role']);
      return true;
    },
  );
});

test('evalRetrieval reports fixture parse errors with the fixture path', async () => {
  const dataDir = await makeTempDir();
  const fixturePath = path.join(dataDir, 'invalid-eval.json');
  await fs.writeFile(fixturePath, '{not valid json');

  await assert.rejects(
    async () => execFileAsync('node', ['src/cli.js', 'evalRetrieval', '--fixture', fixturePath]),
    (error) => {
      assert.match(error.stderr, new RegExp(`Invalid eval fixture ${fixturePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      return true;
    },
  );
});

test('agentStart is adapter-neutral and forwards workspaceKey to bootstrapContext', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });
  app.upsertWorkspaceProfile({
    workspaceKey: 'agent-start-workspace',
    canonicalScope: 'repo',
    canonicalScopeKey: 'github.com/example/backend',
  });
  app.upsertWorkspaceMember({
    workspaceKey: 'agent-start-workspace',
    name: 'backend',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    role: 'api-domain-ssot',
  });

  for (const adapter of listAgentAdapters()) {
    const result = await app.agentStart({
      agent: adapter.id,
      scope: 'repo',
      scopeKey: 'github.com/example/backend',
      workspaceKey: 'agent-start-workspace',
      query: 'OpenAPI startup context',
      consultReason: 'startup',
    });
    assert.equal(result.kind, 'agent_start_context');
    assert.equal(result.agent, adapter.id);
    assert.equal(result.context.workspace.enabled, true);
    assert.equal(result.summary.workspace.workspaceKey, 'agent-start-workspace');
  }
});

test('agentCloseout rejects broad backlog review without sessionId or checkpointId', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  await assert.rejects(
    () =>
      app.agentCloseout({
        agent: 'codex',
        scope: 'repo',
        scopeKey: 'github.com/example/backend',
      }),
    /requires sessionId or checkpointId/,
  );
});

test('agent lifecycle rejects a missing agent adapter value clearly', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({ env: { CONTEXTFORGE_DATA_DIR: dataDir }, cwd: process.cwd() });

  await assert.rejects(
    () =>
      app.agentStart({
        agent: true,
        scope: 'repo',
        scopeKey: 'github.com/example/backend',
        query: 'startup',
      }),
    /require an agent adapter id value/,
  );
});

test('agentCloseout distills, audits, suggests, and preserves adapter session id without promotion', async () => {
  const dataDir = await makeTempDir();
  let auditInvocations = 0;
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'agent_closeout_provider',
    },
    cwd: process.cwd(),
    autoPromoteAuditor: async () => {
      auditInvocations += 1;
      return {
        approved: true,
        decision: 'approve',
        reason: 'Synthetic closeout auditor approved the runbook candidate.',
        riskCodes: [],
        metadata: { provider: 'test' },
      };
    },
    distillProviders: {
      agent_closeout_provider: async () => ({
        summaryShort: 'Agent closeout checkpoint.',
        summaryText: 'Agent closeout should keep promotion review read-only by default.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'agent-closeout-runbook',
            content: 'Agent closeout should review candidates without promoting them by default.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.95,
            stability: 0.95,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    sessionId: 'codex:agent-closeout-session',
    role: 'assistant',
    content: 'Close out this agent session with one durable candidate.',
  });

  const result = await app.agentCloseout({
    agent: 'codex',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    sessionId: 'codex:agent-closeout-session',
    distill: 'always',
    trigger: 'manual_closeout',
    audit: true,
    suggest: true,
  });

  assert.equal(result.kind, 'agent_closeout_review');
  assert.equal(result.agent, 'codex');
  assert.equal(result.dryRun, true);
  assert.equal(result.source.sessionId, 'codex:agent-closeout-session');
  assert.equal(result.checkpoint.sessionId, 'codex:agent-closeout-session');
  assert.equal(result.checkpoint.memoryCandidateCount, 1);
  assert.equal(result.audit.kind, 'memory_candidate_audit_suggestions');
  assert.equal(auditInvocations, 1);
  assert.equal(result.suggestions.kind, 'memory_promotion_suggestions');
  assert.equal(result.summary.suggestions.proposalCount, 1);
  assert.equal(
    app.listMemories({
      scope: 'repo',
      scopeKey: 'github.com/example/backend',
    }).length,
    0,
  );
});

test('agentCloseout supports checkpointId-only closeout review without distilling', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'agent_checkpoint_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      agent_checkpoint_provider: async () => ({
        summaryShort: 'Checkpoint-only closeout.',
        summaryText: 'Checkpoint-only closeout should review existing candidates.',
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: 'checkpoint-only-runbook',
            content: 'Checkpoint-only closeout should not require the original session id.',
            category: 'runbook',
            candidateType: 'runbook',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
      }),
    },
  });
  app.appendRaw({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    sessionId: 'claude_code:checkpoint-only-session',
    role: 'assistant',
    content: 'Create a checkpoint candidate for checkpoint-only closeout.',
  });
  const checkpoint = await app.distillCheckpoint({
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    sessionId: 'claude_code:checkpoint-only-session',
  });

  const result = await app.agentCloseout({
    agent: 'claude_code',
    scope: 'repo',
    scopeKey: 'github.com/example/backend',
    checkpointId: checkpoint.id,
    trigger: 'manual_closeout',
    audit: false,
    suggest: false,
  });

  assert.equal(result.source.sessionId, null);
  assert.equal(result.source.checkpointId, checkpoint.id);
  assert.equal(result.source.mode, 'provided_checkpoint');
  assert.equal(result.distill.executed, false);
  assert.equal(result.distill.skippedReason, 'checkpoint_only_source');
  assert.equal(result.audit, null);
  assert.equal(result.suggestions, null);
});

test('CLI supports agentStart and dry-run agentCloseout commands', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const start = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'agentStart',
      '--agent',
      'claude_code',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--query',
      'startup handoff',
    ],
    { env },
  );
  const startResult = JSON.parse(start.stdout);
  assert.equal(startResult.kind, 'agent_start_context');
  assert.equal(startResult.agent, 'claude_code');

  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'appendRaw',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--sessionId',
      'codex:cli-agent-closeout',
      '--role',
      'assistant',
      '--content',
      'CLI closeout should preserve adapter-prefixed session id.',
    ],
    { env },
  );

  const closeout = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'agentCloseout',
      '--agent',
      'codex',
      '--scope',
      'repo',
      '--scopeKey',
      'github.com/example/backend',
      '--sessionId',
      'codex:cli-agent-closeout',
      '--distill',
      'never',
      '--audit',
      '0',
      '--suggest',
      'no',
      '--dryRun',
      '1',
    ],
    { env },
  );
  const closeoutResult = JSON.parse(closeout.stdout);
  assert.equal(closeoutResult.kind, 'agent_closeout_review');
  assert.equal(closeoutResult.dryRun, true);
  assert.equal(closeoutResult.audit, null);
  assert.equal(closeoutResult.suggestions, null);
  assert.equal(closeoutResult.source.sessionId, 'codex:cli-agent-closeout');
});

test('CLI supports the v0 workflow with synthetic data', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const dbInfo = await execFileAsync('node', ['src/cli.js', 'dbInfo'], { env });
  assert.match(dbInfo.stdout, new RegExp(`"schemaVersion": ${SCHEMA_VERSION}`));

  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'remember',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--key',
      'retrieval',
      '--content',
      'Search durable memories before checkpoints.',
      '--tag',
      'retrieval',
    ],
    { env },
  );

  const search = await execFileAsync(
    'node',
    ['src/cli.js', 'search', '--scope', 'repo', '--scopeKey', 'cli-repo', '--query', 'durable'],
    { env },
  );
  assert.match(search.stdout, /"key": "retrieval"/);

  const bootstrap = await execFileAsync(
    'node',
    ['src/cli.js', 'bootstrapContext', '--scope', 'repo', '--scopeKey', 'cli-repo', '--query', 'durable previous work'],
    { env },
  );
  assert.match(bootstrap.stdout, /"trust": "reviewed_durable"/);
  assert.match(bootstrap.stdout, /"nextActions":/);
  assert.match(bootstrap.stdout, /"memoryMap":/);
  const bootstrapJson = JSON.parse(bootstrap.stdout);
  const expand = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'expandMemoryCluster',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--clusterId',
      bootstrapJson.memoryMap.clusters[0].clusterId,
    ],
    { env },
  );
  assert.match(expand.stdout, /"kind": "memory_cluster_expansion"/);
  assert.match(expand.stdout, /"key": "retrieval"/);

  await execFileAsync(
    'node',
    [
      'src/cli.js',
      'appendRaw',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
      '--role',
      'user',
      '--content',
      'What should happen next?',
    ],
    { env },
  );

  const checkpoint = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'distillCheckpoint',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(checkpoint.stdout, /"provider": "mock"/);

  const status = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'sessionStatus',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(status.stdout, /"latestCheckpointId":/);

  const runs = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listDistillRuns',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(runs.stdout, /"status": "succeeded"/);

  const usage = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'distillUsage',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(usage.stdout, /"estimatedInputTokens":/);
  assert.match(usage.stdout, /"runs": 1/);

  const usageRollup = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'llmUsageRollup',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(usageRollup.stdout, /"byOperation":/);
  assert.match(usageRollup.stdout, /"events":/);

  const usageEvents = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listLlmUsageEvents',
      '--scope',
      'repo',
      '--scopeKey',
      'cli-repo',
      '--sessionId',
      'cli-session',
    ],
    { env },
  );
  assert.match(usageEvents.stdout, /\[/);

  const embeddingInventory = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'embeddingInventory',
          '--scope',
          'repo',
          '--scopeKey',
          'cli-repo',
          '--completedJobRetentionDays',
          '7',
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(embeddingInventory.kind, 'embedding_maintenance_inventory');
  assert.equal(embeddingInventory.completedJobRetentionDays, 7);

  const embeddingGc = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'pruneEmbeddingArtifacts',
          '--scope',
          'repo',
          '--scopeKey',
          'cli-repo',
          '--batchSize',
          '5',
          '--includeRetired',
          'false',
          '--confirmMassRetired',
          'false',
          '--includeInventory',
          'false',
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(embeddingGc.kind, 'embedding_maintenance_gc');
  assert.equal(embeddingGc.dryRun, true);
  assert.equal(embeddingGc.batchSize, 5);
  assert.equal(embeddingGc.includeRetired, false);
  assert.equal(embeddingGc.confirmMassRetired, false);
  assert.equal(embeddingGc.includeInventory, false);
});

test('CLI backup, verify, and offline-confirmed restore preserve a verified SQLite snapshot', async () => {
  const dataDir = await makeTempDir();
  const backupDir = await makeTempDir();
  const backupFile = path.join(backupDir, 'contextforge-backup.db');
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };
  const remember = (key) =>
    execFileAsync(
      'node',
      [
        'src/cli.js',
        'remember',
        '--scope',
        'repo',
        '--scopeKey',
        'backup-repo',
        '--key',
        key,
        '--content',
        `Backup fixture ${key}.`,
      ],
      { env },
    );
  await remember('before-backup');

  const backup = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'backupDatabase', '--file', backupFile], { env })).stdout,
  );
  assert.equal(backup.kind, 'contextforge_backup');
  assert.equal(backup.verification.ok, true);
  assert.equal(backup.verification.quickCheck[0], 'ok');
  assert.deepEqual(backup.verification.foreignKeyViolations, []);
  assert.equal((await fs.stat(backupFile)).mode & 0o777, PRIVATE_DATA_FILE_MODE);
  assert.equal((await fs.stat(`${backupFile}.metadata.json`)).mode & 0o777, PRIVATE_DATA_FILE_MODE);

  const verified = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'verifyBackup', '--file', backupFile], { env })).stdout,
  );
  assert.equal(verified.ok, true);
  assert.equal(verified.metadataHashMatches, true);

  const previousBackup = await fs.readFile(backupFile);
  const previousMetadata = await fs.readFile(`${backupFile}.metadata.json`);
  await assert.rejects(
    backupSqliteDatabase({
      dataDir,
      file: backupFile,
      force: true,
      backupRunner: async () => {
        throw new Error('Synthetic backup failure before install.');
      },
    }),
    /Synthetic backup failure/,
  );
  assert.deepEqual(await fs.readFile(backupFile), previousBackup);
  assert.deepEqual(await fs.readFile(`${backupFile}.metadata.json`), previousMetadata);

  const forcedBackup = await backupSqliteDatabase({ dataDir, file: backupFile, force: true });
  assert.equal(forcedBackup.verification.ok, true);
  const forcedVerification = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'verifyBackup', '--file', backupFile], { env })).stdout,
  );
  assert.equal(forcedVerification.ok, true);
  assert.equal(forcedVerification.metadataHashMatches, true);

  const tamperedFile = path.join(backupDir, 'tampered.db');
  await fs.copyFile(backupFile, tamperedFile);
  await fs.writeFile(
    `${tamperedFile}.metadata.json`,
    JSON.stringify({ ...verified.metadata, sha256: '0'.repeat(64) }),
    { mode: 0o600 },
  );
  await assert.rejects(
    execFileAsync('node', ['src/cli.js', 'verifyBackup', '--file', tamperedFile], { env }),
    (error) => {
      const tampered = JSON.parse(error.stdout);
      assert.equal(tampered.ok, false);
      assert.equal(tampered.metadataHashMatches, false);
      return true;
    },
  );

  await remember('after-backup');
  const dryRun = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'restoreDatabase', '--file', backupFile], { env })).stdout,
  );
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.requiresOfflineConfirmation, true);
  await assert.rejects(
    execFileAsync('node', ['src/cli.js', 'restoreDatabase', '--file', backupFile, '--dryRun', 'false'], { env }),
    /confirmOffline=true/,
  );

  const restored = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'restoreDatabase',
          '--file',
          backupFile,
          '--dryRun',
          'false',
          '--confirmOffline',
          'true',
        ],
        { env },
      )
    ).stdout,
  );
  assert.equal(restored.restored, true);
  assert.equal(restored.verification.ok, true);
  assert.ok(restored.preRestoreBackup);
  assert.equal((await fs.stat(restored.preRestoreBackup)).mode & 0o777, PRIVATE_DATA_FILE_MODE);

  const memories = JSON.parse(
    (
      await execFileAsync(
        'node',
        ['src/cli.js', 'listMemories', '--scope', 'repo', '--scopeKey', 'backup-repo'],
        { env },
      )
    ).stdout,
  );
  assert.deepEqual(memories.map((memory) => memory.key), ['before-backup']);

  await assert.rejects(
    execFileAsync('node', ['src/cli.js', 'backupDatabase', '--file', path.join(backupDir, 'wrong.db')], {
      env: {
        ...env,
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: 'http://127.0.0.1:9',
      },
    }),
    /must run on the process that owns the canonical SQLite store/,
  );
});

test('CLI submits, inspects, processes, and cancels durable operation jobs', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };
  const sourceArgs = ['--scope', 'repo', '--scopeKey', 'cli-job-repo', '--sessionId', 'cli-job-session'];
  await execFileAsync(
    'node',
    ['src/cli.js', 'appendRaw', ...sourceArgs, '--role', 'assistant', '--content', 'CLI durable job evidence.'],
    { env },
  );
  const submitted = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'submitDistillJob', ...sourceArgs], { env })).stdout,
  );
  assert.equal(submitted.status, 'queued');
  const listed = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'listJobs', '--status', 'queued'], { env })).stdout,
  );
  assert.equal(listed[0].id, submitted.jobId);
  const processed = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'processJobs', '--workerId', 'cli-worker'], { env })).stdout,
  );
  assert.equal(processed.succeeded, 1);
  const completed = JSON.parse(
    (await execFileAsync('node', ['src/cli.js', 'getJob', '--jobId', submitted.jobId], { env })).stdout,
  );
  assert.equal(completed.status, 'succeeded');

  const cancellable = JSON.parse(
    (
      await execFileAsync(
        'node',
        [
          'src/cli.js',
          'submitDistillJob',
          '--scope',
          'repo',
          '--scopeKey',
          'cli-job-repo',
          '--sessionId',
          'cli-cancel-session',
          '--idempotencyKey',
          'cli-cancel-job',
        ],
        { env },
      )
    ).stdout,
  );
  const cancelled = JSON.parse(
    (
      await execFileAsync(
        'node',
        ['src/cli.js', 'cancelJob', '--jobId', cancellable.jobId, '--reason', 'CLI cancellation test.'],
        { env },
      )
    ).stdout,
  );
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.job.status, 'cancelled');
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

test('capability token matrix is complete and token lifecycle policies fail closed', () => {
  assert.deepEqual(Object.keys(REMOTE_METHOD_CAPABILITIES).sort(), [...REMOTE_METHODS].sort());
  assert.deepEqual(TOKEN_CAPABILITIES, ['read', 'write', 'review', 'operator']);
  const activeSecret = 'active-token-secret-1234';
  const env = {
    ACTIVE_TOKEN: activeSecret,
    REVOKED_TOKEN: 'revoked-token-secret-1234',
    EXPIRED_TOKEN: 'expired-token-secret-1234',
    CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify([
      { id: 'active', tokenEnv: 'ACTIVE_TOKEN', capabilities: ['read'], scopes: ['repo:allowed'] },
      { id: 'revoked', tokenEnv: 'REVOKED_TOKEN', capabilities: ['read'], scopes: ['*:*'], revoked: true },
      {
        id: 'expired',
        tokenEnv: 'EXPIRED_TOKEN',
        capabilities: ['read'],
        scopes: ['*:*'],
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    ]),
  };
  const authorizer = createTokenAuthorizer(env);
  assert.equal(authorizer.authenticate(`Bearer ${activeSecret}`).id, 'active');
  assert.equal(authorizer.authenticate('Bearer revoked-token-secret-1234'), null);
  assert.equal(authorizer.authenticate('Bearer expired-token-secret-1234'), null);
  assert.equal(authorizer.authenticate('Bearer wrong-token-secret-1234'), null);
  assert.deepEqual(authorizer.configuredTokenIds, ['active', 'revoked', 'expired']);
  assert.throws(
    () =>
      createTokenAuthorizer({
        TOKEN_A: 'duplicate-token-secret-1234',
        TOKEN_B: 'duplicate-token-secret-1234',
        CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify([
          { id: 'a', tokenEnv: 'TOKEN_A', capabilities: ['read'], scopes: ['*:*'] },
          { id: 'b', tokenEnv: 'TOKEN_B', capabilities: ['read'], scopes: ['*:*'] },
        ]),
      }),
    /reuses another configured token secret/,
  );
});

test('HTTP capability tokens enforce method and scope boundaries while admin sessions retain full access', async () => {
  const dataDir = await makeTempDir();
  const password = 'capability-admin-password';
  const tokenPolicies = [
    { id: 'reader', tokenEnv: 'READER_TOKEN', capabilities: ['read'], scopes: ['repo:allowed-repo'] },
    {
      id: 'writer',
      tokenEnv: 'WRITER_TOKEN',
      capabilities: ['write'],
      scopes: ['repo:allowed-repo', 'repo:second-allowed'],
    },
    { id: 'operator', tokenEnv: 'OPERATOR_TOKEN', capabilities: ['operator'], scopes: ['*:*'] },
  ];
  const env = {
    CONTEXTFORGE_DATA_DIR: dataDir,
    READER_TOKEN: 'reader-token-secret-1234',
    WRITER_TOKEN: 'writer-token-secret-1234',
    OPERATOR_TOKEN: 'operator-token-secret-1234',
    CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify(tokenPolicies),
    CONTEXTFORGE_ADMIN_USER: 'admin',
    CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
  };
  const remote = await startContextForgeServer({ port: 0, env });
  const call = (token, method, body = {}) =>
    fetch(`${remote.url}/v0/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  try {
    const allowedScope = { scope: 'repo', scopeKey: 'allowed-repo' };
    const written = await call('writer-token-secret-1234', 'remember', {
      ...allowedScope,
      key: 'capability-rule',
      content: 'Capability tokens use least privilege.',
    });
    assert.equal(written.status, 200);
    assert.equal(written.headers.get('x-contextforge-auth-id'), 'writer');

    const read = await call('reader-token-secret-1234', 'getMemory', {
      ...allowedScope,
      key: 'capability-rule',
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('x-contextforge-auth-id'), 'reader');

    for (const body of [
      { ...allowedScope, key: 'blocked-write', content: 'reader cannot write' },
      { scope: 'shared', scopeKey: 'global', key: 'blocked-shared', content: 'repo writer cannot write shared' },
      { scope: 'local', scopeKey: 'machine', key: 'blocked-local', content: 'repo writer cannot write local' },
      { scopeKey: 'other-repo', key: 'blocked-partial-key', content: 'partial scopeKey cannot bypass policy' },
      { scope: 'shared', key: 'blocked-partial-type', content: 'partial scope type cannot bypass policy' },
    ]) {
      const token = body.key === 'blocked-write' ? 'reader-token-secret-1234' : 'writer-token-secret-1234';
      const forbidden = await call(token, 'remember', body);
      assert.equal(forbidden.status, 403);
      const error = await forbidden.json();
      assert.equal(error.error.name, 'ContextForgeAuthorizationError');
      assert.equal(error.error.code, 'CONTEXTFORGE_FORBIDDEN');
    }

    const secondAllowed = await call('writer-token-secret-1234', 'remember', {
      scope: 'repo',
      scopeKey: 'second-allowed',
      key: 'second-allowed-write',
      content: 'Explicitly allowed non-default repo scopes remain usable.',
    });
    assert.equal(secondAllowed.status, 200);

    for (const crossScopeOptions of [
      { ...allowedScope, query: 'shared bypass', includeShared: 'true' },
      { ...allowedScope, query: 'related bypass', relatedScopeKeys: 'another-repo' },
      { ...allowedScope, query: 'workspace bypass', workspaceKey: 'private-workspace' },
    ]) {
      const forbidden = await call('reader-token-secret-1234', 'bootstrapContext', crossScopeOptions);
      assert.equal(forbidden.status, 403);
      assert.equal((await forbidden.json()).error.code, 'CONTEXTFORGE_FORBIDDEN');
    }

    const readerMetrics = await fetch(`${remote.url}/metrics`, {
      headers: { authorization: 'Bearer reader-token-secret-1234' },
    });
    assert.equal(readerMetrics.status, 403);
    const operatorMetrics = await fetch(`${remote.url}/metrics`, {
      headers: { authorization: 'Bearer operator-token-secret-1234' },
    });
    assert.equal(operatorMetrics.status, 200);

    const globalPrune = await call('operator-token-secret-1234', 'pruneRawEvents', {
      ttlDays: 30,
      dryRun: true,
    });
    assert.equal(globalPrune.status, 200);
    const scopedOperatorEnv = {
      ...env,
      SCOPED_OPERATOR_TOKEN: 'scoped-operator-secret-1234',
      CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify([
        ...tokenPolicies,
        {
          id: 'scoped-operator',
          tokenEnv: 'SCOPED_OPERATOR_TOKEN',
          capabilities: ['operator'],
          scopes: ['repo:allowed-repo'],
        },
      ]),
    };
    const scopedAuthorizer = createTokenAuthorizer(scopedOperatorEnv);
    const scopedIdentity = scopedAuthorizer.authenticate('Bearer scoped-operator-secret-1234');
    assert.throws(
      () => scopedAuthorizer.authorize(scopedIdentity, 'pruneRawEvents', {}, { defaultScope: 'repo', defaultScopeKey: 'allowed-repo' }),
      /all-scope token/,
    );

    const unknown = await call('unknown-token-secret-1234', 'dbInfo');
    assert.equal(unknown.status, 401);

    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    const cookie = login.headers.get('set-cookie');
    const adminWrite = await fetch(`${remote.url}/v0/remember`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'shared',
        scopeKey: 'global',
        key: 'admin-full-access',
        content: 'Same-origin admin sessions retain explicit full access.',
      }),
    });
    assert.equal(adminWrite.status, 200);
    assert.equal(adminWrite.headers.get('x-contextforge-auth-id'), 'admin-session');
  } finally {
    await remote.close();
  }
});

test('HTTP MCP and remote client return the same capability denial semantics', async () => {
  const dataDir = await makeTempDir();
  const env = {
    CONTEXTFORGE_DATA_DIR: dataDir,
    READER_TOKEN: 'mcp-reader-token-secret-1234',
    CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify([
      { id: 'mcp-reader', tokenEnv: 'READER_TOKEN', capabilities: ['read'], scopes: ['repo:mcp-allowed'] },
    ]),
  };
  const remote = await startContextForgeServer({ port: 0, env });
  const client = new Client({ name: 'contextforge-capability-mcp-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer mcp-reader-token-secret-1234' } },
  });
  try {
    await client.connect(transport);
    const denied = await client.callTool({
      name: 'remember',
      arguments: {
        scope: 'repo',
        scopeKey: 'mcp-allowed',
        key: 'denied',
        content: 'Read-only MCP tokens cannot write.',
      },
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /requires the write capability/);

    const partialScopeDenied = await client.callTool({
      name: 'search',
      arguments: { scopeKey: 'mcp-other-repo', query: 'partial scope bypass' },
    });
    assert.equal(partialScopeDenied.isError, true);
    assert.match(partialScopeDenied.content[0].text, /not allowed to access repo:mcp-other-repo/);

    const remoteApp = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'mcp-reader-token-secret-1234',
      },
    });
    await assert.rejects(
      remoteApp.remember({
        scope: 'repo',
        scopeKey: 'mcp-allowed',
        key: 'remote-denied',
        content: 'Remote clients preserve structured authorization errors.',
      }),
      (error) =>
        error.status === 403 &&
        error.name === 'ContextForgeAuthorizationError' &&
        error.code === 'CONTEXTFORGE_FORBIDDEN',
    );
  } finally {
    await client.close().catch(() => {});
    await remote.close();
  }
});

test('HTTP authorization injects the approved default scope before core methods can interpret omission as global', async () => {
  let receivedOptions = null;
  const app = {
    config: { defaultScope: 'repo', defaultScopeKey: 'approved-default', defaultSharedScopeKey: 'global' },
    async rebuildEmbeddings(options) {
      receivedOptions = options;
      return { scope: options.scope, scopeType: options.scopeType, scopeKey: options.scopeKey };
    },
  };
  const remote = await startContextForgeServer({
    app,
    port: 0,
    env: {
      SCOPED_OPERATOR_TOKEN: 'default-scope-operator-1234',
      CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify([
        {
          id: 'default-scope-operator',
          tokenEnv: 'SCOPED_OPERATOR_TOKEN',
          capabilities: ['operator'],
          scopes: ['repo:approved-default'],
        },
      ]),
    },
  });
  try {
    const response = await fetch(`${remote.url}/v0/rebuildEmbeddings`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer default-scope-operator-1234',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, {
      scope: 'repo',
      scopeType: 'repo',
      scopeKey: 'approved-default',
    });
    assert.equal(receivedOptions.scopeKey, 'approved-default');
  } finally {
    await remote.close();
  }
});

test('provider usage and durable job metadata record the non-secret API token identity', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir, CONTEXTFORGE_DISTILL_PROVIDER: 'identity_provider' },
    distillProviders: {
      identity_provider: async ({ rawEvents }) => ({
        summaryShort: 'Authorization identity usage fixture.',
        summaryText: rawEvents.map((event) => event.content).join('\n'),
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [],
        sourceEventCount: rawEvents.length,
        metadata: { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } },
      }),
    },
  });
  const env = {
    IDENTITY_TOKEN: 'identity-token-secret-1234',
    CONTEXTFORGE_API_TOKENS_JSON: JSON.stringify([
      {
        id: 'distill-agent',
        tokenEnv: 'IDENTITY_TOKEN',
        capabilities: ['read', 'write'],
        scopes: ['repo:identity-repo'],
      },
    ]),
  };
  const remote = await startContextForgeServer({ app, port: 0, env });
  const call = async (method, body, requestId) => {
    const response = await fetch(`${remote.url}/v0/${method}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer identity-token-secret-1234',
        'content-type': 'application/json',
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text).result;
  };
  const scope = { scope: 'repo', scopeKey: 'identity-repo', sessionId: 'identity-session' };
  try {
    await call('appendRaw', {
      ...scope,
      role: 'assistant',
      content: 'Usage records should name a token id without storing its secret.',
    });
    const submitted = await call('submitDistillJob', scope, 'identity-job-request');
    assert.equal(submitted.job.metadata.authTokenId, 'distill-agent');
    assert.equal(submitted.job.metadata.authKind, 'api-token');
    assert.equal(submitted.job.metadata.requestId, 'identity-job-request');

    await call('distillCheckpoint', scope, 'identity-usage-request');
    const usage = await call('listLlmUsageEvents', { ...scope, limit: 10, page: true });
    assert.equal(usage.items[0].usage._contextforge.authTokenId, 'distill-agent');
    assert.equal(usage.items[0].usage._contextforge.authKind, 'api-token');
    assert.equal(usage.items[0].usage._contextforge.requestId, 'identity-usage-request');
    assert.equal(usage.items[0].usage._contextforge.transport, 'http-api');
    assert.ok(!JSON.stringify(usage).includes('identity-token-secret-1234'));
  } finally {
    await remote.close();
    app.close();
  }
});

test('HTTP health, readiness, metrics, and request correlation expose bounded operations state', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'operations-token',
    },
  });
  try {
    const health = await fetch(`${remote.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const ready = await fetch(`${remote.url}/readyz`, { headers: { 'x-request-id': 'ready-correlation-id' } });
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get('x-request-id'), 'ready-correlation-id');
    const readiness = await ready.json();
    assert.equal(readiness.ready, true);
    assert.equal(readiness.draining, false);
    assert.equal(readiness.checks.database.ok, true);
    assert.equal(readiness.sqlite.journalMode, SQLITE_JOURNAL_MODE);

    const apiHeaders = {
      authorization: 'Bearer operations-token',
      'content-type': 'application/json',
    };
    await fetch(`${remote.url}/v0/appendRaw`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        scope: 'repo',
        scopeKey: 'operations-repo',
        sessionId: 'operations-session',
        role: 'assistant',
        content: 'Correlate request, job, session, and checkpoint operations.',
      }),
    });
    const submitted = await fetch(`${remote.url}/v0/submitDistillJob`, {
      method: 'POST',
      headers: { ...apiHeaders, 'x-request-id': 'job-correlation-id' },
      body: JSON.stringify({
        scope: 'repo',
        scopeKey: 'operations-repo',
        sessionId: 'operations-session',
      }),
    });
    assert.equal(submitted.status, 200);
    const submission = await submitted.json();
    assert.equal(submission.result.job.metadata.requestId, 'job-correlation-id');
    assert.equal(submission.result.job.sessionId, 'operations-session');

    await fetch(`${remote.url}/v0/remember`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        scope: 'repo',
        scopeKey: 'operations-repo',
        key: 'metrics-memory',
        content: 'Retrieval metrics should report bounded candidate scans.',
      }),
    });
    const searched = await fetch(`${remote.url}/v0/search`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        scope: 'repo',
        scopeKey: 'operations-repo',
        query: 'bounded candidate scans',
        includeDiagnostics: true,
      }),
    });
    assert.equal(searched.status, 200);

    const unauthorizedMetrics = await fetch(`${remote.url}/metrics`);
    assert.equal(unauthorizedMetrics.status, 401);
    const metrics = await fetch(`${remote.url}/metrics`, {
      headers: { authorization: 'Bearer operations-token' },
    });
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get('content-type'), /text\/plain/);
    const text = await metrics.text();
    assert.match(text, /contextforge_up 1/);
    assert.match(text, /contextforge_operation_jobs\{status="queued"\} 1/);
    assert.match(text, /contextforge_disk_available_bytes/);
    assert.match(text, /contextforge_retrieval_requests_total 1/);
    assert.match(text, /contextforge_retrieval_scanned_candidates_total 1/);
    assert.ok(!text.includes(dataDir));
  } finally {
    await remote.close();
  }
});

test('HTTP graceful close drains an active request before closing the ContextForge app', async () => {
  let releaseRequest;
  let markStarted;
  let closed = false;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const fakeApp = {
    async dbInfo() {
      markStarted();
      await new Promise((resolve) => {
        releaseRequest = resolve;
      });
      return { ok: true };
    },
    close() {
      closed = true;
    },
  };
  const remote = await startContextForgeServer({ app: fakeApp, port: 0, env: {} });
  const responsePromise = fetch(`${remote.url}/v0/dbInfo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  await started;
  remote.server.beginContextForgeDrain();
  const rejected = await fetch(`${remote.url}/v0/dbInfo`, { method: 'POST', body: '{}' });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).draining, true);
  const closePromise = remote.close({ timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  releaseRequest();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, { ok: true });
  await closePromise;
  assert.equal(closed, true);
});

test('HTTP server serves admin UI assets', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const redirect = await fetch(`${remote.url}/ui`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/ui/');

    const redirectWithQuery = await fetch(`${remote.url}/ui?tab=memory`, { redirect: 'manual' });
    assert.equal(redirectWithQuery.status, 308);
    assert.equal(redirectWithQuery.headers.get('location'), '/ui/?tab=memory');

    const response = await fetch(`${remote.url}/ui/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /ContextForge 관리/);
    assert.match(html, /후보 검토/);
    assert.match(html, /candidateSession/);
    assert.match(html, /후보 backlog 불러오기/);
    assert.match(html, /candidateAuditState/);
    assert.match(html, /CONTEXTFORGE_OPENAI_COMPATIBLE_API_KEY/);

    const script = await fetch(`${remote.url}/ui/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /text\/javascript/);
    const scriptText = await script.text();
    assert.match(scriptText, /memoryCandidateBacklog/);
    assert.match(scriptText, /submitAuditJob/);
    assert.doesNotMatch(scriptText, /GPT-5\.5 감사 결과만 표시/);
    assert.match(scriptText, /구조화 디스틸/);
    assert.match(scriptText, /structured 있음/);
    assert.match(scriptText, /runtime\.warnings/);
    assert.match(scriptText, /error\.code/);

    const stylesheet = await fetch(`${remote.url}/ui/styles.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);

    const favicon = await fetch(`${remote.url}/favicon.ico`);
    assert.equal(favicon.status, 204);
  } finally {
    await remote.close();
  }
});

test('HTTP server accepts admin UI login sessions', async () => {
  const dataDir = await makeTempDir();
  const password = 'hu23bc' + 'CONTEXT!';
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ginishuh', password }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /contextforge_admin=/);
    assert.doesNotMatch(cookie, /;\s*Secure\b/);
    const session = await fetch(`${remote.url}/ui/session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await session.json(), { ok: true, username: 'ginishuh' });
    const info = await fetch(`${remote.url}/v0/dbInfo`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(info.status, 200);
  } finally {
    await remote.close();
  }
});

test('HTTP server ignores spoofed forwarded proto without a trusted proxy', async () => {
  const dataDir = await makeTempDir();
  const password = 'proxy-cookie-CON' + 'TEXT';
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ username: 'ginishuh', password }),
    });
    assert.equal(login.status, 200);
    assert.doesNotMatch(login.headers.get('set-cookie'), /;\s*Secure\b/);
  } finally {
    await remote.close();
  }
});

test('HTTP server auto-secures admin UI cookies behind an explicitly trusted HTTPS proxy', async () => {
  const dataDir = await makeTempDir();
  const password = 'trusted-proxy-cookie-CON' + 'TEXT';
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
      CONTEXTFORGE_TRUST_PROXY: 'loopback',
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ username: 'ginishuh', password }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /;\s*Secure\b/);
  } finally {
    await remote.close();
  }
});

test('HTTP server can force secure admin UI cookies for HTTPS deployments', async () => {
  const dataDir = await makeTempDir();
  const password = 'secure-cookie-CON' + 'TEXT';
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash(password),
      CONTEXTFORGE_ADMIN_COOKIE_SECURE: 'true',
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ginishuh', password }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /;\s*Secure\b/);
  } finally {
    await remote.close();
  }
});

test('HTTP server rejects invalid admin cookie secure mode', async () => {
  const dataDir = await makeTempDir();
  assert.throws(
    () =>
      startContextForgeServer({
        port: 0,
        env: {
          CONTEXTFORGE_DATA_DIR: dataDir,
          CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
          CONTEXTFORGE_ADMIN_COOKIE_SECURE: 'sometimes',
        },
      }),
    /CONTEXTFORGE_ADMIN_COOKIE_SECURE/,
  );
});

test('HTTP server rejects invalid trusted proxy ranges', async () => {
  const dataDir = await makeTempDir();
  assert.throws(
    () =>
      startContextForgeServer({
        port: 0,
        env: {
          CONTEXTFORGE_DATA_DIR: dataDir,
          CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
          CONTEXTFORGE_TRUST_PROXY: '127.0.0.1/99',
        },
      }),
    /CONTEXTFORGE_TRUST_PROXY.*CIDR prefix/,
  );
});

test('HTTP server keeps admin UI login disabled unless credentials are configured', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const login = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ginishuh', password: 'anything' }),
    });
    assert.equal(login.status, 403);
  } finally {
    await remote.close();
  }
});

test('HTTP server rate limits repeated admin UI login failures', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash('correct-password'),
      CONTEXTFORGE_ADMIN_COOKIE_SECURE: 'false',
      CONTEXTFORGE_ADMIN_LOGIN_MAX_FAILURES: '2',
      CONTEXTFORGE_ADMIN_LOGIN_WINDOW_MS: '60000',
    },
  });

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const login = await fetch(`${remote.url}/ui/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
      });
      assert.equal(login.status, 401);
    }

    const limited = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.3',
      },
      body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await remote.close();
  }
});

test('HTTP server uses forwarded client IP only for explicitly trusted proxies', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash('correct-password'),
      CONTEXTFORGE_ADMIN_LOGIN_MAX_FAILURES: '1',
      CONTEXTFORGE_TRUST_PROXY: '127.0.0.0/8',
    },
  });

  try {
    for (const forwardedFor of ['198.51.100.10', '198.51.100.11']) {
      const login = await fetch(`${remote.url}/ui/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': forwardedFor,
        },
        body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
      });
      assert.equal(login.status, 401);
    }

    const limited = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.10',
      },
      body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await remote.close();
  }
});

test('HTTP server falls back to the socket peer for malformed forwarded client chains', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash('correct-password'),
      CONTEXTFORGE_ADMIN_LOGIN_MAX_FAILURES: '1',
      CONTEXTFORGE_TRUST_PROXY: 'loopback',
    },
  });

  try {
    const first = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': 'not-an-ip',
      },
      body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
    });
    assert.equal(first.status, 401);

    const limited = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': 'also-not-an-ip',
      },
      body: JSON.stringify({ username: 'ginishuh', password: 'wrong-password' }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await remote.close();
  }
});

test('HTTP server fails closed when the failed-login key cap is exhausted', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash('correct-password'),
      CONTEXTFORGE_ADMIN_LOGIN_MAX_FAILURES: '2',
      CONTEXTFORGE_ADMIN_LOGIN_MAX_KEYS: '2',
      CONTEXTFORGE_ADMIN_LOGIN_WINDOW_MS: '60000',
    },
  });

  try {
    for (const username of ['first', 'second']) {
      const login = await fetch(`${remote.url}/ui/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'wrong-password' }),
      });
      assert.equal(login.status, 401);
    }

    const overflow = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'third', password: 'wrong-password' }),
    });
    assert.equal(overflow.status, 429);

    const existing = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'first', password: 'wrong-password' }),
    });
    assert.equal(existing.status, 401);
  } finally {
    await remote.close();
  }
});

test('HTTP server sweeps expired failed-login keys before enforcing the key cap', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_ADMIN_USER: 'ginishuh',
      CONTEXTFORGE_ADMIN_PASSWORD_PBKDF2: testAdminPasswordHash('correct-password'),
      CONTEXTFORGE_ADMIN_LOGIN_MAX_FAILURES: '2',
      CONTEXTFORGE_ADMIN_LOGIN_MAX_KEYS: '1',
      CONTEXTFORGE_ADMIN_LOGIN_WINDOW_MS: '1',
    },
  });

  try {
    const first = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'first', password: 'wrong-password' }),
    });
    assert.equal(first.status, 401);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterExpiry = await fetch(`${remote.url}/ui/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'second', password: 'wrong-password' }),
    });
    assert.equal(afterExpiry.status, 401);
  } finally {
    await remote.close();
  }
});

test('MCP streamable HTTP endpoint rejects missing bearer auth', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });
  const client = new Client({ name: 'contextforge-http-unauthorized-client', version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`));

  try {
    await assert.rejects(() => client.connect(transport), /Unauthorized|Streamable HTTP error|401/);
  } finally {
    await client.close().catch(() => {});
    await remote.close();
  }
});
