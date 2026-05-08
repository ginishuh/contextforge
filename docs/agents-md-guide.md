# AGENTS.md Authoring Guide

Use this guide when creating or maintaining repository-level `AGENTS.md` files
for projects that use ContextForge.

`AGENTS.md` is a local operating contract for agents working in a repository.
It should be short enough to read at session start and specific enough to
prevent unsafe or off-scope work. It is not the place for full ContextForge MCP
documentation, full tool manuals, or agent-runtime-specific installation
instructions.

## Document Roles

Keep these responsibilities separate:

- `AGENTS.md`: repository-specific rules, safety boundaries, commands, and a
  short ContextForge bootstrap.
- installed `contextforge-memory` skill: full agent-neutral ContextForge MCP
  workflow for bootstrap, scopes, session IDs, evidence capture, distillation,
  candidate review, closeout, corrections, and embeddings.
- `docs/skills/contextforge-memory/SKILL.md`: source package for the
  `contextforge-memory` skill inside the ContextForge repo.
- `docs/agent-instructions.md`: copyable prompt snippets and compatibility
  entrypoint for agents that need text snippets.
- README or runtime-specific docs: installation and update instructions for
  agent systems such as Codex skills, Claude Code instructions, or other
  skill/instruction-bundle mechanisms.

## What Belongs In AGENTS.md

Include only guidance that an agent must know before touching this repository:

- the repository mission or product boundary
- source/privacy boundaries
- build, test, lint, release, or deploy commands for this repo
- files or data that must not be committed
- short runtime-mode guidance when ContextForge state affects work
- repo-specific coding and documentation style
- language or reporting expectations when they are part of the repo workflow
- a short ContextForge bootstrap snippet
- the canonical ContextForge `scopeKey` when it cannot be inferred reliably
- a note to use the installed `contextforge-memory` skill

If a rule applies to many repositories and is not specific to the current
checkout, put it in a reusable guide instead.

## What To Keep Out

Do not put these in `AGENTS.md`:

- full ContextForge MCP usage instructions
- long closeout promotion procedures
- tool schemas or complete tool-by-tool manuals
- runtime-specific install paths such as `~/.codex/skills/...`
- hard-coded `docs/skills/...` paths in downstream repositories
- generic VPS, Docker, Nginx, or system administration manuals
- large examples that are not needed before first action
- policies copied from another private workspace
- secrets, private paths, customer data, or local runtime assumptions

When a detail is useful but not repo-specific, link to it. When a detail is
repo-specific but long, move it into a repo doc and link to that doc.
For ContextForge deployment topology, link to `docs/runtime-modes.md` instead
of pasting the full local/server/remote setup guide.

## Runtime Mode Section Pattern

Runtime mode is checkout-local. Keep tracked `AGENTS.md` clone-safe and prefer
live `connection.mode`.

```text
## Runtime Mode

Runtime mode is checkout-local. Do not assume a clone is the live server.

At task start, check `connection.mode` with `db_info` or `bootstrap_context`.
Verify `/healthz`, the service manager, and current git state before making
live runtime claims.

Keep env files, tokens, API keys, DB files, and raw runtime data out of git and
reports. For local all-in-one, HTTP server, and external remote client
distinctions, follow `docs/runtime-modes.md`.
```

Keep token values, API keys, private customer data, full env-file contents,
host-specific ports, and service names out of tracked `AGENTS.md` unless they
are stable product documentation.

## ContextForge Section Pattern

Prefer a compact section like this:

```text
## ContextForge MCP Bootstrap

Use ContextForge MCP for scoped project memory when it is available.

At task start, call `bootstrap_context` with this task, `scope: "repo"`, and
this repo path or the canonical scope key `github.com/owner/repo`. Include
shared memory only when cross-repo or user-wide policy may matter.

Trust result types by role: `memory` is reviewed durable state, `checkpoint`
is credible recent handoff state that still needs live verification, and
`memory_candidate` is review material.

Critical session invariant: `bootstrap_context` does not create a session. Use
the adapter session id such as `codex:<id>` or `claude_code:<id>` for
`session_status`, `distill_checkpoint`, and closeout. Use `begin_session` only
for manual `append_raw` evidence streams.

For full ContextForge MCP workflow, use the installed `contextforge-memory`
skill.
```

Add repo-specific scope keys or storage notes only when they are necessary for
correct operation.

## Skill Or Guide References

`AGENTS.md` should tell agents to use the installed skill, not to read a
repository-relative path that may not exist in other checkouts.

```text
For full ContextForge MCP workflow, use the installed `contextforge-memory`
skill.
```

Do not describe every runtime's installation path in `AGENTS.md`. Put those
details in README or a runtime-specific setup document. For
`contextforge-memory`, use `docs/skills/contextforge-memory/INSTALL.md`.

## Review Checklist

Before committing an `AGENTS.md` change, check:

- Can an agent scan it quickly before work starts?
- Is each rule specific to this repository or necessary before first action?
- Are long workflows linked instead of pasted?
- Does the ContextForge section mention the session invariant?
- Does it point to the installed `contextforge-memory` skill instead of a
  downstream-only relative path?
- Are private references, secrets, and local-only assumptions absent?
- Are build/test/safety commands current and easy to run?

When in doubt, shorten `AGENTS.md` and move the detail to a guide.
