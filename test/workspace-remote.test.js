import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { makeTempDir } from './helpers/temp.js';
import { createContextForge } from '../src/core.js';

const execFileAsync = promisify(execFile);

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
