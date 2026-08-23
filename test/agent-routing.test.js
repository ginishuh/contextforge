import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  appendSyntheticCodexAssistantMessage,
  makeGitRepo,
  writeSyntheticClaudeCodeTranscript,
  writeSyntheticCodexRollout,
  writeSyntheticCursorTranscript,
  writeSyntheticGrokChatHistory,
  writeSyntheticOpenCodeDb,
} from './helpers/fixtures.js';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import {
  ingestAgentRoutedSessions,
  ingestAgentSessions,
  listAgentAdapters,
  watchAgentRoutedSessions,
} from '../src/ingest/agents.js';

const execFileAsync = promisify(execFile);

test('agent adapter registry exposes the built-in multi-agent ingest set', () => {
  assert.deepEqual(
    listAgentAdapters()
      .map((adapter) => adapter.id)
      .sort(),
    ['claude_code', 'codex', 'cursor_cli', 'grok', 'opencode'],
  );
});

test('multi-agent routed ingest shares repo scope while preserving source provenance', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const claudeCodeProjectsDir = path.join(root, 'claude');
  const grokSessionsDir = path.join(root, 'grok');
  const cursorProjectsDir = path.join(root, 'cursor');
  const opencodeDb = path.join(root, 'opencode', 'opencode.db');

  await fs.mkdir(path.join(codexSessionsDir, '2026', '06', '04'), { recursive: true });
  await writeSyntheticCodexRollout(
    path.join(codexSessionsDir, '2026', '06', '04', 'rollout-codex.jsonl'),
    'registry-codex',
    repo,
  );
  await fs.mkdir(path.join(claudeCodeProjectsDir, 'project-a'), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(
    path.join(claudeCodeProjectsDir, 'project-a', 'claude.jsonl'),
    'registry-claude',
    repo,
  );
  await writeSyntheticGrokChatHistory(grokSessionsDir, 'registry-grok', repo);
  await writeSyntheticCursorTranscript(cursorProjectsDir, 'registry-cursor');
  await writeSyntheticOpenCodeDb(opencodeDb, 'registry-opencode', repo);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'shared-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/shared-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_DISTILL_PROVIDER: 'candidate_provider',
    },
    cwd: process.cwd(),
    distillProviders: {
      candidate_provider: async (input) => ({
        provider: 'candidate_provider',
        summaryShort: `Candidate checkpoint for ${input.session.sessionId}.`,
        summaryText: `Multi-agent candidate checkpoint for ${input.session.sessionId}.`,
        workingSummary: `Working summary for ${input.session.sessionId}.`,
        decisions: [],
        todos: [],
        openQuestions: [],
        memoryCandidates: [
          {
            key: `multi_agent.${input.session.sessionId.replace(/[^a-z0-9]+/gi, '_')}`,
            content: 'ContextForge multi-agent ingest keeps origin provenance while sharing repo-scoped handoff.',
            reason: 'This is a stable cross-agent ingest contract.',
            category: 'architecture',
            tags: ['multi-agent', 'ingest'],
            importance: 1,
            candidateType: 'architecture_decision',
            confidence: 0.9,
            stability: 0.9,
            sensitivity: 'low',
            promotionRecommendation: 'promote',
          },
        ],
        sourceEventCount: input.rawEvents.length,
        metadata: {},
      }),
    },
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'codex,claude_code,grok,cursor_cli,opencode',
    codexSessionsDir,
    claudeCodeProjectsDir,
    grokSessionsDir,
    cursorProjectsDir,
    opencodeDb,
    repoRegistry: registryPath,
    cwd: repo,
    distill: 'always',
  });

  assert.equal(result.source, 'agent_sessions_router');
  assert.deepEqual(result.adapters, ['codex', 'claude_code', 'grok', 'cursor_cli', 'opencode']);
  assert.equal(result.filesScanned, 5);
  assert.equal(result.routedFiles, 5);
  assert.equal(result.appendedEvents, 10);
  assert.equal(result.checkpointsCreated, 5);
  const opencodeResult = result.adapterResults.find((adapterResult) => adapterResult.adapter === 'opencode');
  assert.equal(opencodeResult.stateLoaded, false);
  assert.equal(opencodeResult.stateUpdated, false);
  assert.equal(opencodeResult.corruptStateFile, null);
  assert.deepEqual(
    result.adapterResults.map((adapterResult) => [adapterResult.adapter, adapterResult.routedFiles]).sort(),
    [
      ['claude_code', 1],
      ['codex', 1],
      ['cursor_cli', 1],
      ['grok', 1],
      ['opencode', 1],
    ],
  );

  for (const [sessionId, sourceAgent] of [
    ['codex:registry-codex', 'codex'],
    ['claude_code:registry-claude', 'claude_code'],
    ['grok:registry-grok', 'grok'],
    ['cursor_cli:registry-cursor', 'cursor_cli'],
    ['opencode:registry-opencode', 'opencode'],
  ]) {
    const events = app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/shared-repo',
      sessionId,
    });
    assert.equal(events.length, 2, sessionId);
    assert.ok(events.every((event) => event.metadata.sourceAgent === sourceAgent), sessionId);
    assert.ok(events.every((event) => event.metadata.nativeSessionId), sessionId);
  }

  const opencodeCandidates = app.listMemoryCandidates({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    sessionId: 'opencode:registry-opencode',
    status: 'pending',
  });
  assert.equal(opencodeCandidates.length, 1);
  assert.equal(opencodeCandidates[0].source.sourceAgent, 'opencode');
  assert.equal(opencodeCandidates[0].source.sourceProvenance.sourceAdapter, 'opencode_sqlite');

  const suggestions = await app.suggestMemoryPromotions({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    sessionId: 'opencode:registry-opencode',
    trigger: 'manual_closeout',
  });
  assert.equal(suggestions.proposals.length, 1);
  assert.equal(suggestions.proposals[0].evidence.sourceAgent, 'opencode');
  assert.equal(suggestions.proposals[0].evidence.sourceProvenance.sourceRuntime, 'opencode_cli');

  const bootstrap = await app.bootstrapContext({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    query: 'multi agent handoff',
    latestCheckpointLimit: 1,
  });
  assert.deepEqual(Object.keys(bootstrap.handoff.latestByAgent).sort(), [
    'claude_code',
    'codex',
    'cursor_cli',
    'grok',
    'opencode',
  ]);
  assert.equal(bootstrap.handoff.latestByAgent.codex.sourceProvenance.sourceAgent, 'codex');
  assert.equal(bootstrap.handoff.latestByAgent.opencode.sourceProvenance.sourceAdapter, 'opencode_sqlite');
  assert.equal(bootstrap.handoff.latestCheckpoints.length, 1);
  const resume = await app.syncResumeContext({
    scope: 'repo',
    scopeKey: 'github.com/example/shared-repo',
    sessionId: 'opencode:registry-opencode',
    query: 'multi agent handoff',
  });
  assert.equal(resume.handoff.memoryCandidates.items[0].sourceAgent, 'opencode');
  assert.equal(resume.handoff.memoryCandidates.items[0].sourceProvenance.sourceAdapter, 'opencode_sqlite');
});

