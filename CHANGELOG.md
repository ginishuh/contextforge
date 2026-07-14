# Changelog

## Unreleased

- Updated the packaged `contextforge-memory` skill with explicit scope-backlog
  review, durable audit routing, snooze/wake/stale handling, and supervised
  candidate lifecycle operations. The skill now distinguishes the bounded MCP
  review/operator surfaces from the specialized Admin UI and HTTP/core backlog
  aggregate. The MCP audit submission schema now exposes the core's explicit
  bounded `candidateIds` backlog source, and regression tests guard both the
  tool schema and packaged-skill lifecycle contract. Packaged Codex UI metadata
  now ships with an explicit `$contextforge-memory` prompt and candidate-review
  description so runtime installations do not drift from the skill body. The
  skill now uses progressive disclosure for workspace migration, candidate
  lifecycle operations, and embedding maintenance, with regression budgets of
  340 lines and 18 KB for the always-loaded `SKILL.md` body, 120 lines and 6 KB
  per on-demand reference, and 14 KB across all references.
- Added operation-worker freshness to `/readyz` with a bounded startup grace
  period and an explicit `operation_worker_stale` reason. Operational metrics
  now include candidate throughput/latency, audit decision and routing
  distributions, 7/30-day correction or deactivation rates, active duplicate
  and transient-promotion rates, provider/model/prompt quality slices, and the
  share of active durable memories actually returned by retrieval. Retrieval
  usage stores only per-memory counters and timestamps, not queries. The npm
  package budgets are now 600 KB packed, 2.5 MB unpacked, and 150 entries for
  the extracted readiness and lifecycle-quality modules, the supervised
  candidate lifecycle worker, packaged service installers, and bounded
  follow-up growth.
- Added a supervised candidate lifecycle worker that walks an explicit repo
  registry, wakes expired snoozes, queues idle small-session audits, applies
  bounded stale SLA transitions, and processes audit jobs within each canonical
  scope. The CLI defaults to dry-run, while the systemd installer opts into
  mutation explicitly. Candidate lifecycle shutdown cooperates at scope-stage
  boundaries, and every packaged remote watcher now loads a private generated
  authority environment file after its token file to force remote mode without
  exposing the remote URL in the process command line. Packaged remote watchers
  use bounded remote timeouts by default (300 seconds for the conservative
  one-session/two-candidate/one-job lifecycle worker, 180 seconds for ingest
  watchers), and durable job workers pass that client deadline into nested
  provider execution so timeout mismatches fail before a client can abandon
  server-side work.

## 0.5.1 - 2026-07-10

- Reworked the English and Korean READMEs into synchronized quick-start entry
  points, preserved the previous long-form material as full reference docs, and
  added an automated release-hygiene gate for Markdown links, documented
  commands, version drift, npm package contents, and size budgets. The npm
  package now excludes repository-only explainer images and historical issue
  documents while keeping them in Git, reducing the packed baseline by roughly
  two thirds.
- Added deterministic offline retrieval/distillation/candidate quality evals
  with Recall@k, MRR, nDCG, multilingual and scope-leakage slices, exact-string
  preservation, source-linked hallucination checks, truncation retrieval hooks,
  candidate precision/classification, reviewed baselines, regression thresholds,
  explainable failure details, and a CI report artifact.
- Added a canonical operation registry that generates remote methods,
  capability/scope authorization metadata, MCP dispatch, and MCP read-only
  semantics. Extracted bounded pagination and SQLite compatibility migration
  manifests into application/storage modules, added domain contract tests, and
  introduced a CI source-lint/non-growth gate for the remaining large files.
- Added deny-by-default capability- and scope-limited API token policies shared
  by HTTP JSON and HTTP MCP. Policies support environment-referenced or hashed
  secrets, explicit `read`/`write`/`review`/`operator` capabilities, exact or
  wildcard scope rules, expiry, revocation, legacy full-token migration, and
  non-secret token identity correlation in durable jobs and LLM usage events.
- Added `/readyz` DB/schema/disk/queue readiness, authenticated Prometheus
  `/metrics`, request/job correlation ids, and graceful HTTP drain on
  SIGTERM/SIGINT. SQLite now reports an explicit WAL/NORMAL/5s busy-timeout
  policy. Added verified online backups, metadata/hash/quick/foreign-key checks,
  dry-run-first offline restore with automatic pre-restore backup, and automatic
  private snapshots before schema upgrades.
