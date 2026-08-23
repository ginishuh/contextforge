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
| `operator` | 56 | 1,423 | 55,389 | 11,159 | 14,203 |
| `workspace-admin` | 11 | 1,423 | 8,888 | 2,061 | 2,578 |
| `all` | 62 | 1,423 | 60,487 | 12,181 | 15,478 |

`estimatedInitialTokens` is `ceil((instructionsBytes + toolSchemaBytes) / 4)`.
It is a conservative transport-level comparison, not a claim about a specific
model tokenizer. MCP hosts may repeat, omit, transform, or cache server
instructions and tool schemas when assembling their private prompts. Codex,
Claude Code, and other hosts do not expose those final internal prompt token
counts through the MCP protocol, so ContextForge reports the reproducible input
bytes instead of inventing host-specific precision.

The default `agent-core` surface is about 57% smaller than `all` by this token
estimate. That ratio is what the regression test still asserts directly; the
absolute numbers moved to the ratchet described below.

## 2026-08-22 Measurement

| Profile | Tools | Instructions bytes | `tools/list` JSON bytes | Description bytes | Estimated tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `agent-core` | 24 | 1,423 | 25,358 | 5,776 | 6,696 |
| `review` | 45 | 1,423 | 45,379 | 9,214 | 11,701 |
| `operator` | 67 | 1,423 | 65,942 | 13,059 | 16,842 |
| `workspace-admin` | 11 | 1,423 | 8,888 | 2,061 | 2,578 |
| `all` | 73 | 1,423 | 71,040 | 14,081 | 18,116 |

`agent-core` grew by 16 tool-schema bytes when `@modelcontextprotocol/sdk` moved
from 1.29.0 to 1.30.0, leaving 4 estimated tokens under the 6,700 regression
cap. The review, operator, and all profiles grew because candidate lifecycle
operations were added after the July baseline, not because of the SDK.

That measurement exposed two problems. The default profile had four tokens of
headroom, so the next unrelated change would have failed its cap at a moment
nobody chose. And the cap only ever guarded `agent-core`: the profiles that
grew by roughly a fifth had nothing watching them at all.

## Ratchet

Budgets now live in `scripts/mcp-surface-budgets.json` and cover every profile.

```bash
npm run lint:mcp-surface                      # verify
node scripts/check-mcp-surface.js --update    # re-record after a real change
```

The surface may never grow past what is recorded. When a change genuinely needs
more room, the manifest is updated in the same commit, so the increase appears
in a diff with a reason attached rather than as a silently raised constant.

The ratchet also runs the other way: if the estimated token count falls more
than `slackRatio` (5%) below its budget, the check asks for the manifest to be
tightened, so reclaimed room cannot be spent again unnoticed. Only the token
estimate demands tightening — byte counts drift with SDK releases, and asking
for an update on every drift would turn the ratchet into churn.

Headroom is no longer something to preserve. Four tokens is fine, because the
question the budget answers is "did this change grow the surface, and did
someone say why", not "how close are we to a line".

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