test('multi-agent routed ingest matches temporary checkouts by git remote scopeKey', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const canonicalRepo = await makeTempDir();
  const reviewCheckout = await makeGitRepo('git@github.com:example/shared-repo.git');
  const opencodeDb = path.join(root, 'opencode', 'opencode.db');
  await writeSyntheticOpenCodeDb(opencodeDb, 'opencode-review-checkout', reviewCheckout);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'shared-repo',
          repoPath: canonicalRepo,
          scopeKey: 'github.com/example/shared-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'opencode',
    opencodeDb,
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.equal(result.adapters[0], 'opencode');
  assert.equal(result.routedFiles, 1);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.appendedEvents, 2);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'github.com/example/shared-repo');
  assert.equal(result.adapterResults[0].fileResults[0].cwd, undefined);
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/shared-repo',
      sessionId: 'opencode:opencode-review-checkout',
    }).length,
    2,
  );
});

test('multi-agent routed ingest keeps nested namespace git remotes distinct', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repoA = await makeTempDir();
  const repoB = await makeTempDir();
  const reviewCheckout = await makeGitRepo('git@gitlab.com:group/subgroup/repo-b.git');
  const opencodeDb = path.join(root, 'opencode', 'opencode.db');
  await writeSyntheticOpenCodeDb(opencodeDb, 'opencode-nested-namespace', reviewCheckout);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: repoA,
          scopeKey: 'gitlab.com/group/subgroup/repo-a',
        },
        {
          name: 'repo-b',
          repoPath: repoB,
          scopeKey: 'gitlab.com/group/subgroup/repo-b',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'opencode',
    opencodeDb,
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.equal(result.routedFiles, 1);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'gitlab.com/group/subgroup/repo-b');
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'gitlab.com/group/subgroup/repo-a',
      sessionId: 'opencode:opencode-nested-namespace',
    }).length,
    0,
  );
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'gitlab.com/group/subgroup/repo-b',
      sessionId: 'opencode:opencode-nested-namespace',
    }).length,
    2,
  );
});

