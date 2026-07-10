# API Token Authorization

ContextForge supports capability- and scope-limited bearer tokens for the HTTP
JSON API and Streamable HTTP MCP. The same method authorization matrix is used
by both transports.

## Compatibility And Migration

`CONTEXTFORGE_REMOTE_TOKEN` remains a full-access compatibility credential when
`CONTEXTFORGE_API_TOKENS_JSON` is not configured. Its identity is recorded as
`legacy-remote-token`.

When scoped token policies are configured, the legacy token is disabled by
default. Set `CONTEXTFORGE_LEGACY_REMOTE_TOKEN_MODE=full` only for a bounded
migration window, then remove the legacy token. `disabled` and `full` are the
only accepted modes.

## Policy Format

Keep bearer secrets in environment variables or configure their SHA-256 hash.
Do not place plaintext bearer values inside the JSON policy.

```bash
export CONTEXTFORGE_REPO_READER_TOKEN='replace-with-at-least-16-random-characters'
export CONTEXTFORGE_REPO_AGENT_TOKEN='replace-with-another-random-secret'
export CONTEXTFORGE_API_TOKENS_JSON='[
  {
    "id": "repo-reader",
    "tokenEnv": "CONTEXTFORGE_REPO_READER_TOKEN",
    "capabilities": ["read"],
    "scopes": ["repo:github.com/example/contextforge"],
    "expiresAt": "2026-12-31T00:00:00.000Z"
  },
  {
    "id": "repo-agent",
    "tokenEnv": "CONTEXTFORGE_REPO_AGENT_TOKEN",
    "capabilities": ["read", "write"],
    "scopes": ["repo:github.com/example/contextforge"]
  }
]'
```

Each policy requires:

- a unique, non-secret `id`;
- either `tokenEnv` or a 64-character `sha256`, never both;
- one or more capabilities;
- one or more `type:key` scope rules.

Valid scope types are `repo`, `shared`, and `local`. `repo:*` grants every repo
key while preserving the type boundary. Only `*:*` grants every scope type and
key. Set `revoked: true` to reject a token without deleting its policy, or set
an ISO-8601 `expiresAt`. Policy changes take effect when the server restarts.
Up to 100 token policies are accepted; duplicate ids and duplicate secrets fail
startup.

## Capabilities

| Capability | Intended operations |
| --- | --- |
| `read` | bootstrap/search/get/list/status and other non-mutating scoped reads |
| `write` | session/raw capture, durable memory writes, distill submission/execution |
| `review` | candidate audit, promotion, rejection, correction, reconciliation |
| `operator` | runtime settings, queues, pruning, embeddings, migration, workspace administration, metrics |

Capabilities do not imply one another. An agent that must read and append raw
evidence needs both `read` and `write`. A worker that lists and processes jobs
normally needs `read` and `operator`.

Every remotely exposed method must appear exactly once in the authorization
matrix. A regression test fails if a method is added without a capability.

## Scope Enforcement

The token must permit every scope touched by the request. For example, a repo
token cannot set `includeShared=true` unless its rules also include the selected
shared scope. Related repo scope keys are checked individually. Scope-limited
tokens must provide an explicit scope to operations that otherwise search or
mutate globally.

Workspace profiles can expand into multiple scopes. Workspace administration
and requests using `workspaceKey` therefore require an all-scope token in the
initial model. This is intentionally conservative; a future policy can authorize
resolved workspace membership without weakening the current boundary.

`dbInfo` and readiness are process-level diagnostics and require only their
mapped capability. Global data listings and global job processing require an
all-scope token.

## Errors And Identity

Missing, unknown, expired, or revoked credentials return HTTP 401 with
`CONTEXTFORGE_UNAUTHORIZED`. Authenticated calls without the required capability
or scope return HTTP 403 with `CONTEXTFORGE_FORBIDDEN`. Remote clients preserve
the status, error name, and code. MCP tool calls use the same authorizer and
return the same denial message through the MCP tool error envelope.

Successful authenticated responses include `X-ContextForge-Auth-Id`. Durable
distill/audit jobs record `authTokenId` and `authKind` in job metadata. LLM usage
events record the same non-secret identity plus request id and transport under
`usage._contextforge`. Bearer values and hashes are never returned or persisted
by these correlation fields.

Same-origin admin UI sessions are explicit full-capability, all-scope operator
sessions and are recorded as `admin-session`. They are distinct from API token
policies. Keep admin login restricted to trusted operators.
