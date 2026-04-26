#!/usr/bin/env bash
set -euo pipefail

name="codex-router"
repo_registry=""
remote_url="${CONTEXTFORGE_REMOTE_URL:-}"
token_env_file="${CONTEXTFORGE_TOKEN_ENV_FILE:-$HOME/.config/contextforge/server.env}"
sessions_dir="${CONTEXTFORGE_CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
interval_ms="${CONTEXTFORGE_CODEX_WATCH_INTERVAL_MS:-30000}"
since_minutes="${CONTEXTFORGE_CODEX_WATCH_SINCE_MINUTES:-1440}"
distill="${CONTEXTFORGE_CODEX_WATCH_DISTILL:-auto}"
node_bin="${NODE:-node}"

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
    --sessions-dir)
      sessions_dir="$2"
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
unit_name="contextforge-codex-router-${safe_name}.service"
unit_path="$unit_dir/$unit_name"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

repo_count="$("$node_bin" --input-type=module -e 'const registry = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(process.argv[1], "utf8"))); const repos = Array.isArray(registry) ? registry : registry.repos; if (!Array.isArray(repos)) throw new Error("Repo registry must be a JSON array or an object with a repos array."); console.log(repos.filter((repo) => repo && repo.enabled !== false && (!repo.adapters || String(repo.adapters).split(",").map((item) => item.trim()).includes("codex"))).length);' "$repo_registry")"

mkdir -p "$unit_dir"

cat >"$unit_path" <<EOF
[Unit]
Description=ContextForge agent ingest router for codex (${name})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo_root}
Environment=CONTEXTFORGE_STORAGE_MODE=remote
Environment=CONTEXTFORGE_REMOTE_URL=${remote_url}
EnvironmentFile=-${token_env_file}
ExecStart=${node_bin} ${repo_root}/src/cli.js ingestCodexRoutedSessions --sessionsDir ${sessions_dir} --repoRegistry ${repo_registry} --sinceMinutes ${since_minutes} --distill ${distill} --watch --intervalMs ${interval_ms}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

echo "Installed codex agent router unit: ${unit_path}"
echo "Repo registry: ${repo_registry}"
echo "Enabled Codex repos: ${repo_count}"

systemctl --user daemon-reload
systemctl --user enable --now "$unit_name"
systemctl --user --no-pager status "$unit_name"
