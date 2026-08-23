import {
  normalizeConsultReason,
  requireOption,
  truthyOption,
} from '../common.js';
import {
  normalizeScopeType,
  normalizeWorkspaceKey,
  normalizeWorkspaceMemberInput,
  normalizeWorkspaceMode,
  normalizeWorkspaceProfileInput,
  normalizeWorkspaceRoutingRuleInput,
  resolveWorkspaceScopePlan,
} from './resolve.js';

// Workspace profile, member, and routing-rule operations, spread into the app
// object by core.js. They are written as object-literal shorthand methods
// because deactivateWorkspaceProfile delegates through `this` to its sibling —
// arrow functions would break that.
export function workspaceProfileMethods({ useStore }) {
  return {
    upsertWorkspaceProfile(options = {}) {
      const profile = normalizeWorkspaceProfileInput(options);
      return useStore((store) => store.upsertWorkspaceProfile(profile));
    },

    getWorkspaceProfile(options = {}) {
      const workspaceKey = normalizeWorkspaceKey(options.workspaceKey);
      const includeInactive = truthyOption(options.includeInactive);
      return useStore((store) => {
        const profile = store.getWorkspaceProfileByKey({ workspaceKey, includeInactive });
        if (!profile) {
          return null;
        }
        return {
          ...profile,
          members: store.listWorkspaceMembers({ workspaceKey }),
          routingRules: store.listWorkspaceRoutingRules({
            workspaceKey,
            status: includeInactive ? 'all' : 'active',
          }),
        };
      });
    },

    listWorkspaceProfiles(options = {}) {
      return useStore((store) =>
        store.listWorkspaceProfiles({
          status: options.status || 'active',
          limit: options.limit == null ? 100 : Number(options.limit),
        }),
      );
    },

    deleteWorkspaceProfile(options = {}) {
      const workspaceKey = normalizeWorkspaceKey(options.workspaceKey);
      return useStore((store) => {
        const profile = store.setWorkspaceProfileStatus({ workspaceKey, status: 'inactive' });
        if (!profile) {
          throw new Error(`Workspace profile not found: ${workspaceKey}`);
        }
        return profile;
      });
    },

    deactivateWorkspaceProfile(options = {}) {
      return this.deleteWorkspaceProfile(options);
    },

    upsertWorkspaceMember(options = {}) {
      const member = normalizeWorkspaceMemberInput(options);
      return useStore((store) => store.upsertWorkspaceMember(member));
    },

    removeWorkspaceMember(options = {}) {
      const workspaceKey = normalizeWorkspaceKey(options.workspaceKey);
      const name = options.memberName || options.name || null;
      const scopeType = options.scope || options.scopeType ? normalizeScopeType(options.scope || options.scopeType) : null;
      const scopeKey = options.scopeKey || null;
      return useStore((store) =>
        store.removeWorkspaceMember({
          workspaceKey,
          name,
          scopeType,
          scopeKey,
        }),
      );
    },

    upsertWorkspaceRoutingRule(options = {}) {
      const rule = normalizeWorkspaceRoutingRuleInput(options);
      return useStore((store) => store.upsertWorkspaceRoutingRule(rule));
    },

    removeWorkspaceRoutingRule(options = {}) {
      const workspaceKey = normalizeWorkspaceKey(options.workspaceKey);
      requireOption(options.ruleKey, 'ruleKey');
      return useStore((store) => store.removeWorkspaceRoutingRule({ workspaceKey, ruleKey: options.ruleKey }));
    },

    resolveWorkspace(options = {}) {
      const mode = normalizeWorkspaceMode(options.workspaceMode || options.mode || 'auto');
      const workspaceKey = normalizeWorkspaceKey(options.workspaceKey);
      const primaryScope = options.primaryScope || options.primaryScopeType || options.scope || options.scopeType || 'repo';
      const primaryScopeKey = options.primaryScopeKey || options.scopeKey;
      requireOption(primaryScopeKey, 'primaryScopeKey');
      const consultReason = options.consultReason ? normalizeConsultReason(options.consultReason) : 'unknown';
      return useStore((store) => {
        const workspace = store.getWorkspaceProfileByKey({ workspaceKey, includeInactive: true });
        const members = workspace ? store.listWorkspaceMembers({ workspaceKey }) : [];
        const routingRules = workspace ? store.listWorkspaceRoutingRules({ workspaceKey, status: 'all' }) : [];
        return resolveWorkspaceScopePlan({
          workspace,
          members,
          routingRules,
          primaryScope,
          primaryScopeKey,
          query: options.query || '',
          consultReason,
          mode,
          includeShared: truthyOption(options.includeShared),
        });
      });
    },
  };
}