test('Cursor CLI routed ingest matches temporary checkouts by git remote scopeKey', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const canonicalRepo = await makeTempDir();
  const reviewCheckout = await makeGitRepo('https://github.com/example/cursor-repo.git');
  const cursorProjectsDir = path.join(root, 'cursor');
  await writeSyntheticCursorTranscript(cursorProjectsDir, 'cursor-review-checkout', 'unmatched-review-project');

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'cursor-repo',
          repoPath: canonicalRepo,
          scopeKey: 'github.com/example/cursor-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'cursor_cli',
    cursorProjectsDir,
    repoRegistry: registryPath,
    cwd: reviewCheckout,
    distill: 'never',
  });

  assert.equal(result.routedFiles, 1);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'github.com/example/cursor-repo');
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/cursor-repo',
      sessionId: 'cursor_cli:cursor-review-checkout',
    }).length,
    2,
  );
});

test('Cursor CLI routed ingest matches project names without lossy path decoding', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = path.join(root, 'repo-with-hyphen');
  await fs.mkdir(repo, { recursive: true });
  const cursorProjectsDir = path.join(root, 'cursor');
  const cursorProjectName = repo
    .split(path.sep)
    .filter(Boolean)
    .join('-');
  await writeSyntheticCursorTranscript(cursorProjectsDir, 'cursor-hyphen-session', cursorProjectName);
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'hyphen-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/repo-with-hyphen',
          adapters: ['cursor_cli'],
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    adapters: 'cursor_cli',
    cursorProjectsDir,
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.equal(result.routedFiles, 1);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.appendedEvents, 2);
  assert.equal(result.adapterResults[0].fileResults[0].matchedRepo.scopeKey, 'github.com/example/repo-with-hyphen');
  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/repo-with-hyphen',
    sessionId: 'cursor_cli:cursor-hyphen-session',
  });
  assert.equal(events.length, 2);
});

test('multi-agent routed ingest auto-detects installed adapters for one-shot scans', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const rolloutDir = path.join(codexSessionsDir, '2026', '06', '04');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-one-shot.jsonl'), 'one-shot-codex', repo);
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'one-shot-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/one-shot-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await ingestAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: path.join(root, 'missing-claude'),
    grokSessionsDir: path.join(root, 'missing-grok'),
    cursorProjectsDir: path.join(root, 'missing-cursor'),
    opencodeDb: path.join(root, 'missing-opencode', 'opencode.db'),
    repoRegistry: registryPath,
    distill: 'never',
  });

  assert.deepEqual(result.adapters, ['codex']);
  assert.equal(result.inactiveAdapters.length, 4);
  assert.equal(result.filesScanned, 1);
  assert.equal(result.appendedEvents, 2);
});

test('OpenCode adapter rejects ambiguous --file ingest', async () => {
  const dataDir = await makeTempDir();
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  await assert.rejects(
    () =>
      ingestAgentSessions(app, {
        adapters: 'opencode',
        file: '/tmp/not-a-session-file',
        scope: 'repo',
        scopeKey: 'github.com/example/opencode-file',
        distill: 'never',
      }),
    /--file is not supported for opencode/,
  );
});

test('multi-agent routed watch isolates bad units and continues ingesting good files', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const rolloutDir = path.join(codexSessionsDir, '2026', '06', '04');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-good.jsonl'), 'isolated-good-codex', repo);
  await fs.writeFile(
    path.join(rolloutDir, 'rollout-bad.jsonl'),
    `${JSON.stringify({
      timestamp: '2026-04-25T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'This file has no session metadata.' }],
      },
    })}\n`,
  );
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'watch-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/isolated-watch-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await watchAgentRoutedSessions(app, {
    adapters: 'codex',
    codexSessionsDir,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.equal(result.totals.filesScanned, 2);
  assert.equal(result.totals.appendedEvents, 2);
  const fileResults = result.results[0].adapterResults[0].fileResults;
  assert.equal(fileResults.some((fileResult) => fileResult.skippedReason === 'unit_error'), true);
  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/isolated-watch-repo',
    sessionId: 'codex:isolated-good-codex',
  });
  assert.equal(events.length, 2);
});

