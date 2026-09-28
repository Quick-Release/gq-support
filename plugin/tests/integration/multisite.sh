#!/usr/bin/env bash
# Run after run.sh on the disposable DDEV site; conversion is destructive.
set -euo pipefail
cd "$(dirname "$0")/../../.."
wp() { ddev wp --path=.test-site "$@"; }
if ! wp eval 'exit( is_multisite() ? 0 : 1 );' >/dev/null 2>&1; then
  wp plugin deactivate gq-support
  wp core multisite-convert --title='Lifecycle network' --subdomains=false
fi
wp plugin activate getquick-design --network
wp plugin activate gq-support --network
wp eval-file plugin/tests/integration/lifecycle.php active
wp eval-file plugin/tests/integration/lifecycle.php network
# Each site enrolls separately with its own installation ID and key; --url picks the site.
subsite_id=$(wp site create --slug=gq-support-connect --porcelain)
subsite_url=$(wp site list --site__in="$subsite_id" --field=url)
wp eval-file plugin/tests/integration/connection.php enroll
wp --url="$subsite_url" gq-support status --format=json | grep -q '"connection":"not_connected"'
wp --url="$subsite_url" eval-file plugin/tests/integration/connection.php enroll
main_key=$(wp gq-support status --format=json)
sub_key=$(wp --url="$subsite_url" gq-support status --format=json)
[[ "$main_key" == *'"connection":"connected"'* && "$main_key" != "$sub_key" ]]
for scenario in no-remote-calls interrupted-setup test-connection disconnect no-key-exposure clone; do
  wp --url="$subsite_url" eval-file plugin/tests/integration/connection.php "$scenario"
done
[[ "$main_key" == "$(wp gq-support status --format=json)" ]]
wp site delete "$subsite_id" --yes >/dev/null
wp eval-file plugin/tests/integration/connection.php uninstall
# The network plugin still boots; the next site-admin/CLI request recreates only this site's markers.
wp eval-file plugin/tests/integration/lifecycle.php active
# Keep the wp-config.php multisite constants in sync before the disposable site is stopped.
if [[ "$(uname -s)" == Darwin ]]; then ddev mutagen sync; fi
echo 'Multisite lifecycle and bounded uninstall passed.'