- Added read-only embedding lifecycle inventory and dry-run-first bounded GC
  across core, CLI, remote API, and the MCP `operator` profile. Inventory
  classifies orphan sources, inactive memories, reviewed-out candidates,
  content-hash drift, retired model/dimension rows, vector-only rows, and old
  completed jobs. Destructive GC is transaction-batched, refuses active workers
  unless forced, preserves current active memories, pending/promoted candidates,
  and retryable failed-job history, and requires global mode for vector-only rows
  whose scope can no longer be proven. Retired model/dimension cleanup requires
  both an active embedding provider and explicit `includeRetired=true`, plus a
  separate confirmation when most indexed rows would be retired.
  Filter-bound keyset cursors let bounded inventory/GC calls advance across
  large stores instead of repeatedly scanning the same oldest rows; destructive
  batches rescan a capped page before advancing, and blocked calls preserve the
  input cursor, so eligible rows are not skipped.
- Added filter-bound opaque keyset cursors to public memory, raw-event,
  checkpoint, embedding-job, candidate, event, distill-run, and usage lists.
  Public arrays remain compatible but now default to 100 rows with a hard 500
  maximum; `page=true` returns a next-cursor envelope and CLI `--allPages`
  follows bounded pages explicitly.
- Removed the default scope-wide durable-memory lexical scan from retrieval.
  Search now scores bounded FTS/vector candidates with hard result/candidate
  caps, preserves Unicode/path/API/error ranking, exposes per-result latency and
  scanned/candidate source counts, and keeps the former substring full scan as
  an explicit diagnostic option. Added reproducible 100/1k/10k/100k and
  optional vector/hybrid benchmarks.
- Added bounded MCP tool profiles (`agent-core`, `review`, `operator`,
  `workspace-admin`, and `all`) with a 24-tool default, exact allowlist support,
  stdio/HTTP parity, startup validation, and a surface-report command that
  measures instructions, schemas, descriptions, and estimated prompt tokens.
  The compact server instructions now defer detailed workflows to the packaged
  `contextforge-memory` skill; `all` preserves the former surface and includes
  newly added operator tools during migration.
- Added SQLite-backed durable distill and candidate-audit jobs with idempotent
  submission, queued/running/succeeded/failed/cancelled states, bounded worker
  claims, renewable leases, crash recovery, retry limits, queued cancellation,
  and job provenance on distill runs, checkpoints, candidate audits, and LLM
  usage events. Core, CLI, remote JSON API, and MCP expose submit/get/list/
  process/cancel operations; audit workers remain explicitly per-candidate.
- Added a process-global per-provider concurrency cap, in-flight deduplication
  for same-session distill and candidate-audit retries, stored-audit reuse, and
  retryability metadata for failed provider runs. Child provider timeouts now
  wait for SIGTERM/SIGKILL process close before releasing capacity, and remote
  long-running calls fail early when the provider timeout cannot fit inside the
  client timeout.
- Raised the hosted-runner total test budget to 180 seconds while preserving
  the per-test slow threshold, avoiding false CI failures on slower Node 24
  runners without hiding localized test regressions.
- Refreshed transitive production dependencies to patched `hono` and `qs`
  releases and added a CI gate that rejects moderate-or-higher production
  dependency advisories.
- Hardened local SQLite storage by enforcing `0700` on POSIX data directories
  and `0600` on database/journal/WAL/SHM files, reporting the active permission
  policy in `dbInfo`, and documenting inherited ACL semantics on Windows. Plaintext
  runtime-secret writes are now disabled by default; environment credentials
  are recommended, while explicit DB storage requires an opt-in and returns a
  persistent warning.
- Unified MCP and CLI runtime version reporting with the canonical
  `package.json` version, including `contextforge --version` support and
  transport-level contract tests.
- Restored Unicode lexical retrieval for Korean and mixed-language queries,
  including embeddings-off search across memory keys, content, and tags while
  preserving path, API, and error-identifier token behavior.
- Corrected `audit_memory_candidates` MCP mutation annotations and response
  metadata: the tool does not promote durable memory, but it persists candidate
  review metadata and audit usage events and invokes the audit provider once per
  selected candidate.
- Added scope-key aliases plus an explicit `migrateScope` command for safely
  canonicalizing renamed or transferred repository scopes without read-union
  ambiguity.
