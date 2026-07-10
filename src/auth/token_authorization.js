import crypto from 'node:crypto';
import { OPERATION_REGISTRY, operationByName } from '../operations/registry.js';
import { normalizeScopeOptions } from '../scopes/index.js';

export const TOKEN_CAPABILITIES = Object.freeze(['read', 'write', 'review', 'operator']);

export const REMOTE_METHOD_CAPABILITIES = Object.freeze(
  Object.fromEntries(OPERATION_REGISTRY.map((operation) => [operation.name, operation.capability])),
);

export class ContextForgeAuthenticationError extends Error {
  constructor(message = 'Unauthorized: authentication required.') {
    super(message);
    this.name = 'ContextForgeAuthenticationError';
    this.code = 'CONTEXTFORGE_UNAUTHORIZED';
    this.statusCode = 401;
  }
}

export class ContextForgeAuthorizationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ContextForgeAuthorizationError';
    this.code = 'CONTEXTFORGE_FORBIDDEN';
    this.statusCode = 403;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeHashEqual(actualHash, expectedHash) {
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseScopeRule(value, tokenId) {
  const text = String(value || '').trim();
  const separator = text.indexOf(':');
  if (separator <= 0 || separator === text.length - 1) {
    throw new Error(`API token ${tokenId} has invalid scope rule: ${text || '<empty>'}. Expected type:key.`);
  }
  const scopeType = text.slice(0, separator);
  const scopeKey = text.slice(separator + 1);
  if (!['*', 'shared', 'repo', 'local'].includes(scopeType)) {
    throw new Error(`API token ${tokenId} has invalid scope type: ${scopeType}.`);
  }
  if (scopeType === '*' && scopeKey !== '*') {
    throw new Error(`API token ${tokenId} may only use wildcard scope type as *:*.`);
  }
  return Object.freeze({ scopeType, scopeKey });
}

function tokenHashFromPolicy(policy, env) {
  if (policy.tokenEnv && policy.sha256) {
    throw new Error(`API token ${policy.id} must use either tokenEnv or sha256, not both.`);
  }
  if (policy.tokenEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(policy.tokenEnv)) {
      throw new Error(`API token ${policy.id} has invalid tokenEnv: ${policy.tokenEnv}.`);
    }
    const secret = env[policy.tokenEnv];
    if (!secret) throw new Error(`API token ${policy.id} references missing environment variable ${policy.tokenEnv}.`);
    if (String(secret).length < 16) throw new Error(`API token ${policy.id} secret must be at least 16 characters.`);
    return sha256(secret);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(policy.sha256 || ''))) {
    throw new Error(`API token ${policy.id} requires tokenEnv or a 64-character sha256 value.`);
  }
  return String(policy.sha256).toLowerCase();
}

