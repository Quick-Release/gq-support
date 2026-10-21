#!/usr/bin/env bash
# Secret-scans the paths an artifact upload is about to send, including inside archives such as
# Playwright traces. .github/actions/upload-scanned-artifact runs it before every upload.
#   scripts/ci/scan-artifact.sh "$(printf 'test-results/\nruntime-results/')"
set -euo pipefail

scan=$(dirname "${BASH_SOURCE[0]}")/gitleaks.sh
while IFS= read -r target; do
  [ -n "$target" ] || continue
  # A glob or exclusion could upload files this scan never saw.
  if [[ "$target" == *[\*\?\[]* || "$target" == !* ]]; then
    echo "::error::Upload paths must be plain files or directories, not '$target'" >&2
    exit 2
  fi
  # A missing path uploads nothing; the upload's if-no-files-found decides whether that matters.
  [ -e "$target" ] || continue
  "$scan" dir --verbose --max-archive-depth 2 "$target"
done <<< "$1"