- Fixed `/ui` asset loading for requests without a trailing slash and made
  admin UI session cookies HTTP-aware by default while preserving `Secure`
  cookies for HTTPS reverse-proxy deployments.
- Updated the `codex_exec` checkpoint output schema for strict structured
  output compatibility. New distill outputs must include the nullable
  memory-candidate v2 review fields (`schemaVersion`, `durabilityReason`,
  `riskReason`, `evidenceRefs`, and `suggestedAction`) when using the bundled
  strict schema.
- Updated `openai_compatible` `json_schema` mode to send a strict-safe
  checkpoint schema subset while preserving the default `json_object` behavior.
- Localized human-readable memory-candidate review text and audit reasons to
  Korean by default while keeping keys, enum values, paths, commands, and other
  technical identifiers machine-readable.

## 0.5.0 - 2026-06-03

- Added optional structured checkpoint handoff payloads for agent resume state,
  including mutable live-state verification hints.
- Preserved memory candidate v2 review fields in
  `memory_candidate_index.candidate_json`.
- Exposed deterministic latest checkpoint handoff in bootstrap/resume context.

## 0.4.2 - 2026-05-31

- Added bounded distillation catch-up commands:
  `listDueDistillSessions` and `processDueDistills` in core, CLI, remote API,
  and MCP as `list_due_distill_sessions` / `process_due_distills`.
- Made catch-up scanning continue from checkpoint `sourceRawEventIds`, respect
  normal distillation thresholds, skip active sessions through an idle window,
  and preserve small default processing batches for low-resource operation.
- Added `distillUsage` prompt-cache observability for providers that report
  prompt cache hit/miss tokens, including aggregate cache hit ratio.
- Fixed HOME-dependent non-git temp test setup so the full suite is stable when
  `/home/ubuntu` is itself inside a git worktree.

## 0.4.1 - 2026-05-20

- Added query-independent latest checkpoint handoff to `bootstrapContext` and
  the MCP `bootstrap_context` tool, returning `handoff.latestCheckpoints` by
  default so agents see recent work status before durable memory even when
  checkpoint search ranking loses to stable memories.
- Added `latestCheckpointLimit` (0-3 per scope) and repo
  `relatedScopeKeys` options for multi-repo suite/subrepo bootstraps, with CLI
  and MCP schema support.
- Updated agent guidance to treat checkpoints as the preferred source for
  recent handoff state while keeping durable memory for stable contracts,
  policies, decisions, and runbooks.

## 0.4.0 - 2026-05-14

- Added a Korean operator UI at `/ui/` for runtime dashboards, provider
  settings, distillation policy controls, memory management, candidate review,
  and recent distillation run inspection.
- Added DB-backed runtime settings that override environment defaults for new
  server-side calls, while keeping provider API keys write-only and redacted
  from read APIs.
- Added an OpenAI-compatible Chat Completions distillation provider for
  DeepSeek-style APIs, including DeepSeek presets, manual model entry,
  JSON-output modes, local checkpoint schema validation, and one repair retry.
- Kept `codex_exec` as a first-class selectable distillation provider with UI
  controls for command, model, reasoning effort, sandbox, timeout, and input
  limits.
- Added conservative automatic memory-promotion auditing through a separate
  `codex_exec` audit runner, defaulting to `gpt-5.5` with reasoning effort
  `low`, and rejecting unsupported audit provider configuration.
- Added admin login sessions, login state restoration, logout, no-store UI
  responses, scope-key dropdowns, bulk memory/candidate actions, and dashboard
  recent-run loading across remote-client deployments.
- Added `listDistillRuns` newest-first ordering support for dashboards and CLI
  inspection.

## 0.3.6 - 2026-05-08

- Added explicit ContextForge connection metadata to `dbInfo`, distinguishing
  direct local processes, HTTP server processes, and remote-client wrappers.
- Updated remote-client `bootstrapContext` results so the client perspective
  reports remote canonical storage while preserving the server-owned
  `serverMode` separately.
- Clarified agent guidance so remote servers reporting a local SQLite store are
  not mistaken for downstream local-only usage.

## 0.3.5 - 2026-05-08

- Added a portable `contextforge-memory` skill source package with installation
  notes for agent runtimes.
- Added `AGENTS.md` authoring guidance and runtime-mode documentation for
  clone-safe repo instructions and downstream ContextForge consumer repos.
- Trimmed repo `AGENTS.md` guidance so full ContextForge MCP workflow lives in
  the installed `contextforge-memory` skill.