test('multi-agent routed watch auto-detects installed adapters and uses incremental state', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const codexSessionsDir = path.join(root, 'codex');
  const missingClaudeCodeProjectsDir = path.join(root, 'missing-claude');
  const missingGrokSessionsDir = path.join(root, 'missing-grok');
  const missingCursorProjectsDir = path.join(root, 'missing-cursor');
  const missingOpenCodeDb = path.join(root, 'missing-opencode', 'opencode.db');
  const rolloutDir = path.join(codexSessionsDir, '2026', '06', '04');
  const rolloutFile = path.join(rolloutDir, 'rollout-unified-watch.jsonl');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(rolloutFile, 'unified-watch-codex', repo);

  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'watch-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/watch-repo',
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const first = await watchAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: missingClaudeCodeProjectsDir,
    grokSessionsDir: missingGrokSessionsDir,
    cursorProjectsDir: missingCursorProjectsDir,
    opencodeDb: missingOpenCodeDb,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.deepEqual(first.adapters, ['codex']);
  assert.deepEqual(
    first.inactiveAdapters.map((adapter) => [adapter.adapter, adapter.reason]).sort(),
    [
      ['claude_code', 'missing_root'],
      ['cursor_cli', 'missing_root'],
      ['grok', 'missing_root'],
      ['opencode', 'missing_root'],
    ],
  );
  assert.equal(first.totals.filesScanned, 1);
  assert.equal(first.totals.appendedEvents, 2);
  assert.equal(first.results[0].stateLoaded, false);
  assert.equal(first.results[0].stateUpdated, true);
  assert.equal(first.results[0].adapterStateLoadedCount, 0);
  assert.equal(first.results[0].adapterStateUpdatedCount, 1);
  assert.equal(first.results[0].adapterResults[0].stateUpdated, true);

  const second = await watchAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: missingClaudeCodeProjectsDir,
    grokSessionsDir: missingGrokSessionsDir,
    cursorProjectsDir: missingCursorProjectsDir,
    opencodeDb: missingOpenCodeDb,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.deepEqual(second.adapters, ['codex']);
  assert.equal(second.totals.filesScanned, 1);
  assert.equal(second.totals.filesChanged, 0);
  assert.equal(second.totals.appendedEvents, 0);
  assert.equal(second.results[0].stateLoaded, true);
  assert.equal(second.results[0].stateUpdated, false);
  assert.equal(second.results[0].adapterStateLoadedCount, 1);
  assert.equal(second.results[0].adapterStateUpdatedCount, 0);
  assert.equal(second.results[0].adapterResults[0].stateLoaded, true);

  await fs.appendFile(rolloutFile, '{"malformed":\n');
  await appendSyntheticCodexAssistantMessage(rolloutFile, 'Recovered after a malformed complete JSONL line.');
  const third = await watchAgentRoutedSessions(app, {
    codexSessionsDir,
    claudeCodeProjectsDir: missingClaudeCodeProjectsDir,
    grokSessionsDir: missingGrokSessionsDir,
    cursorProjectsDir: missingCursorProjectsDir,
    opencodeDb: missingOpenCodeDb,
    repoRegistry: registryPath,
    watchStateDir,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.equal(third.totals.filesChanged, 1);
  assert.equal(third.totals.appendedEvents, 1);
  assert.equal(
    third.results[0].adapterResults[0].fileResults[0].warnings.some(
      (warning) => warning.type === 'malformed_json_line',
    ),
    true,
  );

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/watch-repo',
    sessionId: 'codex:unified-watch-codex',
  });
  assert.equal(events.length, 3);
});

test('multi-agent routed watch reports explicitly requested missing adapters without scanning files', async () => {
  const dataDir = await makeTempDir();
  const root = await makeTempDir();
  const repo = await makeTempDir();
  const missingCursorProjectsDir = path.join(root, 'missing-cursor');
  const registryPath = path.join(root, 'repos.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'watch-repo',
          repoPath: repo,
          scopeKey: 'github.com/example/watch-repo',
          adapters: ['cursor_cli'],
        },
      ],
    }),
  );
  const app = createContextForge({
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
    },
    cwd: process.cwd(),
  });

  const result = await watchAgentRoutedSessions(app, {
    adapters: 'cursor_cli',
    cursorProjectsDir: missingCursorProjectsDir,
    repoRegistry: registryPath,
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchVerbose: true,
  });

  assert.deepEqual(result.adapters, ['cursor_cli']);
  assert.equal(result.inactiveAdapters.length, 0);
  assert.equal(result.totals.filesScanned, 0);
  assert.equal(result.results[0].adapterResults[0].skippedAdapter, true);
  assert.equal(result.results[0].adapterResults[0].skippedReason, 'missing_root');
});

test('repoPath ingest skips Claude Code transcripts from other working directories', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const targetRepo = await makeGitRepo('https://github.com/example/claude-filter-target.git');
  const otherDir = await makeTempDir();
  const file = path.join(otherDir, 'claude-outside.jsonl');
  await writeSyntheticClaudeCodeTranscript(file, 'claude-outside-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'ingestClaudeCodeFile',
      '--file',
      file,
      '--scope',
      'repo',
      '--repoPath',
      targetRepo,
      '--distill',
      'never',
    ],
    { cwd: projectsDir, env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.skippedReason, 'cwd_outside_repo_path');
  assert.equal(parsed.appendedEvents, 0);
});
