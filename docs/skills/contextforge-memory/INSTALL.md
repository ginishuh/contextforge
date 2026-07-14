# Installing The contextforge-memory Skill

Install `contextforge-memory` in every agent runtime that will use ContextForge.
Do not rely on repository-relative paths such as
`docs/skills/contextforge-memory/SKILL.md` from downstream repos; those paths
only exist inside the ContextForge repo.

## Source Package

The ContextForge repo packages the skill from:

```text
docs/skills/contextforge-memory/
```

Runtime installation copies `SKILL.md` and the UI metadata in
`agents/openai.yaml`. `INSTALL.md` is public installation documentation, not a
runtime skill file.

When the skill changes, update the installed skill through the runtime's normal
skill installation or update mechanism.

## Codex

Codex should have `contextforge-memory` installed as a real Codex skill. Once
installed, Codex can use it by skill name, including explicit `$` invocation
when needed:

```text
$contextforge-memory
```

The installed skill should resolve as `contextforge-memory` in Codex's skill
list. The source package in this repo is the content to install or update from;
it is not the path downstream `AGENTS.md` files should tell agents to read.

## Runtime Installation

Install the same `contextforge-memory` skill through each runtime's native
skill installer.

The installed skill name should remain:

```text
contextforge-memory
```

Repository `AGENTS.md` files should simply say:

```text
For full ContextForge MCP workflow rules, use the installed
`contextforge-memory` skill.
```

## Verification

After installing or updating the skill:

1. Confirm the runtime lists or recognizes `contextforge-memory`.
   Its default prompt should explicitly invoke `$contextforge-memory`.
2. Start a fresh agent session.
3. Ask the agent to use `$contextforge-memory` or invoke the skill by name.
4. Confirm the skill guidance covers bootstrap, storage authority, session IDs,
   distillation, checkpoint candidates, scope backlog review, candidate
   lifecycle workers, closeout promotion, corrections, and embeddings.

If `contextforge-memory` is not available in a session, the runtime skill
installation is incomplete. Install or update the skill before doing
ContextForge memory work.