## 0.3.4 - 2026-05-08

- Moved detailed ContextForge agent workflow guidance into the
  `contextforge-memory` skill source package and kept repo `AGENTS.md` focused
  on local operating rules.

## 0.3.3 - 2026-05-08

- Clarified MCP memory-candidate tool descriptions around session status,
  checkpoint distillation, candidate listing, and promotion.

## 0.3.2 - 2026-05-08

- Added closeout-source warnings for memory-candidate suggestion and automatic
  promotion calls without a current `sessionId` or `checkpointId`.

## 0.3.1 - 2026-05-08

- Expanded agent guidance for repo-scoped semantic continuation retrieval,
  vector result verification boundaries, durable promotion criteria, and
  memory-candidate review queue handling.
- Added `bootstrapContext` to the core API, CLI, remote API, and MCP
  `bootstrap_context` tool so agents can resolve startup memory context,
  storage/vector readiness, trust hints, and live-state verification reminders
  in one call.

- Fixed the `codex_exec` structured output schema so root fields and
  `sessionWorkingContext` fields satisfy Codex response-schema strictness,
  restoring live checkpoint distillation after the session working context
  addition.
- Added regression coverage for the full required-field schema contract used by
  `codex_exec`.
- Added `examples/server.env.example` and documented
  `CONTEXTFORGE_AUTO_PROMOTE_ENABLED`, embedding worker settings, and server
  env guidance for trusted deployments.

## 0.2.0 - 2026-05-01

- Added sqlite-vec backed derived embedding storage with startup `vec_version`
  reporting in `dbInfo`.
- Added OpenAI embeddings configuration with `text-embedding-3-small` defaults,
  configurable dimensions, dimensions request gating for legacy models, and
  server-side credential handling for remote mode.
- Added `rebuildEmbeddings` across the core API, CLI, remote API, and MCP
  `rebuild_embeddings` tool to backfill durable memories, checkpoints, and
  memory candidates.
- Added automatic checkpoint and memory-candidate embedding after successful
  `distillCheckpoint` runs, while keeping embedding failures from erasing or
  failing the checkpoint itself and reporting partial write progress.
- Expanded `search` so vector retrieval can return `memory`, `checkpoint`, and
  `memory_candidate` result types with transparent vector distance/model
  metadata, Korean/no-lexical-token vector fallback, lexical candidate unioning,
  and normalized hybrid ranking.
- Added a guard against silent vector-index drops when embedding dimensions
  change; operators must run a forced rebuild to reset the derived index.
- Added the MCP `db_info` tool and updated MCP instructions so agents can
  distinguish remote canonical storage from local/project-local context.
- Upgraded the `codex_exec` distillation prompt/schema to v3 with required
  `metadata.retrievalHooks`, making checkpoints act as compressed retrieval
  indexes rather than generic summaries.
- Documented remote-vs-local `AGENTS.md` snippets, search result trust levels,
  server-side embeddings env placement, sqlite-vec compatibility notes, and
  checkpoint/candidate retrieval behavior.

## 0.1.4 - 2026-04-26

- Added candidate-id review workflows: `promoteMemoryCandidate --candidateId`
  marks candidates as promoted with review metadata, and `rejectMemoryCandidate`
  marks reviewed candidates as rejected without creating durable memory.
- Exposed candidate rejection through the CLI, remote API, and MCP
  `reject_memory_candidate` tool.
- Added v2 memory-candidate review fields for type, confidence, stability,
  sensitivity, recommendation, and source event ids.
- Added lightweight candidate promotion warnings for duplicate keys, duplicate
  content, risky recommendation/sensitivity signals, and low confidence or
  stability. Callers must pass `allowWarnings` to promote through warnings.
- Added candidate review state guards so already promoted or rejected candidates
  cannot be changed again unless callers pass `allowStatusOverride`.
- Made memory-candidate index backfill run once per database instead of on every
  store open.
- Exposed `maxEvents` and `maxChars` on MCP `session_status` and
  `distill_checkpoint`, matching the CLI/core bounded-window controls.
- Preserved remote error names and warning details across the remote client
  boundary.
- Extracted shared ingest registry, routing, dedupe, discovery, and watch helpers
  for Codex and Claude Code adapters.
- Made ingest watch sleeps interruptible so SIGINT/SIGTERM can stop long-running
  watchers without waiting for the full interval.

## 0.1.3 - 2026-04-26

