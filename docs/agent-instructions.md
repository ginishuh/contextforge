# ContextForge Agent Instructions

Keep these instructions in each repository's `AGENTS.md`, rather than putting
one repository's scope key in global guidance. Replace the example keys with
your repository's canonical identity and, when applicable, configured workspace.

## Single Repository

```text
Use ContextForge for relevant prior context at task start or resume.
Repository memory scope: scope="repo", scopeKey="github.com/owner/repo".
```

## Multiple Repositories In One Workspace

Keep a distinct `scopeKey` for each repository and use the same `workspaceKey`
when cross-repository context is relevant:

```text
Use ContextForge for relevant prior context at task start or resume.
Repository memory scope: scope="repo", scopeKey="github.com/owner/product-api"; use workspaceKey="product" for cross-repository context.
```

For example, a coordinator might use `github.com/owner/product-suite`, an API
repository `github.com/owner/product-api`, and a web repository
`github.com/owner/product-web`. Each uses its own scope key and the same
`workspaceKey="product"`. A coordinator's scope does not replace member scopes.

The workspace profile, members, and any routing rules must already be configured
in ContextForge; adding these lines does not create them. Pass `workspaceKey`
for cross-repository retrieval and omit it for repo-only retrieval. A profile
does not activate federation unless the caller passes the key. See
[Workspaces and scope migration](guides/workspaces-and-scope-migration.md).

No tool manual, session procedure, or audit/promotion checklist needs to
be copied into the host repository: MCP describes tool use, and the configured
runtime handles evidence, distillation, audit, and automatic memory promotion.

For optional detail, see the [Agent Guide](agent-guide.md),
[AGENTS.md Authoring Guide](agents-md-guide.md), and [Runtime Modes](runtime-modes.md).
