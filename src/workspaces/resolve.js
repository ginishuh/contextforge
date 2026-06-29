const SCOPE_TYPES = new Set(['shared', 'repo', 'local']);
const WORKSPACE_MODES = new Set(['off', 'auto', 'strict']);
const PROFILE_STATUSES = new Set(['active', 'inactive']);
const RULE_STATUSES = new Set(['active', 'inactive']);
const WORKSPACE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MEMBER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const JSON_MAX_BYTES = 8192;
const ARRAY_MAX_ITEMS = 50;
const STRING_MAX_LENGTH = 300;
const TERM_MAX_LENGTH = 100;

function normalizeString(value, name, { allowEmpty = false, maxLength = STRING_MAX_LENGTH } = {}) {
  const normalized = String(value ?? '').trim();
  if (!allowEmpty && !normalized) {
    throw new Error(`${name} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

export function normalizeWorkspaceKey(value) {
  const workspaceKey = normalizeString(value, 'workspaceKey', { maxLength: 128 });
  if (!WORKSPACE_KEY_PATTERN.test(workspaceKey)) {
    throw new Error('workspaceKey must be a slug-like string using letters, numbers, dot, underscore, or hyphen.');
  }
  return workspaceKey;
}

export function normalizeWorkspaceMode(value = 'auto') {
  const mode = String(value || 'auto').trim().toLowerCase();
  if (!WORKSPACE_MODES.has(mode)) {
    throw new Error(`workspaceMode must be one of: ${Array.from(WORKSPACE_MODES).join(', ')}.`);
  }
  return mode;
}

export function normalizeScopeType(value = 'repo', { allowLocal = true } = {}) {
  const scopeType = String(value || 'repo').trim().toLowerCase();
  if (!SCOPE_TYPES.has(scopeType)) {
    throw new Error('scope must be shared, repo, or local.');
  }
  if (scopeType === 'local' && !allowLocal) {
    throw new Error('local workspace members require allowLocal=true.');
  }
  return scopeType;
}

export function normalizeWorkspaceProfileInput(input = {}) {
  const status = String(input.status || 'active').trim().toLowerCase();
  if (!PROFILE_STATUSES.has(status)) {
    throw new Error('workspace profile status must be active or inactive.');
  }
  const canonicalScopeType = normalizeScopeType(input.canonicalScopeType || input.canonicalScope || 'repo');
  const canonicalScopeKey = input.canonicalScopeKey
    ? normalizeString(input.canonicalScopeKey, 'canonicalScopeKey')
    : null;
  return {
    workspaceKey: normalizeWorkspaceKey(input.workspaceKey),
    displayName: input.displayName == null ? null : normalizeString(input.displayName, 'displayName', { allowEmpty: true }),
    canonicalScopeType,
    canonicalScopeKey,
    status,
    metadata: normalizeMetadata(input.metadata),
  };
}

export function normalizeWorkspaceMemberInput(input = {}) {
  const scopeType = normalizeScopeType(input.scopeType || input.scope || 'repo', {
    allowLocal: Boolean(input.allowLocal),
  });
  return {
    workspaceKey: normalizeWorkspaceKey(input.workspaceKey),
    name: normalizeMemberName(input.name || input.memberName),
    scopeType,
    scopeKey: normalizeString(input.scopeKey, 'scopeKey'),
    role: normalizeString(input.role || 'member', 'role'),
    priority: normalizeInteger(input.priority, 'priority', 0),
    includeByDefault: normalizeBoolean(input.includeByDefault ?? input.include_by_default, false),
    metadata: normalizeMetadata(input.metadata),
  };
}

export function normalizeWorkspaceRoutingRuleInput(input = {}) {
  const status = String(input.status || 'active').trim().toLowerCase();
  if (!RULE_STATUSES.has(status)) {
    throw new Error('workspace routing rule status must be active or inactive.');
  }
  return {
    workspaceKey: normalizeWorkspaceKey(input.workspaceKey),
    ruleKey: normalizeString(input.ruleKey, 'ruleKey', { maxLength: 128 }),
    priority: normalizeInteger(input.priority, 'priority', 0),
    match: normalizeRuleJson(input.match ?? input.matchJson ?? {}, 'matchJson', {
      allowedKeys: ['termsAny', 'termsAll', 'consultReasonsAny'],
      termKeys: new Set(['termsAny', 'termsAll']),
    }),
    include: normalizeRuleJson(input.include ?? input.includeJson ?? {}, 'includeJson', {
      allowedKeys: ['roles', 'members', 'scopeKeys'],
    }),
    exclude: normalizeRuleJson(input.exclude ?? input.excludeJson ?? {}, 'excludeJson', {
      allowedKeys: ['roles', 'members', 'scopeKeys'],
    }),
    includeShared: normalizeBoolean(input.includeShared ?? input.include_shared, false),
    status,
    metadata: normalizeMetadata(input.metadata),
  };
}

function normalizeMemberName(value) {
  const name = normalizeString(value, 'memberName', { maxLength: 128 });
  if (!MEMBER_NAME_PATTERN.test(name)) {
    throw new Error('memberName must be a slug-like string using letters, numbers, dot, underscore, or hyphen.');
  }
  return name;
}

function normalizeInteger(value, name, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

function normalizeBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  if (value === true || value === false) {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  throw new Error('boolean option must be true or false.');
}

function normalizeMetadata(value) {
  const metadata = parseJsonObject(value ?? {});
  return metadata;
}

function parseJsonObject(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > JSON_MAX_BYTES) {
      throw new Error(`JSON value must be at most ${JSON_MAX_BYTES} bytes.`);
    }
    try {
      value = value.trim() ? JSON.parse(value) : {};
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON value must be an object.');
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > JSON_MAX_BYTES) {
    throw new Error(`JSON value must be at most ${JSON_MAX_BYTES} bytes.`);
  }
  return value;
}

function normalizeRuleJson(value, name, { allowedKeys, termKeys = new Set() }) {
  const parsed = parseJsonObject(value);
  const allowed = new Set(allowedKeys);
  const normalized = {};
  for (const [key, rawItems] of Object.entries(parsed)) {
    if (!allowed.has(key)) {
      throw new Error(`${name} has unsupported key "${key}". Allowed keys: ${allowedKeys.join(', ')}.`);
    }
    if (!Array.isArray(rawItems)) {
      throw new Error(`${name}.${key} must be an array of strings.`);
    }
    if (rawItems.length > ARRAY_MAX_ITEMS) {
      throw new Error(`${name}.${key} must contain at most ${ARRAY_MAX_ITEMS} items.`);
    }
    const maxLength = termKeys.has(key) ? TERM_MAX_LENGTH : STRING_MAX_LENGTH;
    normalized[key] = rawItems.map((item) => normalizeString(item, `${name}.${key} item`, { maxLength }));
  }
  return normalized;
}

function scopeIdentity(scopeType, scopeKey) {
  return `${scopeType}:${scopeKey}`;
}

function memberIdentity(member) {
  return scopeIdentity(member.scopeType, member.scopeKey);
}

function memberOutput(member, reasons) {
  return {
    scope: member.scopeType,
    scopeType: member.scopeType,
    scopeKey: member.scopeKey,
    memberName: member.name,
    role: member.role,
    priority: member.priority,
    includeByDefault: Boolean(member.includeByDefault),
    includedBecause: reasons,
  };
}

function excludedMemberOutput(member, reasons) {
  return {
    scope: member.scopeType,
    scopeType: member.scopeType,
    scopeKey: member.scopeKey,
    memberName: member.name,
    role: member.role,
    priority: member.priority,
    excludedBecause: reasons,
  };
}

function queryText(value) {
  return String(value || '').toLowerCase();
}

function termsMatched(terms = [], query) {
  const haystack = queryText(query);
  return terms.filter((term) => haystack.includes(String(term).toLowerCase()));
}

function ruleMatches(rule, { query, consultReason }) {
  const match = rule.match || {};
  const matchedTermsAny = termsMatched(match.termsAny || [], query);
  if ((match.termsAny || []).length > 0 && matchedTermsAny.length === 0) {
    return null;
  }
  const matchedTermsAll = termsMatched(match.termsAll || [], query);
  if ((match.termsAll || []).length > 0 && matchedTermsAll.length !== match.termsAll.length) {
    return null;
  }
  const reasons = match.consultReasonsAny || [];
  if (reasons.length > 0 && !reasons.includes(consultReason)) {
    return null;
  }
  return {
    ruleKey: rule.ruleKey,
    matchedTerms: [...new Set([...matchedTermsAny, ...matchedTermsAll])],
    includedRoles: rule.include?.roles || [],
    includedMembers: rule.include?.members || [],
    includedScopeKeys: rule.include?.scopeKeys || [],
    excludedRoles: rule.exclude?.roles || [],
    excludedMembers: rule.exclude?.members || [],
    excludedScopeKeys: rule.exclude?.scopeKeys || [],
    includeShared: Boolean(rule.includeShared),
  };
}

function memberMatchesSpec(member, spec = {}) {
  const roles = new Set(spec.roles || []);
  const members = new Set(spec.members || []);
  const scopeKeys = new Set(spec.scopeKeys || []);
  return (
    roles.has(member.role) ||
    members.has(member.name) ||
    scopeKeys.has(member.scopeKey) ||
    scopeKeys.has(memberIdentity(member))
  );
}

function addIncluded(included, member, reason) {
  const key = memberIdentity(member);
  if (!included.has(key)) {
    included.set(key, { member, reasons: [] });
  }
  const entry = included.get(key);
  if (!entry.reasons.includes(reason)) {
    entry.reasons.push(reason);
  }
}

function addExcluded(excluded, member, reason) {
  const key = memberIdentity(member);
  if (!excluded.has(key)) {
    excluded.set(key, { member, reasons: [] });
  }
  const entry = excluded.get(key);
  if (!entry.reasons.includes(reason)) {
    entry.reasons.push(reason);
  }
}

function removeIncluded(included, excluded, member, reason, warnings) {
  const key = memberIdentity(member);
  const entry = included.get(key);
  addExcluded(excluded, member, reason);
  if (!entry) {
    return;
  }
  if (entry.reasons.includes('primary_scope')) {
    warnings.push({
      code: 'primary_scope_matched_exclude_rule',
      message: 'Primary scope matched a workspace exclude rule but remains included because primary scope wins.',
      scope: {
        scope: member.scopeType,
        scopeType: member.scopeType,
        scopeKey: member.scopeKey,
        memberName: member.name,
        role: member.role,
      },
      reason,
    });
    return;
  }
  included.delete(key);
}

function noOpPlan({ workspaceKey = null, mode, warnings = [] }) {
  return {
    kind: 'workspace_scope_plan',
    enabled: false,
    mode,
    workspace: workspaceKey ? { workspaceKey } : null,
    primaryScope: null,
    includedScopes: [],
    excludedScopes: [],
    includeShared: false,
    matchedRules: [],
    warnings,
  };
}

export function resolveWorkspaceScopePlan({
  workspace,
  members = [],
  routingRules = [],
  primaryScope = 'repo',
  primaryScopeKey,
  query = '',
  consultReason = 'unknown',
  mode = 'auto',
  includeShared = false,
} = {}) {
  const normalizedMode = normalizeWorkspaceMode(mode);
  const warnings = [];
  const workspaceKey = workspace?.workspaceKey || null;
  if (normalizedMode === 'off') {
    return noOpPlan({
      workspaceKey,
      mode: normalizedMode,
      warnings: [{ code: 'workspace_mode_off', message: 'Workspace federation is disabled by workspaceMode=off.' }],
    });
  }
  if (!workspace || workspace.status !== 'active') {
    const warning = {
      code: workspace ? 'workspace_inactive' : 'workspace_not_found',
      message: workspace
        ? `Workspace profile is not active: ${workspace.workspaceKey}`
        : 'Workspace profile was not found.',
    };
    if (normalizedMode === 'strict') {
      throw new Error(warning.message);
    }
    return noOpPlan({ workspaceKey, mode: normalizedMode, warnings: [warning] });
  }

  const scopeType = normalizeScopeType(primaryScope || 'repo');
  const scopeKey = normalizeString(primaryScopeKey, 'primaryScopeKey');
  const activeMembers = members.filter(Boolean);
  const primary = activeMembers.find((member) => member.scopeType === scopeType && member.scopeKey === scopeKey) || null;
  if (!primary) {
    const warning = {
      code: 'primary_scope_not_workspace_member',
      message: 'Primary scope is not an active member of the workspace profile.',
      scope: { scope: scopeType, scopeType, scopeKey },
    };
    if (normalizedMode === 'strict') {
      throw new Error(warning.message);
    }
    return noOpPlan({ workspaceKey: workspace.workspaceKey, mode: normalizedMode, warnings: [warning] });
  }

  const included = new Map();
  const excluded = new Map();
  addIncluded(included, primary, 'primary_scope');
  for (const member of activeMembers) {
    if (member.includeByDefault) {
      addIncluded(included, member, 'include_by_default');
    }
  }

  const canonicalScope = workspace.canonicalScopeKey
    ? {
        scope: workspace.canonicalScopeType,
        scopeType: workspace.canonicalScopeType,
        scopeKey: workspace.canonicalScopeKey,
      }
    : null;
  if (canonicalScope) {
    const canonicalMember = activeMembers.find(
      (member) => member.scopeType === canonicalScope.scopeType && member.scopeKey === canonicalScope.scopeKey,
    );
    if (canonicalMember) {
      addIncluded(included, canonicalMember, 'canonical_scope');
    } else {
      warnings.push({
        code: 'canonical_scope_not_member',
        message: 'Workspace canonical scope is configured but not present in active members.',
        scope: canonicalScope,
      });
    }
  }

  const matchedRules = [];
  const activeRules = routingRules
    .filter((rule) => rule.status === 'active')
    .sort((a, b) => b.priority - a.priority || a.ruleKey.localeCompare(b.ruleKey));
  let resolvedIncludeShared = Boolean(includeShared);
  for (const rule of activeRules) {
    const match = ruleMatches(rule, { query, consultReason });
    if (!match) {
      continue;
    }
    matchedRules.push(match);
    if (rule.includeShared) {
      resolvedIncludeShared = true;
    }
    for (const member of activeMembers) {
      if (memberMatchesSpec(member, rule.include)) {
        addIncluded(included, member, `routing_rule:${rule.ruleKey}`);
      }
    }
    for (const member of activeMembers) {
      if (memberMatchesSpec(member, rule.exclude)) {
        // Primary membership is never removed. Explicit exclude rules win over
        // canonical/default/routing includes for every other member.
        removeIncluded(included, excluded, member, `excluded_by_rule:${rule.ruleKey}`, warnings);
      }
    }
  }

  const includedScopes = [...included.values()]
    .sort((a, b) => b.member.priority - a.member.priority || a.member.name.localeCompare(b.member.name))
    .map((entry) => memberOutput(entry.member, entry.reasons));
  const includedKeys = new Set(includedScopes.map((member) => scopeIdentity(member.scopeType, member.scopeKey)));
  const excludedScopes = activeMembers
    .filter((member) => !includedKeys.has(memberIdentity(member)))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    .map((member) => excludedMemberOutput(member, excluded.get(memberIdentity(member))?.reasons || ['no_query_signal']));

  return {
    kind: 'workspace_scope_plan',
    enabled: true,
    mode: normalizedMode,
    workspace: {
      workspaceKey: workspace.workspaceKey,
      displayName: workspace.displayName,
      canonicalScope,
    },
    primaryScope: {
      scope: primary.scopeType,
      scopeType: primary.scopeType,
      scopeKey: primary.scopeKey,
      memberName: primary.name,
      role: primary.role,
    },
    includedScopes,
    excludedScopes,
    includeShared: resolvedIncludeShared,
    matchedRules,
    warnings,
  };
}
