# AGENTS.md - ContextForge

ContextForge is a standalone public project. Treat it as separate from the
OpenClaw workspace.

## Mission

Build a self-hosted memory and distillation runtime for coding agents.

The core idea is not another flat memory file. ContextForge should provide:

- canonical durable memory
- scoped retrieval
- raw evidence capture
- LLM-distilled checkpoints
- adapters for coding agents such as Codex and Claude Code
- optional MCP access

## Source Boundary

The working OpenClaw agent-memory system is the original reference
implementation, but do not mutate it while working in this repo.

- Do not edit `/home/ubuntu/.openclaw/workspace` unless the user explicitly asks.
- Do not copy private OpenClaw/persona/user data into this repo.
- When borrowing code, extract generic engine logic only.
- Remove OpenClaw-specific paths, agent names, hooks, secrets, and assumptions.
- Keep this repo usable without OpenClaw installed.

## Product Principles

- Distillation is a core capability, not a cosmetic add-on.
- Distillation providers must be pluggable.
- Prefer bring-your-own execution: `codex_exec`, `claude_code_exec`, direct APIs,
  or local model runners.
- Keep prompt preload small. Retrieve details on demand.
- Store runtime data locally by default and keep it out of git.
- Support `shared`, `repo`, and `local` scopes explicitly.
- Treat checkpoints as recent continuity, not canonical truth.
- Promote durable facts and decisions intentionally.

## Storage Modes

Design for three storage modes:

- `local`: default single-machine SQLite storage
- `project-local`: repo-bound storage in a gitignored directory
- `remote`: VPS/server-backed canonical memory for multiple machines

Do not recommend git as the live storage backend for SQLite or raw runtime data.
Git may be used for source code, examples, docs, and reviewed exports only.

## Minimal Core

Start small. The first useful version should focus on:

- schema and migrations
- CLI entrypoints
- `beginSession`
- `search`
- `getMemory`
- `remember`
- `appendRaw`
- `distillCheckpoint`
- MCP or adapter surface after the core is stable

Avoid building UI, multi-tenant SaaS, or broad provider integrations before the
local engine is solid.

## Safety

- Never commit `.db`, `.db-wal`, `.db-shm`, raw logs, or `.env` files.
- Keep examples synthetic and non-personal.
- Document failure modes clearly.
- Distill failure should not erase raw evidence.
- Retrieval should be explainable enough to debug why a memory was returned.

## Style

- Keep code and docs boring, explicit, and portable.
- Favor small modules and clear contracts over clever abstractions.
- Prefer Node.js for continuity with the original implementation unless there is
  a strong reason to introduce another runtime.
- Use ASCII unless an existing file already requires otherwise.
