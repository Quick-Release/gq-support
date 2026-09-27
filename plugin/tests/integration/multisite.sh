#!/usr/bin/env bash
# Run after run.sh on the disposable DDEV site; conversion is destructive.
set -euo pipefail
cd "$(dirname "$0")/../../.."
wp() { ddev wp --path=.test-site "$@"; }
if ! wp eval 'exit( is_multisite() ? 0 : 1 );' >/dev/null 2>&1; then
  wp plugin deactivate gq-support
  wp core multisite-convert --title='Lifecycle network' --subdomains=false
fi
wp plugin activate gq-support --network
wp eval-file plugin/tests/integration/lifecycle.php active
wp eval-file plugin/tests/integration/lifecycle.php network
wp eval-file plugin/tests/integration/lifecycle.php uninstall
# The network plugin still boots; the next site-admin/CLI request recreates only this site's markers.
wp eval-file plugin/tests/integration/lifecycle.php active
# Keep the wp-config.php multisite constants in sync before the disposable site is stopped.
if [[ "$(uname -s)" == Darwin ]]; then ddev mutagen sync; fi
echo 'Multisite lifecycle and bounded uninstall passed.'
