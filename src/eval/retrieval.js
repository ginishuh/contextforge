import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createContextForge } from '../core.js';

function arrayOfStrings(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error('Expected an array of strings.');
  }
  return value.map((item) => String(item));
}

function normalizedText(value) {
  return String(value || '').toLowerCase();
}

function resultText(result) {
  return [result.key, result.category, result.content, ...(result.why || []).map((hit) => hit.token)]
    .filter(Boolean)
    .join('\n');
}

function scopeIdentity(scopeType, scopeKey) {
  return `${scopeType}:${scopeKey}`;
}

function scopePlanRoleMap(scopePlan) {
  const roles = new Map();
  for (const scope of scopePlan?.includedScopes || []) {
    roles.set(scopeIdentity(scope.scopeType || scope.scope, scope.scopeKey), {
      scope: scope.scopeType || scope.scope,
      scopeKey: scope.scopeKey,
      memberName: scope.memberName || null,
      role: scope.role || 'member',
    });
  }
  return roles;
}

function resultScope(result, roles) {
  const source = result.scope || result.source || {};
  const scopeType = source.scopeType || source.scope || 'repo';
  const scopeKey = source.scopeKey || null;
  const mapped = roles.get(scopeIdentity(scopeType, scopeKey)) || {};
  const role = source.role && source.role !== 'repo' ? source.role : mapped.role || 'member';
  return {
    scope: scopeType,
    scopeType,
    scopeKey,
    memberName: source.memberName || mapped.memberName || null,
    role,
    key: result.key,
    type: result.type,
  };
}

function applyFixture(app, fixture) {
  const workspace = fixture.workspace || fixture.workspaceProfile || {};
  const workspaceKey = fixture.workspaceKey || workspace.workspaceKey;
  if (!workspaceKey) {
    throw new Error('Fixture requires workspaceKey.');
  }

  app.upsertWorkspaceProfile({
    workspaceKey,
    displayName: workspace.displayName || fixture.displayName,
    canonicalScope: workspace.canonicalScope || workspace.canonicalScopeType || fixture.canonicalScope || 'repo',
    canonicalScopeKey: workspace.canonicalScopeKey || fixture.canonicalScopeKey,
    metadata: workspace.metadata || {},
  });

  for (const member of fixture.members || []) {
    app.upsertWorkspaceMember({
      workspaceKey,
      name: member.name,
      scope: member.scope || member.scopeType || 'repo',
      scopeKey: member.scopeKey,
      role: member.role || 'member',
      priority: member.priority == null ? 0 : Number(member.priority),
      includeByDefault: Boolean(member.includeByDefault || member.include_by_default),
      metadata: member.metadata || {},
      allowLocal: Boolean(member.allowLocal),
    });
  }

  for (const rule of fixture.routingRules || fixture.rules || []) {
    app.upsertWorkspaceRoutingRule({
      workspaceKey,
      ruleKey: rule.ruleKey,
      priority: rule.priority == null ? 0 : Number(rule.priority),
      match: rule.match || {},
      include: rule.include || {},
      exclude: rule.exclude || {},
      includeShared: Boolean(rule.includeShared),
      status: rule.status || 'active',
      metadata: rule.metadata || {},
    });
  }

  for (const memory of fixture.memories || []) {
    app.remember({
      scope: memory.scope || memory.scopeType || 'repo',
      scopeKey: memory.scopeKey,
      key: memory.key,
      content: memory.content,
      category: memory.category || 'runbook',
      tags: memory.tags || [],
      importance: memory.importance == null ? 5 : Number(memory.importance),
    });
  }
}

