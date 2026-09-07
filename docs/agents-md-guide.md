# AGENTS.md Authoring Guide

`AGENTS.md` is a short local operating contract for agents in one repository.
It should cover only what an agent must know before acting: product and privacy
boundaries, relevant commands, data that must stay out of Git, local runtime
facts, and reporting expectations.

Keep full MCP manuals, long lifecycle procedures, installation instructions,
tool schemas, and generic host operations out of it. Link to a normal document
when those details are needed.

## ContextForge Pattern

Use the compact snippet from [Agent Instructions](agent-instructions.md). Add a
canonical `scopeKey` or a short runtime-mode note only when this repository
needs it for correct retrieval. Point readers to the [Agent Guide](agent-guide.md)
for detailed topics.

The minimum ContextForge contract is:

- call `bootstrap_context` at a task-relevant start or resume and `search` for
  targeted retrieval;
- keep repo scope and any `workspaceKey` explicit;
- treat `memory` as reviewed durable knowledge, `checkpoint` as recent
  handoff requiring live verification, and `memory_candidate` as review
  material;
- preserve an adapter-bound session ID, or pass the exact `sessionId` when no
  binding exists; and
- verify mutable Git, CI, runtime, and deployment facts from their live source.

Do not paste detailed candidate audit, promotion, embedding, or maintenance
procedures into `AGENTS.md`; the runtime and its operators own those workflows.

For local all-in-one, server, and external-client distinctions, link to
[Runtime Modes](runtime-modes.md). Keep secrets, private paths, customer data,
raw runtime evidence, and host-specific assumptions out of tracked guidance.
