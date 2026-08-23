import assert from 'node:assert/strict';
import test from 'node:test';
import { makeGitRepo } from './helpers/fixtures.js';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';
import { startContextForgeServer } from '../src/server.js';

test('remote storage mode delegates core calls and preserves scope semantics', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const app = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      },
      cwd: process.cwd(),
    });

    await app.remember({
      scope: 'repo',
      scopeKey: 'repo-remote',
      key: 'storage-mode',
      content: 'Remote repo memory stays in repo scope.',
      category: 'decision',
    });
    await app.remember({
      scope: 'shared',
      scopeKey: 'global',
      key: 'storage-mode',
      content: 'Shared memory stays in shared scope.',
      category: 'policy',
    });

    const repoMemory = await app.getMemory({
      scope: 'repo',
      scopeKey: 'repo-remote',
      key: 'storage-mode',
    });
    const sharedMemory = await app.getMemory({
      scope: 'shared',
      scopeKey: 'global',
      key: 'storage-mode',
    });
    assert.equal(repoMemory.scopeType, 'repo');
    assert.equal(repoMemory.content, 'Remote repo memory stays in repo scope.');
    assert.equal(sharedMemory.scopeType, 'shared');
    assert.equal(sharedMemory.content, 'Shared memory stays in shared scope.');

    const repoResults = await app.search({
      scope: 'repo',
      scopeKey: 'repo-remote',
      query: 'remote scope',
    });
    assert.equal(repoResults.length, 1);
    assert.equal(repoResults[0].memory.scopeType, 'repo');

    const bootstrap = await app.bootstrapContext({
      scope: 'repo',
      scopeKey: 'repo-remote',
      query: 'remote shared scope previous work',
      includeShared: true,
    });
    assert.equal(bootstrap.scope.scopeKey, 'repo-remote');
    assert.equal(bootstrap.connection.mode, 'remote-client');
    assert.equal(bootstrap.connection.accessMode, 'remote-client');
    assert.equal(bootstrap.connection.accessPath, 'http-api');
    assert.equal(bootstrap.connection.serverRole, 'http-server');
    assert.equal(bootstrap.storage.mode, 'remote');
    assert.equal(bootstrap.storage.authority, 'canonical');
    assert.equal(bootstrap.storage.serverMode, 'project-local');
    assert.ok(bootstrap.results.some((item) => item.group === 'primary' && item.key === 'storage-mode'));
    assert.ok(bootstrap.results.some((item) => item.group === 'shared' && item.key === 'storage-mode'));

    await app.appendRaw({
      scope: 'repo',
      scopeKey: 'repo-remote',
      sessionId: 'remote-session',
      role: 'user',
      content: 'Remote clients can inspect whether a session should distill.',
    });
    const status = await app.sessionStatus({
      scope: 'repo',
      scopeKey: 'repo-remote',
      sessionId: 'remote-session',
      minEvents: 1,
      charThreshold: 1,
    });
    assert.equal(status.shouldDistill, true);
    assert.equal(status.rawEventCount, 1);

    const info = await app.dbInfo();
    assert.equal(info.tables.memories, 2);
    assert.equal(info.connection.mode, 'remote-client');
    assert.equal(info.connection.accessMode, 'remote-client');
    assert.equal(info.connection.accessPath, 'http-api');
    assert.equal(info.connection.serverRole, 'http-server');
    assert.equal(info.connection.clientStorageMode, 'remote');
    assert.equal(info.connection.summary, 'remote-client over http-api to http-server');
    assert.equal(info.connection.server.mode, 'http-server');
    assert.equal(info.connection.server.storageMode, 'project-local');
  } finally {
    await remote.close();
  }
});

test('remote durable job submission survives the submitting client request', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });
  const remoteEnv = {
    CONTEXTFORGE_STORAGE_MODE: 'remote',
    CONTEXTFORGE_REMOTE_URL: remote.url,
    CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
  };
  try {
    const app = createContextForge({ env: remoteEnv, cwd: process.cwd() });
    const source = { scope: 'repo', scopeKey: 'remote-job-repo', sessionId: 'remote-job-session' };
    await app.appendRaw({ ...source, role: 'assistant', content: 'Persist this before the client goes away.' });

    const response = await fetch(`${remote.url}/v0/submitDistillJob`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(source),
    });
    assert.equal(response.status, 200);
    const submitted = (await response.json()).result;
    assert.equal(submitted.status, 'queued');

    const replacementClient = createContextForge({ env: remoteEnv, cwd: process.cwd() });
    const queued = await replacementClient.getJob({ jobId: submitted.jobId });
    assert.equal(queued.status, 'queued');
    const processed = await replacementClient.processJobs({ workerId: 'remote-replacement-worker' });
    assert.equal(processed.succeeded, 1);
    const completed = await replacementClient.getJob({ jobId: submitted.jobId });
    assert.equal(completed.status, 'succeeded');
    assert.match(completed.result.summaryShort, /^Mock checkpoint/);
  } finally {
    await remote.close();
  }
});

