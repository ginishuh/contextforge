# Using ContextForge With Coding Agents

ContextForge does not require a separate agent skill. Connect the MCP server
and give the agent a short repository instruction identifying the memory scope
and when to consult prior context. See the [copyable instruction](agent-instructions.md).

Use `bootstrap_context` at a relevant task start or resume, then `search` and
returned detail pointers as needed. Reviewed `memory` is durable knowledge;
`checkpoint` is recent handoff context; `memory_candidate` is review material.
Check changing Git, CI, deployment, and runtime facts at their live source.

Keep `repo`, `shared`, and `local` scopes intentional. Pass a repository identity
such as `github.com/owner/repo` in `scopeKey`; `repoPath` and `cwd` are filesystem
paths. `workspaceKey` explicitly
opts into cross-repository retrieval. `connection.accessMode` distinguishes
canonical remote access from checkout-local context. `bootstrap_context` does
not create a session: use the adapter's binding or a known session ID, never an
unrelated latest session.

The configured adapter and workers capture evidence, distill checkpoints,
audit candidates, and apply approved durable-memory decisions. Automatic writes
require server enablement. Installing or reading a skill is not a prerequisite
for these operations. Distillation failure must not erase raw evidence.

Agents can request a useful checkpoint with `distill_checkpoint` and deliberately
save or correct reviewed facts with `remember`, `correct_memory`, and
`deactivate_memory`. They do not need to call audit and promotion tools at the
end of every task to keep the background pipeline working.

## Guides

Read the relevant guide when the task requires detail; these are ordinary
product documents, not mandatory startup material.

- [Retrieval and handoff](guides/bootstrap-and-retrieval.md)
- [Sessions and evidence](guides/sessions-and-evidence.md)
- [Distillation and jobs](guides/distillation-and-jobs.md)
- [Promotion and corrections](guides/closeout-and-corrections.md)
- [Candidate lifecycle operations](guides/candidate-lifecycle.md)
- [Tool profiles and storage authority](guides/tool-profiles-and-authority.md)
- [Workspaces and scope migration](guides/workspaces-and-scope-migration.md)
- [Embeddings and maintenance](guides/embeddings-and-maintenance.md)

For installation and service configuration, see [runtime modes](runtime-modes.md)
and [operations](operations.md).

## Upgrading From The Packaged Skill

Older releases distributed a `contextforge-memory` skill. Its useful reference
material now lives in the guides above. Remove obsolete skill-installation
instructions from repository guidance. Existing installed copies can be removed
through the host's skill-management mechanism; they are not needed to connect
to ContextForge or use its tools. Updating this package does not modify those
external installations automatically.
