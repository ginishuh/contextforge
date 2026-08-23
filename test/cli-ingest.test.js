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
  writeSyntheticSessionsTree,
} from './helpers/fixtures.js';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { shouldSkipRecentFailedAutoDistill } from '../src/ingest/common.js';
import { watchClaudeCodeSessions } from '../src/ingest/claude_code.js';
import { ingestCodexRolloutFile, watchCodexSessions } from '../src/ingest/codex.js';
import { startContextForgeServer } from '../src/server.js';

const execFileAsync = promisify(execFile);

test('CLI accepts repoPath for repo-scoped memory', async () => {
  const dataDir = await makeTempDir();
  const appCwd = await makeTempDir();
  const repoPath = await makeGitRepo('git@github.com:example/cli-repo.git');
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  const remembered = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'remember',
      '--scope',
      'repo',
      '--repoPath',
      repoPath,
      '--key',
      'repo-path-cli',
      '--content',
      'CLI repoPath resolves repo scope.',
    ],
    { cwd: appCwd, env },
  );
  assert.match(remembered.stdout, /"scopeKey": "github.com\/example\/cli-repo"/);
});

test('Codex watch service installer pins explicit repo scope key', async () => {
  const home = await makeTempDir();
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  await execFileAsync(
    'bash',
    [
      'scripts/install-codex-watch-service.sh',
      '--name',
      'scope-test',
      '--repo-path',
      '/work/repo',
      '--scope-key',
      'github.com/example/repo',
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-codex-watch-scope-test.service'),
    'utf8',
  );
  assert.match(unit, /--repoPath \/work\/repo --scopeKey github\.com\/example\/repo/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
});

test('Codex watch service installer reports and pins inferred repo scope key', async () => {
  const home = await makeTempDir();
  const repoPath = await makeGitRepo('https://github.com/example/inferred-watch-repo.git');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-codex-watch-service.sh',
      '--name',
      'inferred-scope-test',
      '--repo-path',
      repoPath,
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-codex-watch-inferred-scope-test.service'),
    'utf8',
  );
  assert.match(result.stdout, /Resolved repo scope key: github\.com\/example\/inferred-watch-repo/);
  assert.match(unit, /--scopeKey github\.com\/example\/inferred-watch-repo/);
});

test('Codex watch service installer rejects non-canonical repo scope keys', async () => {
  const home = await makeTempDir();

  await assert.rejects(
    () =>
      execFileAsync(
        'bash',
        [
          'scripts/install-codex-watch-service.sh',
          '--name',
          'scope-test',
          '--repo-path',
          '/work/repo',
          '--scope-key',
          'github.com/example/my repo',
          '--remote-url',
          'https://memory.example.com',
          '--token-env-file',
          path.join(home, 'token.env'),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
          },
        },
      ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--scope-key must be a canonical key/);
      return true;
    },
  );
});