- Made MCP agent guidance more discoverable by documenting startup bootstrap
  behavior and keeping repository `AGENTS.md` files small.
- Updated MCP server instructions to tell agents to inspect checkpoint memory
  candidates after distillation or when session status reports pending
  candidates.
- Added `memoryCandidateCount` to `distillCheckpoint` results and
  `latestCheckpointMemoryCandidateCount` plus a candidate hint to
  `sessionStatus`, so agents can discover candidate memories without guessing.

## 0.1.2 - 2026-04-26

- Added server/local raw evidence TTL pruning with `CONTEXTFORGE_RAW_TTL_DAYS`,
  preserving checkpoints, distill runs, and promoted durable memories.
- Added `pruneRawEvents` to the CLI, remote API, and MCP tools for explicit
  raw evidence cleanup.
- Reduced distillation cost risk by requiring
  `CONTEXTFORGE_DISTILL_CHAR_MIN_INTERVAL_MS` before char-threshold checkpoint
  creation after an existing checkpoint.
- Made checkpoint continuation use the last raw event actually covered by the
  previous checkpoint, so already-distilled raw evidence is skipped while raw
  appended during distillation remains eligible for the next checkpoint.
- Documented raw retention and distillation cost controls in the remote
  operation guide.

## 0.1.1 - 2026-04-26

- Added agent-level multi-repo routed ingest for Codex and Claude Code, so each
  adapter can scan its global session store once and route files to repo
  `scopeKey` values through a registry.
- Added repo registry matching with enabled flags, adapter filters, most-specific
  nested `repoPath` precedence, explicit unknown-cwd skips, and routed result
  logs that include matched repo names and canonical scope keys.
- Added systemd user service installers for `codex` and `claude_code` agent
  routers, keeping the older repo-specific watcher available for simple
  single-repo deployments.
- Strengthened README positioning with the explainer comic, remote-first
  architecture guidance, canonical repo `scopeKey` setup notes, and
  agent-router examples.

## 0.1.0 - 2026-04-25

- Added `ingestCodexRollout`, which ingests Codex TUI rollout JSONL artifacts
  into raw evidence without spending model tokens on capture, deduplicates
  records, and can optionally trigger checkpoint distillation.
- Added `ingestCodexSessions` for repeated multi-session scans of Codex rollout
  directories, including safe handling for actively-written trailing lines.
- Added `ingestCodexSessions --watch` for long-running local TUI capture loops
  with per-iteration JSON logs and bounded `--iterations` smoke checks.
- Codex ingest now namespaces session ids as `codex:<native-session-id>` and
  records standard agent/runtime provenance metadata for future multi-TUI use.
- Added Claude Code JSONL ingestion with `claude_code:<native-session-id>`
  session namespacing and the same raw evidence/checkpoint provenance model.
- Added `promoteMemoryCandidate` so reviewed checkpoint candidates can be
  promoted from CLI without copying candidate fields manually.
- Added a systemd user service installer for long-running Codex watch ingest
  against a remote ContextForge server.
- Repo-specific TUI ingest now skips transcript files whose recorded cwd is
  outside `--repoPath`, preventing global session scans from crossing repo
  scopes.
- Checkpoint distillation now uses bounded recent raw-event windows with
  configurable max event/character limits and records source window metadata.
- MCP now exposes `promote_memory_candidate` so reviewed checkpoint candidates
  can be promoted without manually copying candidate fields.
- The remote server now exposes a Streamable HTTP MCP endpoint at `/mcp`, so
  agents on multiple machines can connect directly to the same canonical memory
  store without launching a local stdio MCP bridge.
- Scoped CLI and MCP calls can now pass `repoPath` or `cwd` so repo memory is
  resolved for a target checkout even when the agent process starts elsewhere.
- Remote clients strip `repoPath` and `cwd` after resolving scope keys so local
  filesystem paths are not sent to the remote server.
- MCP instructions now call out intentional durable memory writes with
  `remember` and reviewed checkpoint promotion with `promote_memory`.
- Remote HTTP requests that exceed `CONTEXTFORGE_REMOTE_MAX_BODY_BYTES` now
  return `413 Payload Too Large` instead of a generic `500` response.
- `sessionStatus` no longer recommends the first checkpoint from event count
  alone. Initial checkpoint recommendations now require the raw character
  threshold; after a checkpoint exists, event count is still paired with the
  interval threshold.
