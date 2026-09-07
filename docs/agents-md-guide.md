# AGENTS.md Authoring Guide

`AGENTS.md` is a short local operating contract for agents in one repository.
Keep product boundaries, relevant commands, and repository-specific constraints
there. Keep generic tool manuals and runtime procedures in normal documentation.

## ContextForge Pattern

The host repository needs only two ContextForge instructions: when to consult
prior context and which repository memory scope to use. Copy the two-line
snippet from [Agent Instructions](agent-instructions.md).

Add `workspaceKey` only for intentional cross-repository retrieval. Tool usage,
result interpretation, session binding, and audit/promotion procedures do not
belong in the host snippet; MCP and the configured runtime provide those.

For optional detail, use the [Agent Guide](agent-guide.md) and
[Runtime Modes](runtime-modes.md). Keep secrets, customer data, and raw runtime
evidence out of tracked guidance.
