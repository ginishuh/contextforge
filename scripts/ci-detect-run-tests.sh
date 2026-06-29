#!/usr/bin/env bash
set -euo pipefail

run_tests=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    README.md|README.ko.md|CHANGELOG.md|LICENSE)
      ;;
    docs/skills/*|docs/examples/*)
      run_tests=true
      ;;
    docs/*.md|docs/issues/*.md|docs/assets/*)
      ;;
    *)
      run_tests=true
      ;;
  esac
done

printf '%s\n' "$run_tests"