test('Codex router service installer creates an agent-level router unit', async () => {
  const home = await makeTempDir();
  const registryPath = path.join(home, 'repos.json');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: '/work/repo-a',
          scopeKey: 'github.com/example/repo-a',
          adapters: ['codex'],
        },
        {
          name: 'repo-b',
          repoPath: '/work/repo-b',
          scopeKey: 'github.com/example/repo-b',
          adapters: ['claude_code'],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-codex-router-service.sh',
      '--name',
      'codex',
      '--repo-registry',
      registryPath,
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-codex-router-codex.service'),
    'utf8',
  );
  assert.match(result.stdout, /Installed codex agent router unit:/);
  assert.match(result.stdout, /Enabled Codex repos: 1/);
  assert.match(unit, /ingestCodexRoutedSessions/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
  assert.match(unit, new RegExp(`--repoRegistry ${registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(unit, /--repoPath/);
});

test('Claude Code router service installer creates an agent-level router unit', async () => {
  const home = await makeTempDir();
  const registryPath = path.join(home, 'repos.json');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: '/work/repo-a',
          scopeKey: 'github.com/example/repo-a',
          adapters: ['claude_code'],
        },
        {
          name: 'repo-b',
          repoPath: '/work/repo-b',
          scopeKey: 'github.com/example/repo-b',
          adapters: ['codex'],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-claude-code-router-service.sh',
      '--name',
      'claude-code',
      '--repo-registry',
      registryPath,
      '--remote-url',
      'https://memory.example.com',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-claude-code-router-claude-code.service'),
    'utf8',
  );
  assert.match(result.stdout, /Installed claude_code agent router unit:/);
  assert.match(result.stdout, /Enabled Claude Code repos: 1/);
  assert.match(unit, /ingestClaudeCodeRoutedSessions/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
  assert.match(unit, new RegExp(`--repoRegistry ${registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(unit, /--repoPath/);
});

test('unified agent router service installer creates one auto-detecting router unit', async () => {
  const homeRoot = await makeTempDir();
  const home = path.join(homeRoot, 'home with spaces');
  await fs.mkdir(home, { recursive: true });
  const registryPath = path.join(home, 'repos.json');
  const fakeBin = path.join(home, 'bin');
  const systemctlLog = path.join(home, 'systemctl.log');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      repos: [
        {
          name: 'repo-a',
          repoPath: '/work/repo-a',
          scopeKey: 'github.com/example/repo-a',
        },
        {
          name: 'repo-b',
          repoPath: '/work/repo-b',
          scopeKey: 'github.com/example/repo-b',
          adapters: ['cursor_cli'],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`,
    { mode: 0o755 },
  );

  const result = await execFileAsync(
    'bash',
    [
      'scripts/install-agent-router-service.sh',
      '--name',
      'all-agents',
      '--repo-registry',
      registryPath,
      '--remote-url',
      'https://memory.example.com/api?token=abc$def',
      '--token-env-file',
      path.join(home, 'token.env'),
      '--codex-sessions-dir',
      path.join(home, 'codex $sessions'),
      '--distill',
      'false',
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );

  const unit = await fs.readFile(
    path.join(home, '.config', 'systemd', 'user', 'contextforge-agent-router-all-agents.service'),
    'utf8',
  );
  assert.match(result.stdout, /Installed unified agent router unit:/);
  assert.match(result.stdout, /Enabled repos: 2/);
  assert.match(result.stdout, /Requested adapters: auto-detect installed adapters/);
  assert.match(unit, /ingestAgentRoutedSessions/);
  assert.doesNotMatch(unit, /--adapters/);
  assert.match(unit, new RegExp(`WorkingDirectory=${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(unit, new RegExp(`EnvironmentFile=-${path.join(home, 'token.env').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(unit, /CONTEXTFORGE_REMOTE_URL=/);
  assert.match(unit, /--codexSessionsDir/);
  assert.match(unit, new RegExp(`--codexSessionsDir "${path.join(home, 'codex $$sessions').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(unit, /--claudeCodeProjectsDir/);
  assert.match(unit, /--opencodeDb/);
  assert.match(unit, /--grokSessionsDir/);
  assert.match(unit, /--cursorProjectsDir/);
  assert.match(unit, /Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h\/\.local\/state\/contextforge\/watch/);
  assert.match(unit, new RegExp(`--repoRegistry "${registryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('CLI reports invalid metadata JSON clearly', async () => {
  const dataDir = await makeTempDir();
  const env = { ...process.env, CONTEXTFORGE_DATA_DIR: dataDir };

  await assert.rejects(
    () =>
      execFileAsync(
      'node',
      [
      path.resolve('src/cli.js'),
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
          'Invalid metadata should fail clearly.',
          '--metadata',
          '{bad',
        ],
        { env },
      ),
    /Invalid --metadata JSON/,
  );
});

test('CLI ingests Codex rollout JSONL idempotently without capturing developer messages', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-ingest-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
    CONTEXTFORGE_DEFAULT_SCOPE_KEY: 'codex-ingest-repo',
  };

  const first = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-ingest-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.parsedEvents, 2);
  assert.equal(firstResult.appendedEvents, 2);
  assert.equal(firstResult.skippedEvents, 0);
  assert.equal(firstResult.status.rawEventCount, 2);

  const second = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-ingest-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.appendedEvents, 0);
  assert.equal(secondResult.skippedEvents, 2);
  assert.equal(secondResult.status.rawEventCount, 2);

  const rawEvents = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listRawEvents',
      '--scope',
      'repo',
      '--scopeKey',
      'codex-ingest-repo',
      '--sessionId',
      'codex:codex-ingest-session',
    ],
    { env },
  );
  const events = JSON.parse(rawEvents.stdout);
  assert.deepEqual(
    events.map((event) => event.role),
    ['user', 'assistant'],
  );
  assert.equal(events.some((event) => event.content.includes('Developer instructions')), false);
  assert.ok(events.every((event) => event.metadata.ingestId));
  assert.ok(events.every((event) => event.metadata.sourceAgent === 'codex'));
  assert.ok(events.every((event) => event.metadata.sourceRuntime === 'codex_tui'));
  assert.ok(events.every((event) => event.metadata.sourceAdapter === 'codex_rollout_jsonl'));
  assert.ok(events.every((event) => event.metadata.nativeSessionId === 'codex-ingest-session'));
  assert.equal(firstResult.sessionId, 'codex:codex-ingest-session');
});

test('CLI ingest can auto-distill Codex rollout evidence', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-auto-distill-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
    CONTEXTFORGE_DEFAULT_SCOPE_KEY: 'codex-auto-distill-repo',
    CONTEXTFORGE_DISTILL_PROVIDER: 'mock',
  };

  const ingested = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-auto-distill-repo',
      '--distill',
      'auto',
      '--charThreshold',
      '1',
    ],
    { env },
  );
  const result = JSON.parse(ingested.stdout);
  assert.equal(result.appendedEvents, 2);
  assert.equal(result.status.shouldDistill, true);
  assert.equal(result.checkpoint.sessionId, 'codex:codex-auto-distill-session');
  assert.equal(result.checkpoint.provider, 'mock');
  assert.deepEqual(result.checkpoint.metadata.sourceProvenance, {
    sourceAgent: 'codex',
    sourceRuntime: 'codex_tui',
    sourceAdapter: 'codex_rollout_jsonl',
    nativeSessionId: 'codex-auto-distill-session',
  });

  const app = createContextForge({ env, cwd: process.cwd() });
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'codex-auto-distill-repo',
    sessionId: 'codex:codex-auto-distill-session',
  });
  assert.deepEqual(runs[0].inputMetadata.sourceProvenance, result.checkpoint.metadata.sourceProvenance);
});

test('Codex ingest preserves raw evidence when auto distill fails', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-auto-fail-session');
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

  const result = await ingestCodexRolloutFile(app, {
    file,
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    distill: 'auto',
    charThreshold: 1,
  });

  assert.equal(result.appendedEvents, 2);
  assert.equal(result.checkpoint, null);
  assert.match(result.checkpointError.message, /synthetic provider failure/);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    sessionId: 'codex:codex-auto-fail-session',
  });
  assert.equal(events.length, 2);
  const runs = app.listDistillRuns({
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    sessionId: 'codex:codex-auto-fail-session',
  });
  assert.equal(runs[0].status, 'failed');

  const retry = await ingestCodexRolloutFile(app, {
    file,
    scope: 'repo',
    scopeKey: 'codex-auto-fail-repo',
    distill: 'auto',
    charThreshold: 1,
  });
  assert.equal(retry.appendedEvents, 0);
  assert.equal(retry.checkpointSkippedReason, 'recent_failed_distill');
  assert.equal(
    app.listDistillRuns({
      scope: 'repo',
      scopeKey: 'codex-auto-fail-repo',
      sessionId: 'codex:codex-auto-fail-session',
    }).length,
    1,
  );
});

test('recent failed auto distill suppression uses the newest run', async () => {
  const skip = await shouldSkipRecentFailedAutoDistill(
    {
      listDistillRuns: async () => [
        {
          status: 'succeeded',
          createdAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          status: 'failed',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
    },
    { scope: 'repo', scopeKey: 'repo-failed-distill' },
    'session-failed-distill',
    { thresholds: { minIntervalMs: 600000 } },
  );

  assert.equal(skip, true);
});

test('CLI ingest works through remote storage mode', async () => {
  const dataDir = await makeTempDir();
  const rolloutDir = await makeTempDir();
  const file = path.join(rolloutDir, 'rollout.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-remote-ingest-session');
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const env = {
      ...process.env,
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: remote.url,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    };
    const ingested = await execFileAsync(
      'node',
      [
        'src/cli.js',
        'ingestCodexRollout',
        '--file',
        file,
        '--scope',
        'repo',
        '--scopeKey',
        'codex-remote-ingest-repo',
        '--distill',
        'never',
      ],
      { env },
    );
    const result = JSON.parse(ingested.stdout);
    assert.equal(result.appendedEvents, 2);
    assert.equal(result.status.rawEventCount, 2);

    const app = createContextForge({ env, cwd: process.cwd() });
    const rawEvents = await app.listRawEvents({
      scope: 'repo',
      scopeKey: 'codex-remote-ingest-repo',
      sessionId: 'codex:codex-remote-ingest-session',
    });
    assert.equal(rawEvents.length, 2);
  } finally {
    await remote.close();
  }
});

test('CLI ingests multiple Codex session rollout files safely', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  await writeSyntheticSessionsTree(sessionsDir);
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const first = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexSessions',
      '--sessionsDir',
      sessionsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-multi-session-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.filesScanned, 2);
  assert.equal(firstResult.parsedEvents, 4);
  assert.equal(firstResult.appendedEvents, 4);
  assert.equal(firstResult.skippedEvents, 0);
  assert.deepEqual(
    firstResult.fileResults.map((result) => result.sessionId).sort(),
    ['codex:codex-session-first', 'codex:codex-session-second'],
  );
  assert.equal(firstResult.fileResults.some((result) => result.warnings.length > 0), true);

  const second = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexSessions',
      '--sessionsDir',
      sessionsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-multi-session-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.filesScanned, 2);
  assert.equal(secondResult.appendedEvents, 0);
  assert.equal(secondResult.skippedEvents, 4);

  const app = createContextForge({ env, cwd: process.cwd() });
  const firstEvents = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-multi-session-repo',
    sessionId: 'codex:codex-session-first',
  });
  const secondEvents = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-multi-session-repo',
    sessionId: 'codex:codex-session-second',
  });
  assert.equal(firstEvents.length, 2);
  assert.equal(secondEvents.length, 2);
});

test('repoPath ingest skips Codex session files from other working directories', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const otherRepo = await makeTempDir();
  const targetRepo = await makeGitRepo('https://github.com/example/filter-target.git');
  const file = path.join(otherRepo, 'rollout-outside.jsonl');
  await writeSyntheticCodexRollout(file, 'codex-outside-session');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      path.resolve('src/cli.js'),
      'ingestCodexRollout',
      '--file',
      file,
      '--scope',
      'repo',
      '--repoPath',
      targetRepo,
      '--distill',
      'never',
    ],
    { cwd: sessionsDir, env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.skippedReason, 'cwd_outside_repo_path');
  assert.equal(parsed.appendedEvents, 0);

  const app = createContextForge({ env, cwd: process.cwd() });
  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'github.com/example/filter-target',
    sessionId: 'codex:codex-outside-session',
  });
  assert.equal(events.length, 0);
});

test('Codex sessions watch loop picks up new events without duplicates', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const rolloutDir = path.join(sessionsDir, '2026', '04', '25');
  const file = path.join(rolloutDir, 'rollout-watch.jsonl');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(file, 'codex-watch-session');
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
  });
  const iterationResults = [];

  const result = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-watch-repo',
    distill: 'never',
    iterations: 2,
    intervalMs: 1,
    watchStateDir,
    onResult: async (iterationResult) => {
      iterationResults.push(iterationResult);
      if (iterationResult.iteration === 1) {
        await appendSyntheticCodexAssistantMessage(file, 'A new active TUI event arrived.');
      }
    },
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.totals.appendedEvents, 3);
  assert.equal(iterationResults[0].appendedEvents, 2);
  assert.equal(iterationResults[1].appendedEvents, 1);
  assert.equal(iterationResults[1].skippedEvents, 0);
  assert.equal(iterationResults[1].filesChanged, 1);
  assert.equal('fileResults' in iterationResults[0], false);
  assert.ok(iterationResults[0].stateFile.startsWith(watchStateDir));

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-watch-repo',
    sessionId: 'codex:codex-watch-session',
  });
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).content, 'A new active TUI event arrived.');
});

test('Codex incremental watch keeps trailing partial JSON uncommitted until complete', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const rolloutDir = path.join(sessionsDir, '2026', '04', '25');
  const file = path.join(rolloutDir, 'rollout-partial.jsonl');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(file, 'codex-partial-session');
  await fs.appendFile(
    file,
    '{"timestamp":"2026-04-25T00:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial append',
  );
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
  });

  const first = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchStateDir,
    watchVerbose: true,
  });
  assert.equal(first.totals.appendedEvents, 2);
  assert.equal(first.results[0].fileResults[0].warnings.length, 0);

  await fs.appendFile(file, '"}]} }\n');
  const second = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchStateDir,
    watchVerbose: true,
  });
  assert.equal(second.totals.appendedEvents, 1);
  assert.equal(second.results[0].fileResults[0].parsedEvents, 1);

  const events = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    sessionId: 'codex:codex-partial-session',
  });
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).content, 'partial append');

  await fs.appendFile(file, '{"malformed":\n');
  await appendSyntheticCodexAssistantMessage(file, 'Recovered after a malformed complete JSONL line.');
  const third = await watchCodexSessions(app, {
    sessionsDir,
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    distill: 'never',
    iterations: 1,
    intervalMs: 1,
    watchStateDir,
    watchVerbose: true,
  });
  assert.equal(third.totals.appendedEvents, 1);
  assert.equal(
    third.results[0].fileResults[0].warnings.some((warning) => warning.type === 'malformed_json_line'),
    true,
  );

  const recoveredEvents = app.listRawEvents({
    scope: 'repo',
    scopeKey: 'codex-partial-repo',
    sessionId: 'codex:codex-partial-session',
  });
  assert.equal(recoveredEvents.length, 4);
  assert.equal(recoveredEvents.at(-1).content, 'Recovered after a malformed complete JSONL line.');
});

test('CLI Codex sessions scan is not capped by search limit defaults', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const rolloutDir = path.join(sessionsDir, '2026', '04', '25');
  await fs.mkdir(rolloutDir, { recursive: true });
  for (let index = 0; index < 11; index += 1) {
    await writeSyntheticCodexRollout(
      path.join(rolloutDir, `rollout-${String(index).padStart(2, '0')}.jsonl`),
      `codex-session-${index}`,
    );
  }
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexSessions',
      '--sessionsDir',
      sessionsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'codex-uncapped-session-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.filesScanned, 11);
  assert.equal(parsed.appendedEvents, 22);
});

test('CLI routes Codex global sessions through a repo registry', async () => {
  const dataDir = await makeTempDir();
  const sessionsDir = await makeTempDir();
  const suiteRepo = await makeTempDir();
  const appRepo = path.join(suiteRepo, 'app');
  const frontendRepo = path.join(suiteRepo, 'app', 'frontend');
  const unknownRepo = await makeTempDir();
  await fs.mkdir(frontendRepo, { recursive: true });
  const rolloutDir = path.join(sessionsDir, '2026', '04', '26');
  await fs.mkdir(rolloutDir, { recursive: true });
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-suite.jsonl'), 'codex-suite', suiteRepo);
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-app.jsonl'), 'codex-app', path.join(appRepo, 'src'));
  await writeSyntheticCodexRollout(
    path.join(rolloutDir, 'rollout-frontend.jsonl'),
    'codex-frontend',
    path.join(frontendRepo, 'src'),
  );
  await writeSyntheticCodexRollout(path.join(rolloutDir, 'rollout-unknown.jsonl'), 'codex-unknown', unknownRepo);
  const registryPath = path.join(sessionsDir, 'repo-registry.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      {
        repos: [
          {
            name: 'suite',
            repoPath: suiteRepo,
            scopeKey: 'github.com/example/suite',
            adapters: ['codex'],
          },
          {
            name: 'app',
            repoPath: appRepo,
            scopeKey: 'github.com/example/app',
          },
          {
            name: 'frontend',
            repoPath: frontendRepo,
            scopeKey: 'github.com/example/frontend',
          },
          {
            name: 'disabled',
            repoPath: unknownRepo,
            scopeKey: 'github.com/example/disabled',
            enabled: false,
          },
        ],
      },
      null,
      2,
    ),
  );
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestCodexRoutedSessions',
      '--sessionsDir',
      sessionsDir,
      '--repoRegistry',
      registryPath,
      '--distill',
      'never',
    ],
    { env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.source, 'codex_sessions_router');
  assert.equal(parsed.filesScanned, 4);
  assert.equal(parsed.routedFiles, 3);
  assert.equal(parsed.skippedFiles, 1);
  assert.equal(parsed.appendedEvents, 6);
  assert.deepEqual(
    parsed.fileResults
      .filter((item) => item.matchedRepo)
      .map((item) => [item.sessionId, item.matchedRepo.name, item.matchedRepo.scopeKey])
      .sort(),
    [
      ['codex:codex-app', 'app', 'github.com/example/app'],
      ['codex:codex-frontend', 'frontend', 'github.com/example/frontend'],
      ['codex:codex-suite', 'suite', 'github.com/example/suite'],
    ],
  );
  const skipped = parsed.fileResults.find((item) => item.sessionId === 'codex:codex-unknown');
  assert.equal(skipped.skippedReason, 'unmatched_repo_cwd');

  const app = createContextForge({ env, cwd: process.cwd() });
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/frontend',
      sessionId: 'codex:codex-frontend',
    }).length,
    2,
  );
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/app',
      sessionId: 'codex:codex-frontend',
    }).length,
    0,
  );
});

test('CLI ingests Claude Code JSONL transcripts with agent provenance', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const file = path.join(projectsDir, 'project-a', 'claude-session.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(file, 'claude-native-session');
  await fs.appendFile(file, '{"type":"assistant","sessionId":"claude-native-session"');
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const first = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestClaudeCodeSessions',
      '--projectsDir',
      projectsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'claude-code-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.filesScanned, 1);
  assert.equal(firstResult.parsedEvents, 2);
  assert.equal(firstResult.appendedEvents, 2);
  assert.equal(firstResult.fileResults[0].sessionId, 'claude_code:claude-native-session');
  assert.equal(firstResult.fileResults[0].warnings.length, 1);

  const second = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestClaudeCodeSessions',
      '--projectsDir',
      projectsDir,
      '--scope',
      'repo',
      '--scopeKey',
      'claude-code-repo',
      '--distill',
      'never',
    ],
    { env },
  );
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.appendedEvents, 0);
  assert.equal(secondResult.skippedEvents, 2);

  const rawEvents = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'listRawEvents',
      '--scope',
      'repo',
      '--scopeKey',
      'claude-code-repo',
      '--sessionId',
      'claude_code:claude-native-session',
    ],
    { env },
  );
  const events = JSON.parse(rawEvents.stdout);
  assert.deepEqual(
    events.map((event) => event.role),
    ['user', 'assistant'],
  );
  assert.deepEqual(
    events.map((event) => event.content),
    ['Continue the ContextForge Claude Code ingest work.', 'I added Claude Code transcript ingestion.'],
  );
  assert.ok(events.every((event) => event.metadata.sourceAgent === 'claude_code'));
  assert.ok(events.every((event) => event.metadata.sourceAdapter === 'claude_code_jsonl'));
  assert.ok(events.every((event) => event.metadata.nativeSessionId === 'claude-native-session'));
});

test('Claude Code incremental watch skips unchanged transcript bytes', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const watchStateDir = await makeTempDir();
  const file = path.join(projectsDir, 'project-a', 'claude-watch.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(file, 'claude-watch-session');
  const app = createContextForge({
    env: { CONTEXTFORGE_DATA_DIR: dataDir },
    cwd: process.cwd(),
  });

  const result = await watchClaudeCodeSessions(app, {
    projectsDir,
    scope: 'repo',
    scopeKey: 'claude-watch-repo',
    distill: 'never',
    iterations: 2,
    intervalMs: 1,
    watchStateDir,
  });

  assert.equal(result.iterations, 2);
  assert.equal(result.results[0].filesChanged, 1);
  assert.equal(result.results[0].appendedEvents, 2);
  assert.equal(result.results[1].filesChanged, 0);
  assert.equal(result.results[1].parsedEvents, 0);
  assert.equal(result.results[1].skippedEvents, 0);
  assert.equal('fileResults' in result.results[0], false);
  assert.ok(result.results[0].stateFile.startsWith(watchStateDir));
});

test('CLI routes Claude Code global transcripts through a repo registry', async () => {
  const dataDir = await makeTempDir();
  const projectsDir = await makeTempDir();
  const suiteRepo = await makeTempDir();
  const appRepo = path.join(suiteRepo, 'app');
  const frontendRepo = path.join(suiteRepo, 'app', 'frontend');
  const unknownRepo = await makeTempDir();
  await fs.mkdir(frontendRepo, { recursive: true });
  await fs.mkdir(path.join(projectsDir, 'suite'), { recursive: true });
  await writeSyntheticClaudeCodeTranscript(path.join(projectsDir, 'suite', 'suite.jsonl'), 'claude-suite', suiteRepo);
  await writeSyntheticClaudeCodeTranscript(
    path.join(projectsDir, 'suite', 'app.jsonl'),
    'claude-app',
    path.join(appRepo, 'src'),
  );
  await writeSyntheticClaudeCodeTranscript(
    path.join(projectsDir, 'suite', 'frontend.jsonl'),
    'claude-frontend',
    path.join(frontendRepo, 'src'),
  );
  await writeSyntheticClaudeCodeTranscript(
    path.join(projectsDir, 'suite', 'unknown.jsonl'),
    'claude-unknown',
    unknownRepo,
  );
  const registryPath = path.join(projectsDir, 'repo-registry.json');
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      {
        repos: [
          {
            name: 'suite',
            repoPath: suiteRepo,
            scopeKey: 'github.com/example/suite',
            adapters: ['claude_code'],
          },
          {
            name: 'app',
            repoPath: appRepo,
            scopeKey: 'github.com/example/app',
          },
          {
            name: 'frontend',
            repoPath: frontendRepo,
            scopeKey: 'github.com/example/frontend',
          },
          {
            name: 'disabled',
            repoPath: unknownRepo,
            scopeKey: 'github.com/example/disabled',
            enabled: false,
          },
        ],
      },
      null,
      2,
    ),
  );
  const env = {
    ...process.env,
    CONTEXTFORGE_DATA_DIR: dataDir,
  };

  const result = await execFileAsync(
    'node',
    [
      'src/cli.js',
      'ingestClaudeCodeRoutedSessions',
      '--projectsDir',
      projectsDir,
      '--repoRegistry',
      registryPath,
      '--distill',
      'never',
    ],
    { env },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.source, 'claude_code_sessions_router');
  assert.equal(parsed.filesScanned, 4);
  assert.equal(parsed.routedFiles, 3);
  assert.equal(parsed.skippedFiles, 1);
  assert.equal(parsed.appendedEvents, 6);
  assert.deepEqual(
    parsed.fileResults
      .filter((item) => item.matchedRepo)
      .map((item) => [item.sessionId, item.matchedRepo.name, item.matchedRepo.scopeKey])
      .sort(),
    [
      ['claude_code:claude-app', 'app', 'github.com/example/app'],
      ['claude_code:claude-frontend', 'frontend', 'github.com/example/frontend'],
      ['claude_code:claude-suite', 'suite', 'github.com/example/suite'],
    ],
  );
  const skipped = parsed.fileResults.find((item) => item.sessionId === 'claude_code:claude-unknown');
  assert.equal(skipped.skippedReason, 'unmatched_repo_cwd');

  const app = createContextForge({ env, cwd: process.cwd() });
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/frontend',
      sessionId: 'claude_code:claude-frontend',
    }).length,
    2,
  );
  assert.equal(
    app.listRawEvents({
      scope: 'repo',
      scopeKey: 'github.com/example/app',
      sessionId: 'claude_code:claude-frontend',
    }).length,
    0,
  );
});
