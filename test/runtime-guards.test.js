import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseJunitReport } from '../scripts/junit-report.js';
import { fakeSpawnThatClosesOnKill } from './helpers/schema.js';
import { runCodexSdkPythonCommand } from '../src/audit/codex_sdk_python.js';
import { runCodexExecCommand } from '../src/distill/providers/codex_exec.js';
import { createOpenAiCompatibleProvider } from '../src/distill/providers/openai_compatible.js';
import { createOpenAiEmbeddingProvider } from '../src/embeddings/index.js';
import { createInterruptibleSleep } from '../src/ingest/common.js';
import {
  registerRuntimeChild,
  runtimeChildSnapshot,
  terminateRuntimeChildren,
} from '../src/runtime/child_processes.js';
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