test('remote storage mode resolves repoPath before sending scoped calls', async () => {
  const dataDir = await makeTempDir();
  const appCwd = await makeTempDir();
  const repoPath = await makeGitRepo('https://github.com/example/remote-client-repo.git');
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const app = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      },
      cwd: appCwd,
    });

    const memory = await app.remember({
      scope: 'repo',
      repoPath,
      key: 'remote-client-repo-path',
      content: 'Remote clients resolve repoPath locally before posting.',
    });
    assert.equal(memory.scopeKey, 'github.com/example/remote-client-repo');

    const fetched = await app.getMemory({
      scope: 'repo',
      scopeKey: 'github.com/example/remote-client-repo',
      key: 'remote-client-repo-path',
    });
    assert.equal(fetched.content, 'Remote clients resolve repoPath locally before posting.');
  } finally {
    await remote.close();
  }
});

test('remote storage mode strips local path hints after resolving scope', async () => {
  const appCwd = await makeTempDir();
  const repoPath = await makeGitRepo('https://github.com/example/remote-strip-repo.git');
  const postedBodies = [];
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
    cwd: appCwd,
    fetchImpl: async (url, request) => {
      const postedBody = JSON.parse(request.body);
      postedBodies.push({ method: new URL(url).pathname.split('/').at(-1), body: postedBody });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            result: {
              key: postedBody.key,
              scopeType: postedBody.scopeType,
              scopeKey: postedBody.scopeKey,
            },
          }),
      };
    },
  });

  const memory = await app.remember({
    scope: 'repo',
    repoPath,
    cwd: appCwd,
    key: 'remote-strip-paths',
    content: 'Remote payloads should not include local paths.',
  });

  assert.equal(memory.scopeKey, 'github.com/example/remote-strip-repo');
  assert.equal(postedBodies[0].body.scopeKey, 'github.com/example/remote-strip-repo');
  assert.equal(postedBodies[0].body.repoPath, undefined);
  assert.equal(postedBodies[0].body.cwd, undefined);

  await app.listDueDistillSessions({
    scope: 'repo',
    repoPath,
    cwd: appCwd,
    limit: 1,
  });
  assert.equal(postedBodies[1].method, 'listDueDistillSessions');
  assert.equal(postedBodies[1].body.scopeKey, 'github.com/example/remote-strip-repo');
  assert.equal(postedBodies[1].body.repoPath, undefined);
  assert.equal(postedBodies[1].body.cwd, undefined);

  await app.listDueDistillSessions({ limit: 2 });
  assert.equal(postedBodies[2].method, 'listDueDistillSessions');
  assert.equal(postedBodies[2].body.scopeKey, undefined);
  assert.equal(postedBodies[2].body.scope, undefined);
  assert.equal(postedBodies[2].body.limit, 2);
});

test('remote storage mode preserves structured error names and warnings', async () => {
  const app = createContextForge({
    env: {
      CONTEXTFORGE_STORAGE_MODE: 'remote',
      CONTEXTFORGE_REMOTE_URL: 'https://memory.example.test',
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
    cwd: process.cwd(),
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({
          error: {
            name: 'MemoryCandidatePromotionWarningError',
            code: 'CONTEXTFORGE_SYNTHETIC_REMOTE_ERROR',
            message: 'Memory candidate promotion has 1 warning(s).',
            warnings: [{ code: 'duplicate_key' }],
          },
        }),
    }),
  });

  await assert.rejects(
    () =>
      app.promoteMemoryCandidate({
        scope: 'repo',
        scopeKey: 'remote-warning-repo',
        candidateId: 'candidate-id',
      }),
    (error) => {
      assert.equal(error.name, 'MemoryCandidatePromotionWarningError');
      assert.equal(error.code, 'CONTEXTFORGE_SYNTHETIC_REMOTE_ERROR');
      assert.equal(error.warnings[0].code, 'duplicate_key');
      return true;
    },
  );
});

test('remote storage mode rejects unauthorized writes', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
    },
  });

  try {
    const app = createContextForge({
      env: {
        CONTEXTFORGE_STORAGE_MODE: 'remote',
        CONTEXTFORGE_REMOTE_URL: remote.url,
        CONTEXTFORGE_REMOTE_TOKEN: 'wrong-token',
      },
      cwd: process.cwd(),
    });

    await assert.rejects(
      () =>
        app.remember({
          scope: 'repo',
          scopeKey: 'repo-remote',
          key: 'unauthorized',
          content: 'This should not be written.',
        }),
      /Unauthorized/,
    );
  } finally {
    await remote.close();
  }
});

test('remote server requires a token on non-loopback hosts', async () => {
  assert.throws(
    () =>
      startContextForgeServer({
        host: '0.0.0.0',
        port: 0,
        env: {
          CONTEXTFORGE_DATA_DIR: '/tmp/contextforge-token-required',
        },
      }),
    /CONTEXTFORGE_REMOTE_TOKEN is required/,
  );
});

test('remote server supports configurable request body limits', async () => {
  const dataDir = await makeTempDir();
  const remote = await startContextForgeServer({
    port: 0,
    env: {
      CONTEXTFORGE_DATA_DIR: dataDir,
      CONTEXTFORGE_REMOTE_TOKEN: 'test-token',
      CONTEXTFORGE_REMOTE_MAX_BODY_BYTES: '8',
    },
  });

  try {
    const response = await fetch(`${remote.url}/v0/dbInfo`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: '{"tooLarge":true}',
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error.name, 'RequestBodyTooLargeError');
    assert.match(body.error.message, /too large/);
  } finally {
    await remote.close();
  }
});
