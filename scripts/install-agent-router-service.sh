#!/usr/bin/env bash
set -euo pipefail

name="agent-router"
repo_registry=""
remote_url="${CONTEXTFORGE_REMOTE_URL:-}"
token_env_file="${CONTEXTFORGE_TOKEN_ENV_FILE:-$HOME/.config/contextforge/server.env}"
adapters="${CONTEXTFORGE_AGENT_ROUTER_ADAPTERS:-}"
codex_sessions_dir="${CONTEXTFORGE_CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
claude_code_projects_dir="${CONTEXTFORGE_CLAUDE_CODE_PROJECTS_DIR:-$HOME/.claude/projects}"
opencode_db="${CONTEXTFORGE_OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
grok_sessions_dir="${CONTEXTFORGE_GROK_SESSIONS_DIR:-$HOME/.grok/sessions}"
cursor_projects_dir="${CONTEXTFORGE_CURSOR_PROJECTS_DIR:-$HOME/.cursor/projects}"
interval_ms="${CONTEXTFORGE_AGENT_ROUTER_INTERVAL_MS:-30000}"
since_minutes="${CONTEXTFORGE_AGENT_ROUTER_SINCE_MINUTES:-1440}"
distill="${CONTEXTFORGE_AGENT_ROUTER_DISTILL:-auto}"
node_bin="${NODE:-node}"

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\$\$}"
  printf '"%s"' "$value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      name="$2"
      shift 2
      ;;
    --repo-registry|--repoRegistry)
      repo_registry="$2"
      shift 2
      ;;
    --remote-url)
      remote_url="$2"
      shift 2
      ;;
    --token-env-file)
      token_env_file="$2"
      shift 2
      ;;
    --adapters)
      adapters="$2"
      shift 2
      ;;
    --codex-sessions-dir|--codexSessionsDir)
      codex_sessions_dir="$2"
      shift 2
      ;;
    --claude-code-projects-dir|--claudeCodeProjectsDir)
      claude_code_projects_dir="$2"
      shift 2
      ;;
    --opencode-db|--opencodeDb)
      opencode_db="$2"
      shift 2
      ;;
    --grok-sessions-dir|--grokSessionsDir)
      grok_sessions_dir="$2"
      shift 2
      ;;
    --cursor-projects-dir|--cursorProjectsDir)
      cursor_projects_dir="$2"
      shift 2
      ;;
    --interval-ms)
      interval_ms="$2"
      shift 2
      ;;
    --since-minutes)
      since_minutes="$2"
      shift 2
      ;;
    --distill)
      distill="$2"
      shift 2
      ;;
    --node)
      node_bin="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$repo_registry" ]; then
  echo "--repo-registry is required." >&2
  exit 2
fi

if [ -z "$remote_url" ]; then
  echo "--remote-url or CONTEXTFORGE_REMOTE_URL is required." >&2
  exit 2
fi

safe_name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9_.@-' '-')"
unit_dir="$HOME/.config/systemd/user"
unit_name="contextforge-agent-router-${safe_name}.service"
unit_path="$unit_dir/$unit_name"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli_path="${repo_root}/src/cli.js"

repo_count="$("$node_bin" --input-type=module -e 'const registry = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(process.argv[1], "utf8"))); const repos = Array.isArray(registry) ? registry : registry.repos; if (!Array.isArray(repos)) throw new Error("Repo registry must be a JSON array or an object with a repos array."); console.log(repos.filter((repo) => repo && repo.enabled !== false).length);' "$repo_registry")"

adapter_args=""
if [ -n "$adapters" ]; then
  adapter_args=" --adapters $(systemd_quote "$adapters")"
fi

mkdir -p "$unit_dir"

cat >"$unit_path" <<EOF
[Unit]
Description=ContextForge unified agent ingest router (${name})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$repo_root
Environment=CONTEXTFORGE_STORAGE_MODE=remote
Environment=$(systemd_quote "CONTEXTFORGE_REMOTE_URL=$remote_url")
Environment=CONTEXTFORGE_WATCH_STATE_DIR=%h/.local/state/contextforge/watch
EnvironmentFile=-$token_env_file
ExecStart=$(systemd_quote "$node_bin") $(systemd_quote "$cli_path") ingestAgentRoutedSessions${adapter_args} --codexSessionsDir $(systemd_quote "$codex_sessions_dir") --claudeCodeProjectsDir $(systemd_quote "$claude_code_projects_dir") --opencodeDb $(systemd_quote "$opencode_db") --grokSessionsDir $(systemd_quote "$grok_sessions_dir") --cursorProjectsDir $(systemd_quote "$cursor_projects_dir") --repoRegistry $(systemd_quote "$repo_registry") --sinceMinutes $(systemd_quote "$since_minutes") --distill $(systemd_quote "$distill") --watch --intervalMs $(systemd_quote "$interval_ms")
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

echo "Installed unified agent router unit: ${unit_path}"
echo "Repo registry: ${repo_registry}"
echo "Enabled repos: ${repo_count}"
if [ -n "$adapters" ]; then
  echo "Requested adapters: ${adapters}"
else
  echo "Requested adapters: auto-detect installed adapters"
fi

systemctl --user daemon-reload
systemctl --user enable --now "$unit_name"
systemctl --user --no-pager status "$unit_name"