async function evaluateQuery(app, fixture, querySpec) {
  const workspaceKey = fixture.workspaceKey || fixture.workspace?.workspaceKey || fixture.workspaceProfile?.workspaceKey;
  const primaryScope = querySpec.scope || querySpec.primaryScope || fixture.primaryScope || 'repo';
  const primaryScopeKey = querySpec.scopeKey || querySpec.primaryScopeKey || fixture.primaryScopeKey;
  if (!primaryScopeKey) {
    throw new Error(`Eval query requires primaryScopeKey: ${querySpec.query}`);
  }

  const topN = Number(querySpec.topN || fixture.topN || 10);
  const expected = querySpec.expected || {};
  const requiredTerms = arrayOfStrings(expected.mustContain);
  const expectedScopeRoles = arrayOfStrings(expected.expectedScopeRoles);
  const bootstrap = await app.bootstrapContext({
    scope: primaryScope,
    scopeKey: primaryScopeKey,
    workspaceKey,
    workspaceMode: querySpec.workspaceMode || fixture.workspaceMode || 'auto',
    workspaceResultLimit: querySpec.workspaceResultLimit || fixture.workspaceResultLimit || topN,
    workspacePerScopeLimit: querySpec.workspacePerScopeLimit || fixture.workspacePerScopeLimit || 4,
    includeWorkspaceHandoffs: Boolean(querySpec.includeWorkspaceHandoffs || fixture.includeWorkspaceHandoffs),
    query: querySpec.query,
    consultReason: querySpec.consultReason || fixture.consultReason || 'startup',
    limit: querySpec.limit || fixture.limit || topN,
  });
  const primaryResults = (bootstrap.results || []).slice(0, topN);
  const workspaceResults = (bootstrap.workspace?.results || []).slice(0, topN);
  const combinedResults = [...primaryResults, ...workspaceResults];
  const combinedText = normalizedText(combinedResults.map(resultText).join('\n'));
  const roles = scopePlanRoleMap(bootstrap.workspace?.scopePlan);
  const topScopes = combinedResults.map((result) => resultScope(result, roles));
  const presentRoles = new Set(topScopes.map((scope) => scope.role).filter(Boolean));
  const matchedRequiredTerms = requiredTerms.filter((term) => combinedText.includes(normalizedText(term)));
  const missingRequiredTerms = requiredTerms.filter((term) => !combinedText.includes(normalizedText(term)));
  const matchedScopeRoles = expectedScopeRoles.filter((role) => presentRoles.has(role));
  const missingScopeRoles = expectedScopeRoles.filter((role) => !presentRoles.has(role));
  const passed = missingRequiredTerms.length === 0 && missingScopeRoles.length === 0;

  return {
    query: querySpec.query,
    passed,
    topN,
    resultWindow: {
      primary: primaryResults.length,
      workspace: workspaceResults.length,
    },
    topScopes,
    resultKeys: combinedResults.map((result) => result.key),
    matchedRequiredTerms,
    missingRequiredTerms,
    matchedScopeRoles,
    missingScopeRoles,
    workspaceWarnings: bootstrap.workspace?.warnings || [],
  };
}

export async function evaluateRetrievalFixture(fixture, options = {}) {
  if (!options.app && !options.dataDir) {
    throw new Error('evaluateRetrievalFixture requires an isolated dataDir when app is not supplied.');
  }
  const app =
    options.app ||
    createContextForge({
      env: {
        ...process.env,
        CONTEXTFORGE_DATA_DIR: options.dataDir,
        CONTEXTFORGE_STORAGE_MODE: 'local',
        CONTEXTFORGE_EMBEDDINGS_PROVIDER: 'none',
      },
      cwd: options.cwd || process.cwd(),
    });
  try {
    applyFixture(app, fixture);
    const details = [];
    for (const query of fixture.queries || []) {
      details.push(await evaluateQuery(app, fixture, query));
    }
    const failed = details.filter((detail) => !detail.passed).length;
    return {
      kind: 'retrieval_eval',
      fixture: fixture.name || fixture.workspaceKey || fixture.workspace?.workspaceKey || null,
      workspaceKey: fixture.workspaceKey || fixture.workspace?.workspaceKey || fixture.workspaceProfile?.workspaceKey,
      queries: details.length,
      passed: details.length - failed,
      failed,
      details,
    };
  } finally {
    if (!options.app) {
      app.close?.();
    }
  }
}

export async function runRetrievalEval(options = {}) {
  const fixturePath = options.fixture;
  if (!fixturePath) {
    throw new Error('evalRetrieval requires --fixture <path>.');
  }
  let fixture;
  try {
    fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid eval fixture ${fixturePath}: ${error.message}`);
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'contextforge-eval-'));
  try {
    return await evaluateRetrievalFixture(fixture, {
      dataDir,
      cwd: options.cwd || process.cwd(),
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