function parseApiTokenPolicies(env) {
  const source = env.CONTEXTFORGE_API_TOKENS_JSON;
  if (!source) return [];
  let policies;
  try {
    policies = JSON.parse(source);
  } catch (error) {
    throw new Error(`CONTEXTFORGE_API_TOKENS_JSON must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new Error('CONTEXTFORGE_API_TOKENS_JSON must be a non-empty array.');
  }
  if (policies.length > 100) throw new Error('CONTEXTFORGE_API_TOKENS_JSON supports at most 100 tokens.');
  const ids = new Set();
  const hashes = new Set();
  return policies.map((policy) => {
    if (!policy || typeof policy !== 'object') throw new Error('Each API token policy must be an object.');
    const id = String(policy.id || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(id)) throw new Error(`Invalid API token id: ${id || '<empty>'}.`);
    if (ids.has(id)) throw new Error(`Duplicate API token id: ${id}.`);
    ids.add(id);
    const capabilities = [...new Set(Array.isArray(policy.capabilities) ? policy.capabilities : [])];
    if (!capabilities.length || capabilities.some((item) => !TOKEN_CAPABILITIES.includes(item))) {
      throw new Error(`API token ${id} must declare one or more of: ${TOKEN_CAPABILITIES.join(', ')}.`);
    }
    if (!Array.isArray(policy.scopes) || policy.scopes.length === 0) {
      throw new Error(`API token ${id} must declare at least one scope rule.`);
    }
    const scopes = policy.scopes.map((scope) => parseScopeRule(scope, id));
    const expiresAt = policy.expiresAt == null ? null : new Date(policy.expiresAt);
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error(`API token ${id} has invalid expiresAt.`);
    const tokenHash = tokenHashFromPolicy({ ...policy, id }, env);
    if (hashes.has(tokenHash)) throw new Error(`API token ${id} reuses another configured token secret.`);
    hashes.add(tokenHash);
    return Object.freeze({
      id,
      kind: 'api-token',
      tokenHash,
      capabilities: Object.freeze(capabilities),
      scopes: Object.freeze(scopes),
      revoked: policy.revoked === true,
      expiresAt: expiresAt?.toISOString() || null,
    });
  });
}

function legacyPolicy(env, hasPolicies) {
  const secret = env.CONTEXTFORGE_REMOTE_TOKEN;
  if (!secret) return null;
  const rawMode = env.CONTEXTFORGE_LEGACY_REMOTE_TOKEN_MODE;
  const mode = rawMode == null || rawMode === '' ? (hasPolicies ? 'disabled' : 'full') : String(rawMode).toLowerCase();
  if (!['disabled', 'full'].includes(mode)) {
    throw new Error('CONTEXTFORGE_LEGACY_REMOTE_TOKEN_MODE must be disabled or full.');
  }
  if (mode === 'disabled') return null;
  return Object.freeze({
    id: 'legacy-remote-token',
    kind: 'legacy-token',
    tokenHash: sha256(secret),
    capabilities: TOKEN_CAPABILITIES,
    scopes: Object.freeze([{ scopeType: '*', scopeKey: '*' }]),
    revoked: false,
    expiresAt: null,
  });
}

function bearerValue(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return match?.[1] || null;
}

function scopeAllowed(identity, scopeType, scopeKey) {
  return identity.scopes.some(
    (rule) =>
      (rule.scopeType === '*' || rule.scopeType === scopeType) &&
      (rule.scopeKey === '*' || rule.scopeKey === scopeKey),
  );
}

function hasAllScopes(identity) {
  return scopeAllowed(identity, '*', '*');
}

function hasScopeHints(options = {}) {
  return Boolean(options.scopeType || options.scope || options.scopeKey || options.cwd || options.repoPath);
}

function trueValue(value) {
  return value === true || ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function requireAllowedScope(identity, scope, method) {
  if (!scopeAllowed(identity, scope.scopeType, scope.scopeKey)) {
    throw new ContextForgeAuthorizationError(
      `Token ${identity.id} is not allowed to access ${scope.scopeType}:${scope.scopeKey}.`,
      { tokenId: identity.id, method, scope },
    );
  }
}

export function createTokenAuthorizer(env = process.env) {
  const policies = parseApiTokenPolicies(env);
  const legacy = legacyPolicy(env, policies.length > 0);
  const tokens = Object.freeze(legacy ? [...policies, legacy] : policies);
  const credentialsRequired = tokens.length > 0;

  function authenticate(header, { admin = false } = {}) {
    if (admin) {
      return Object.freeze({
        id: 'admin-session',
        kind: 'admin-session',
        capabilities: TOKEN_CAPABILITIES,
        scopes: Object.freeze([{ scopeType: '*', scopeKey: '*' }]),
      });
    }
    if (!credentialsRequired) {
      return Object.freeze({
        id: 'anonymous-loopback',
        kind: 'anonymous',
        capabilities: TOKEN_CAPABILITIES,
        scopes: Object.freeze([{ scopeType: '*', scopeKey: '*' }]),
      });
    }
    const bearer = bearerValue(header);
    if (!bearer) return null;
    const presentedHash = sha256(bearer);
    const now = Date.now();
    return (
      tokens.find(
        (token) =>
          !token.revoked &&
          (!token.expiresAt || Date.parse(token.expiresAt) > now) &&
          timingSafeHashEqual(presentedHash, token.tokenHash),
      ) || null
    );
  }

  function authorize(identity, method, options = {}, config = {}) {
    if (!identity) throw new ContextForgeAuthenticationError();
    const operation = operationByName(method);
    if (!operation) {
      throw new ContextForgeAuthorizationError(`No authorization policy exists for method ${method}.`, {
        tokenId: identity.id,
        method,
      });
    }
    const capability = operation.capability;
    if (!identity.capabilities.includes(capability)) {
      throw new ContextForgeAuthorizationError(`Method ${method} requires the ${capability} capability.`, {
        tokenId: identity.id,
        method,
        requiredCapability: capability,
      });
    }
    if (operation.scopeMode === 'process') return { capability, scopes: [] };
    if (operation.scopeMode === 'all' || operation.scopeMode === 'workspace') {
      if (!hasAllScopes(identity)) {
        throw new ContextForgeAuthorizationError(`Method ${method} requires an all-scope token.`, {
          tokenId: identity.id,
          method,
        });
      }
      return { capability, scopes: [] };
    }
    if (operation.scopeMode === 'migration') {
      const from = { scopeType: options.fromScopeType || options.fromScope, scopeKey: options.fromScopeKey };
      const to = { scopeType: options.toScopeType || options.toScope || from.scopeType, scopeKey: options.toScopeKey };
      if (!from.scopeType || !from.scopeKey || !to.scopeType || !to.scopeKey) {
        throw new ContextForgeAuthorizationError('migrateScope requires explicit source and target scopes.', {
          tokenId: identity.id,
          method,
        });
      }
      requireAllowedScope(identity, from, method);
      requireAllowedScope(identity, to, method);
      return { capability, scopes: [from, to] };
    }
    const hasExplicitScope = hasScopeHints(options);
    if (operation.scopeMode === 'optional' && !hasExplicitScope) {
      if (!hasAllScopes(identity)) {
        throw new ContextForgeAuthorizationError(`Method ${method} requires an explicit scope for this token.`, {
          tokenId: identity.id,
          method,
        });
      }
      return { capability, scopes: [] };
    }
    let scope;
    try {
      scope = normalizeScopeOptions(options, config);
    } catch (error) {
      throw new ContextForgeAuthorizationError(`Method ${method} could not resolve a scope for authorization.`, {
        tokenId: identity.id,
        method,
        reason: error.message,
      });
    }
    requireAllowedScope(identity, scope, method);
    if (trueValue(options.includeShared) && scope.scopeType !== 'shared') {
      requireAllowedScope(
        identity,
        {
          scopeType: 'shared',
          scopeKey: options.sharedScopeKey || config.defaultSharedScopeKey || config.defaultScopeKey,
        },
        method,
      );
    }
    const relatedScopeKeys =
      options.relatedScopeKeys == null
        ? []
        : Array.isArray(options.relatedScopeKeys)
          ? options.relatedScopeKeys
          : String(options.relatedScopeKeys).split(',');
    for (const relatedScopeKey of relatedScopeKeys.map((value) => String(value).trim()).filter(Boolean)) {
      requireAllowedScope(identity, { scopeType: 'repo', scopeKey: relatedScopeKey }, method);
    }
    if (options.workspaceKey && !hasAllScopes(identity)) {
      throw new ContextForgeAuthorizationError(`Method ${method} requires an all-scope token when workspaceKey is used.`, {
        tokenId: identity.id,
        method,
      });
    }
    return { capability, scopes: [scope] };
  }

  return Object.freeze({
    credentialsRequired,
    tokenCount: tokens.length,
    authenticate,
    authorize,
    configuredTokenIds: Object.freeze(tokens.map((token) => token.id)),
  });
}

export function authorizeAndBindScope(authorizer, identity, method, options = {}, config = {}) {
  const authorization = authorizer.authorize(identity, method, options, config);
  const authorizedScope = authorization.scopes.length === 1 ? authorization.scopes[0] : null;
  return {
    authorization,
    options: authorizedScope
      ? {
          ...options,
          scope: authorizedScope.scopeType,
          scopeType: authorizedScope.scopeType,
          scopeKey: authorizedScope.scopeKey,
        }
      : { ...options },
  };
}
