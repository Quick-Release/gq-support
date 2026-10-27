#!/usr/bin/env bash
# No WordPress install needed: test PHP diagnostics during WP-CLI bootstrap.
set -euo pipefail
cd "$(dirname "$0")/../../.."
source scripts/ci/wp-cli.sh
streams=$(mktemp -d)
trap 'cli_result=$?; if ((cli_result != 0)); then cat "$streams/stderr" >&2; fi; rm -rf "$streams"; exit "$cli_result"' EXIT
echo 'Checking expected CLI warning and fatal diagnostics.' >&2

# A PHP variable also verifies that DDEV forwards arguments without shell expansion.
wp '--exec=$gq_cli_probe = "gq-cli-warning-probe"; trigger_error($gq_cli_probe, E_USER_WARNING);' cli version > "$streams/stdout" 2> "$streams/stderr"
cat "$streams/stderr" >&2
output=$(cat "$streams/stdout")
if [[ ! "$output" =~ ^WP-CLI\ [0-9]+[.][0-9]+[.][0-9]+[^[:space:]]*$ ]]; then
  echo 'WP-CLI diagnostics contaminated command stdout.' >&2
  exit 1
fi
if ! grep -q 'gq-cli-warning-probe' "$streams/stderr"; then
  echo 'WP-CLI warning diagnostic was lost.' >&2
  exit 1
fi

if wp '--exec=throw new RuntimeException("gq-cli-fatal-probe");' cli version > "$streams/stdout" 2> "$streams/stderr"; then
  echo 'WP-CLI fatal error incorrectly returned success.' >&2
  exit 1
fi
cat "$streams/stderr" >&2
if [[ -s "$streams/stdout" ]] || ! grep -q 'gq-cli-fatal-probe' "$streams/stderr"; then
  echo 'WP-CLI fatal diagnostic was lost or contaminated stdout.' >&2
  exit 1
fi

# Browser and performance tests capture CLI output through the Node helper too.
node > "$streams/stdout" 2> "$streams/stderr" <<'JS'
const assert = require('node:assert/strict');
const { wp } = require('./plugin/tests/performance/test-site.cjs');
const output = wp(['--exec=$gq_cli_probe = "gq-node-cli-warning-probe"; trigger_error($gq_cli_probe, E_USER_WARNING);', 'cli', 'version']);
assert.match(output, /^WP-CLI [0-9]+\.[0-9]+\.[0-9]+\S*$/);
assert.throws(() => wp(['--exec=throw new RuntimeException("gq-node-cli-fatal-probe");', 'cli', 'version']), (error) => Number.isInteger(error.status) && error.status > 0 && error.stdout.length === 0);
JS
cat "$streams/stderr" >&2
for probe in gq-node-cli-warning-probe gq-node-cli-fatal-probe; do
  if ! grep -q "$probe" "$streams/stderr"; then
    echo "Node WP-CLI diagnostic was lost: $probe" >&2
    exit 1
  fi
done
echo 'Shell and Node WP-CLI stdout, warning diagnostics and fatal exits passed.'
