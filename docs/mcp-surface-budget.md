# MCP Surface Budget

ContextForge measures the MCP initialization surface before opening a
transport:

```bash
node src/mcp.js --describe-surface --profile agent-core
```

The report uses the same MCP SDK JSON-schema compatibility conversion and tool
definition shape as `tools/list`. Contract tests compare its instruction and
tool-schema byte counts with real SDK clients over both stdio and Streamable
HTTP.

## 2026-07-10 Baseline

| Profile | Tools | Instructions bytes | `tools/list` JSON bytes | Description bytes | Estimated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `agent-core` | 24 | 1,423 | 25,342 | 5,776 | 6,692 |
| `review` | 37 | 1,423 | 37,749 | 7,822 | 9,793 |
| `operator` | 56 | 1,423 | 55,257 | 11,159 | 14,170 |
| `workspace-admin` | 11 | 1,423 | 8,888 | 2,061 | 2,578 |
| `all` | 62 | 1,423 | 60,355 | 12,181 | 15,445 |

`estimatedInitialTokens` is `ceil((instructionsBytes + toolSchemaBytes) / 4)`.
It is a conservative transport-level comparison, not a claim about a specific
model tokenizer. MCP hosts may repeat, omit, transform, or cache server
instructions and tool schemas when assembling their private prompts. Codex,
Claude Code, and other hosts do not expose those final internal prompt token
counts through the MCP protocol, so ContextForge reports the reproducible input
bytes instead of inventing host-specific precision.

The default `agent-core` surface is about 57% smaller than `all` by this token
estimate. Regression tests cap it at 1,600 instruction bytes, 26,000 tool-schema
bytes, and 6,700 estimated tokens.

## Selection Contract

Selection correctness is tested as a deterministic capability contract rather
than an LLM benchmark:

- every profile has an exact ordered tool set;
- `agent-core` contains normal bootstrap, retrieval, evidence, checkpoint, and
  closeout tools while excluding operator and workspace mutation tools;
- `review` adds candidate and durable-memory review operations;
- `operator` contains runtime maintenance but excludes workspace mutations;
- `workspace-admin` contains workspace topology and scope migration operations;
- `all` exactly matches the complete registered tool inventory;
- explicit allowlists expose only recognized requested tools;
- unknown profiles/tools fail before the MCP transport starts;
- stdio and HTTP clients receive the same default profile and byte counts.

`migrate_scope` intentionally appears in both `operator` and
`workspace-admin`; all other workspace mutations stay out of `operator`.

Actual model tool-choice accuracy depends on the host, model, system prompt,
conversation, and tool descriptions. It belongs in a client/model evaluation
matrix, not a deterministic repository test. The machine-readable surface
report provides stable inputs for such evaluations.

## Migration

Existing clients that used maintenance or administration tools from the former
full default surface can temporarily set:

```bash
CONTEXTFORGE_MCP_PROFILE=all
```

Move each client to the narrowest profile after confirming its required tool
set. Prefer a dedicated operator or workspace-admin registration over widening
every coding-agent session.
