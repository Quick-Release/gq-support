#!/usr/bin/env bash
# Runs one runtime matrix cell (.github/runtime-matrix.json) on the disposable DDEV site exactly as
# CI does: lifecycle integration, recorded and verified runtime, browser suite, multisite, Plugin Check.
# Needs a fresh site (WordPress and database versions are fixed when the site is created), a built
# app and, for browser cells, the cell's Playwright engine. The object-cache cell also needs the
# ddev-redis add-on in .ddev. Runtime reports land in runtime-results/.
#   scripts/ci/run-cell.sh minimum
set -euo pipefail
cd "$(dirname "$0")/../.."
# An assignment keeps a failed lookup fatal; eval of a failed substitution would not be.
cell_env=$(node scripts/ci/runtime-matrix.mjs env "${1:?usage: run-cell.sh <cell-id>}")
eval "$cell_env"
wp() { ddev wp --path=.test-site "$@"; }
mkdir -p runtime-results

# Records what actually ran, then fails unless it is the cell's declared runtime.
record() {
  local report="runtime-results/$CELL_ID-$1.json"
  wp eval-file plugin/tests/integration/runtime.php | jq \
    --arg node "$(node --version)" --arg pnpm "$(pnpm --version)" --arg ddev "$(ddev --version)" \
    --arg playwright "$(pnpm exec playwright --version)" --arg browser "$CELL_BROWSER" --arg cell "$CELL_NAME" \
    '. + { cell: $cell, toolchain: { node: $node, pnpm: $pnpm, ddev: $ddev, playwright: $playwright, browser: $browser } }' > "$report"
  node scripts/ci/runtime-matrix.mjs verify "$CELL_ID" "$1" < "$report"
}

echo "::group::Lifecycle integration: $CELL_NAME"
WP_VERSION=$CELL_WORDPRESS GQ_SUPPORT_PHP_VERSION=$CELL_PHP GQ_SUPPORT_DATABASE=$CELL_DATABASE \
  GQ_SUPPORT_REDIS_CACHE_VERSION=$CELL_REDIS_CACHE bash plugin/tests/integration/run.sh
woocommerce=()
[[ "$CELL_WOOCOMMERCE" == latest ]] || woocommerce=(--version="$CELL_WOOCOMMERCE")
if [[ -n "$CELL_WOOCOMMERCE" ]]; then wp plugin install woocommerce "${woocommerce[@]}" --force; fi
echo '::endgroup::'
record single

if [[ -n "$CELL_SUITE" ]]; then
  echo "::group::Browser $CELL_SUITE ($CELL_BROWSER)"
  if [[ -n "$CELL_WOOCOMMERCE" ]]; then wp plugin activate woocommerce; fi
  GQ_SUPPORT_BROWSER_SUITE=$CELL_SUITE GQ_SUPPORT_BROWSER=$CELL_BROWSER pnpm test:browser
  # Leave the multisite lifecycle checks the same site they had before.
  if [[ -n "$CELL_WOOCOMMERCE" ]]; then wp plugin deactivate woocommerce; fi
  echo '::endgroup::'
fi

if [[ -n "$CELL_MULTISITE" ]]; then
  echo "::group::Multisite ($CELL_MULTISITE) lifecycle and cleanup"
  GQ_SUPPORT_MULTISITE=$CELL_MULTISITE bash plugin/tests/integration/multisite.sh
  echo '::endgroup::'
  record multisite
fi

# The Plugin Check action tries to download Requires Plugins from WP.org.
# GETQUICK Design is private; this DDEV site already has the test fixture.
if [[ -n "$CELL_PLUGIN_CHECK" ]]; then
  echo "::group::Plugin Check $CELL_PLUGIN_CHECK"
  plugin_check=()
  [[ "$CELL_PLUGIN_CHECK" == latest ]] || plugin_check=(--version="$CELL_PLUGIN_CHECK")
  wp plugin install plugin-check "${plugin_check[@]}" --force --activate
  wp plugin check gq-support \
    --exclude-directories=tests,app,vendor \
    --exclude-files=composer.json,composer.lock,phpstan.neon.dist,.phpcs.xml.dist
  echo '::endgroup::'
fi
echo "Cell $CELL_NAME passed."
