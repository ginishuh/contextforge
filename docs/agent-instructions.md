# ContextForge Agent Instructions

Add these two lines to a repository's `AGENTS.md`. Replace the example scope key
with the repository's canonical identity.

```text
Use ContextForge for relevant prior context at task start or resume.
Repository memory scope: scope="repo", scopeKey="github.com/owner/repo".
```

Add a `workspaceKey` only when the repository intentionally uses cross-repository
memory. No tool manual, session procedure, or audit/promotion checklist needs to
be copied into the host repository: MCP describes tool use, and the configured
runtime handles evidence, distillation, audit, and automatic memory promotion.

For optional detail, see the [Agent Guide](agent-guide.md),
[AGENTS.md Authoring Guide](agents-md-guide.md), and [Runtime Modes](runtime-modes.md).
