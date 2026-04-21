# Architecture

ContextForge separates memory into three concerns:

- durable memory: facts, rules, decisions, and preferences that should persist
- checkpoints: LLM-distilled recent working context
- raw evidence: append-only source material used for audit and distillation

Scopes are intentionally explicit:

- `shared`: common user or organization knowledge
- `repo`: project-specific memory
- `local`: machine-specific notes and temporary state

The default runtime should minimize prompt injection by preloading only compact
context and using search/get calls for detail retrieval.
