import assert from 'node:assert/strict';
import test from 'node:test';
import { testAdminPasswordHash } from './helpers/schema.js';
import { makeTempDir } from './helpers/temp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createTokenAuthorizer,
  REMOTE_METHOD_CAPABILITIES,
  TOKEN_CAPABILITIES,
} from '../src/auth/token_authorization.js';
import { createContextForge } from '../src/core.js';
import { REMOTE_METHODS } from '../src/remote/client.js';
import { startContextForgeServer } from '../src/server.js';
import { SQLITE_JOURNAL_MODE } from '../src/storage/sqlite.js';

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
