# ContextForge

Self-hosted memory and distillation runtime for coding agents.

ContextForge is designed for agents that need more than a flat memory file:
canonical project memory, scoped retrieval, evidence-preserving raw logs, and
LLM-backed distillation into checkpoints.

## Goals

- Keep durable memory in a canonical local store.
- Support shared, repo, and local scopes without mixing them accidentally.
- Use retrieval on demand instead of dumping large memory files into context.
- Treat distillation as a core capability with pluggable providers.
- Work with coding agents such as Codex and Claude Code through adapters or MCP.

## Storage Modes

- `local`: default single-machine SQLite storage.
- `project-local`: repo-bound storage in a gitignored directory.
- `remote`: VPS or server-backed canonical memory for multiple machines.

## Distillation

ContextForge assumes useful checkpoints need an LLM. The runtime should support
bring-your-own distillation providers, such as:

- `codex_exec`
- `claude_code_exec`
- direct model APIs
- local model runners

## Status

Early extraction from a working OpenClaw agent-memory system. The first public
version should focus on a small core before copying any OpenClaw-specific code.
