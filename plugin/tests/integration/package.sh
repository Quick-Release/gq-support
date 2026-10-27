#!/usr/bin/env bash
# Installed release ZIP lifecycle, after run.sh installed the candidate from GQ_SUPPORT_PLUGIN_ZIP
# (a repository-relative path; its manifest from scripts/ci/release-package.mjs sits beside it):
#   single   real uninstall of the installed copy, then the previous release upgraded to the
#            candidate through WordPress's package installer; leaves the candidate active.
#   network  after multisite.sh: network deactivation and uninstall stay bounded to the main site.
# Runs on the disposable DDEV site from any directory.
set -euo pipefail
cd "$(dirname "$0")/../../.."
zip=${GQ_SUPPORT_PLUGIN_ZIP:?package.sh tests an installed release ZIP; set GQ_SUPPORT_PLUGIN_ZIP}
site=${GQ_SUPPORT_TEST_URL:-https://gq-support-lifecycle-testsite.ddev.site}
package_dir=$(dirname "$zip")
plugin=.test-site/wp-content/plugins/gq-support
version=$(jq -r .version "$package_dir/gq-support.manifest.json")
source scripts/ci/wp-cli.sh
check() { wp eval-file plugin/tests/integration/package.php "$@"; }
# Blocks every outgoing request and records the plugin's, from before the first request that loads new code.
probe=.test-site/wp-content/mu-plugins/package-test-http-probe.php

case "${1:?usage: package.sh single|network}" in
  single)
    node scripts/ci/release-package.mjs installed "$package_dir" "$plugin"
    wp plugin is-active gq-support || wp plugin activate gq-support
    check seed

    # Requested directly, outside WordPress, uninstall.php must do nothing.
    curl -fsS -o /dev/null "$site/wp-content/plugins/gq-support/uninstall.php"
    ddev exec php "$plugin/uninstall.php"
    wp option get gq_support_state >/dev/null

    # WordPress's own uninstall: deactivate, run uninstall.php, delete the files.
    wp plugin deactivate gq-support
    wp plugin uninstall gq-support
    check uninstalled
    check cleanup

    previous=$(node scripts/ci/release-package.mjs previous "$version")
    if [[ -z "$previous" ]]; then
      # lifecycle.php upgrade still migrates the committed legacy-schema fixtures.
      echo "No release precedes $version: the previous-release upgrade is skipped."
      wp plugin install "$zip" --activate
    else
      # The previous release as published: the composer branch tree behind its tag.
      previous_zip=.test-site/gq-support-previous.zip
      git archive --format=zip --prefix=gq-support/ -o "$previous_zip" "$previous"
      wp plugin install "$previous_zip" --activate
      rm "$previous_zip"
      [[ "$(wp plugin get gq-support --field=version)" == "${previous#v}" ]]
      check seed
      check revoke
      mkdir -p "$(dirname "$probe")"
      cat > "$probe" <<'PHP'
<?php
// WordPress's own update checks to wordpress.org are not the plugin's; every other host is recorded.
function package_test_http_probe( $pre, $args, $url ) {
	if ( ! preg_match( '#^https?://([a-z0-9-]+\.)*wordpress\.org/#i', $url ) ) {
		update_option( 'package_test_http_calls', array_merge( (array) get_option( 'package_test_http_calls', array() ), array( $url ) ), false );
	}
	return new WP_Error( 'http_request_failed', 'No remote calls during an upgrade.' );
}
add_filter( 'pre_http_request', 'package_test_http_probe', 10, 3 );
PHP
      trap 'rm -f "$probe"' EXIT
      # The package installer replaces the files in place; nothing calls activation.
      wp plugin install "$zip" --force
      wp plugin is-active gq-support
      node scripts/ci/release-package.mjs installed "$package_dir" "$plugin"
      check upgraded "$version"
      wp plugin deactivate gq-support
      wp plugin activate gq-support
      check upgraded "$version"
      rm "$probe"
      check cleanup
      echo "Upgrade from $previous to $version passed."
    fi
    echo 'Installed package uninstall passed.'
    ;;

  network)
    wp eval 'exit( is_multisite() ? 0 : 1 );'
    wp plugin is-active gq-support --network
    subsite_id=$(wp site create --slug=gq-support-package --porcelain)
    subsite_url=$(wp site list --site__in="$subsite_id" --field=url)
    # The CLI request initializes each site's state before it is seeded.
    wp gq-support status >/dev/null
    wp --url="$subsite_url" gq-support status >/dev/null
    check seed
    check --url="$subsite_url" seed
    wp plugin deactivate gq-support --network
    wp plugin uninstall gq-support
    check uninstalled
    check --url="$subsite_url" kept
    check --url="$subsite_url" cleanup
    check cleanup
    wp site delete "$subsite_id" --yes >/dev/null
    echo 'Installed package network uninstall passed.'
    ;;

  *)
    echo "usage: package.sh single|network" >&2
    exit 2
    ;;
esac
