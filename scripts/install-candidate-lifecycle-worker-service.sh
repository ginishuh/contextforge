#!/usr/bin/env bash
set -euo pipefail

name="lifecycle"
repo_registry=""
remote_url="${CONTEXTFORGE_REMOTE_URL:-}"
token_env_file="${CONTEXTFORGE_TOKEN_ENV_FILE:-$HOME/.config/contextforge/server.env}"
interval_ms="${CONTEXTFORGE_CANDIDATE_LIFECYCLE_INTERVAL_MS:-60000}"
audit_limit="${CONTEXTFORGE_CANDIDATE_LIFECYCLE_AUDIT_LIMIT:-5}"
audit_batch_limit="${CONTEXTFORGE_CANDIDATE_LIFECYCLE_AUDIT_BATCH_LIMIT:-5}"
wake_limit="${CONTEXTFORGE_CANDIDATE_LIFECYCLE_WAKE_LIMIT:-25}"
stale_limit="${CONTEXTFORGE_CANDIDATE_LIFECYCLE_STALE_LIMIT:-25}"
job_limit="${CONTEXTFORGE_CANDIDATE_LIFECYCLE_JOB_LIMIT:-5}"
lease_ms="${CONTEXTFORGE_CANDIDATE_LIFECYCLE_LEASE_MS:-600000}"
dry_run="false"
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
    --name) name="$2"; shift 2 ;;
    --repo-registry|--repoRegistry) repo_registry="$2"; shift 2 ;;
    --remote-url) remote_url="$2"; shift 2 ;;
    --token-env-file) token_env_file="$2"; shift 2 ;;
    --interval-ms) interval_ms="$2"; shift 2 ;;
    --audit-limit) audit_limit="$2"; shift 2 ;;
    --audit-batch-limit) audit_batch_limit="$2"; shift 2 ;;
    --wake-limit) wake_limit="$2"; shift 2 ;;
    --stale-limit) stale_limit="$2"; shift 2 ;;
    --job-limit) job_limit="$2"; shift 2 ;;
    --lease-ms) lease_ms="$2"; shift 2 ;;
    --dry-run) dry_run="$2"; shift 2 ;;
    --node) node_bin="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
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
if [ "$dry_run" != "true" ] && [ "$dry_run" != "false" ]; then
  echo "--dry-run must be true or false." >&2
  exit 2
fi

safe_name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9_.@-' '-')"
unit_dir="$HOME/.config/systemd/user"
unit_name="contextforge-candidate-lifecycle-${safe_name}.service"
unit_path="$unit_dir/$unit_name"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli_path="${repo_root}/src/cli.js"

mkdir -p "$unit_dir"

cat >"$unit_path" <<EOF
[Unit]
Description=ContextForge candidate lifecycle worker (${name})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$repo_root
EnvironmentFile=-$token_env_file
Environment=CONTEXTFORGE_STORAGE_MODE=remote
Environment=$(systemd_quote "CONTEXTFORGE_REMOTE_URL=$remote_url")
ExecStart=$(systemd_quote "$node_bin") $(systemd_quote "$cli_path") candidateLifecycleWorker --repoRegistry $(systemd_quote "$repo_registry") --watch --dryRun $(systemd_quote "$dry_run") --intervalMs $(systemd_quote "$interval_ms") --auditLimit $(systemd_quote "$audit_limit") --auditBatchLimit $(systemd_quote "$audit_batch_limit") --wakeLimit $(systemd_quote "$wake_limit") --staleLimit $(systemd_quote "$stale_limit") --jobLimit $(systemd_quote "$job_limit") --leaseMs $(systemd_quote "$lease_ms") --workerId $(systemd_quote "candidate-lifecycle-$safe_name")
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

echo "Installed candidate lifecycle worker unit: ${unit_path}"
echo "Repo registry: ${repo_registry}"
echo "Dry run: ${dry_run}"

systemctl --user daemon-reload
systemctl --user enable --now "$unit_name"
systemctl --user --no-pager status "$unit_name"
