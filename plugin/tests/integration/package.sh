#!/usr/bin/env bash
# Installed release ZIP lifecycle, after run.sh installed the candidate from GQ_SUPPORT_PLUGIN_ZIP
# (a repository-relative path; its manifest from scripts/ci/release-package.mjs sits beside it):
#   single   real uninstall of the installed copy, then the previous release upgraded to the
#            candidate through WordPress's package installer; leaves the candidate active.
#   native   after single: WordPress's own updater installs an approved next release from a stand-in
#            support service (#142), refuses corrupt, wrong-origin, unauthorized and withdrawn packages,
#            renews expired download access, keeps working disabled and without the report key, and
#            makes no remote call while pages render; then reinstalls the candidate.
#   central  after single: central deployment's WP-CLI adapter installs approved next and recovery
#            releases from verified bytes with support disabled and no report key (#143).
#   network  after multisite.sh: network deactivation and uninstall stay bounded to the main site.
# Runs on the disposable DDEV site from any directory.
set -euo pipefail
cd "$(dirname "$0")/../../.."
zip=${GQ_SUPPORT_PLUGIN_ZIP:?package.sh tests an installed release ZIP; set GQ_SUPPORT_PLUGIN_ZIP}
site=${GQ_SUPPORT_TEST_URL:-https://gq-support-lifecycle-testsite.ddev.site}
package_dir=$(dirname "$zip")
plugin=.test-site/wp-content/plugins/gq-support
version=$(jq -r .version "$package_dir/gq-support.manifest.json")
wp() { ddev wp --path=.test-site "$@"; }
check() { wp eval-file plugin/tests/integration/package.php "$@"; }
# Blocks every outgoing request and records the plugin's, from before the first request that loads new code.
probe=.test-site/wp-content/mu-plugins/package-test-http-probe.php

# The installed candidate's files under a higher version, as a release ZIP: an approved next release.
next_release() {
  python3 - "$plugin" "$1" "$version" "$2" <<'PY'
import pathlib, sys, zipfile
tree, out, old, new = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(p for p in tree.rglob("*") if p.is_file()):
        data = path.read_bytes()
        if path.name == "gq-support.php":
            data = data.replace(f"Version:            {old}".encode(), f"Version:            {new}".encode())
            data = data.replace(f"'GQ_SUPPORT_VERSION', '{old}'".encode(), f"'GQ_SUPPORT_VERSION', '{new}'".encode())
        archive.writestr(f"gq-support/{path.relative_to(tree)}", data)
PY
}

case "${1:?usage: package.sh single|native|central|network}" in
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

  native)
    [[ ! -L "$plugin" ]] || { echo 'native needs the installed copy, never the plugin/ checkout' >&2; exit 1; }
    service=.test-site/wp-content/mu-plugins/native-update-service.php
    next_zip=native-update-next.zip
    cookies=$(mktemp -d)
    mkdir -p "$(dirname "$service")"
    cp plugin/tests/integration/native-update-service.php "$service"
    recovery_zip=native-update-recovery.zip
    trap 'rm -rf "$service" "$cookies" ".test-site/$next_zip" ".test-site/$recovery_zip"' EXIT
    native() { wp eval-file plugin/tests/integration/native-update.php "$@"; }

    # The approved next release: the installed candidate's files under a higher version.
    next_version="$version.1"
    next_release ".test-site/$next_zip" "$next_version"
    next_main=$(python3 -c 'import hashlib, sys, zipfile; print(hashlib.sha256(zipfile.ZipFile(sys.argv[1]).read("gq-support/gq-support.php")).hexdigest())' ".test-site/$next_zip")

    native provision
    native serve "$next_zip" "$next_version"

    # Ordinary rendering, including core's update screens, never asks the service.
    # run.sh's Administrator; a page that is not the expected admin screen fails below.
    curl -fsSL -c "$cookies/admin" -b "$cookies/admin" -d 'log=siteadmin&pwd=siteadmin&wp-submit=Log+In&testcookie=1' "$site/wp-login.php" -o /dev/null
    curl -fsS -o /dev/null "$site/"
    for page in '' plugins.php update-core.php; do
      [[ "$(curl -fsS -b "$cookies/admin" "$site/wp-admin/$page")" == *'wpadminbar'* ]]
    done
    native quiet
    # The Updates screen's "Check again" is a manual check; cron is scheduled maintenance. Core's
    # own check last ran two hours ago, so the screen checks rather than admin_init.
    wp eval '$updates = get_site_transient( "update_plugins" ); $updates->last_checked = time() - 2 * HOUR_IN_SECONDS; set_site_transient( "update_plugins", $updates );'
    curl -fsS -o /dev/null -b "$cookies/admin" "$site/wp-admin/update-core.php?force-check=1"
    native checked web
    native mode ok fresh
    wp cron event run wp_update_plugins >/dev/null
    native checked 'cron|cli'

    # Refusals through core's real upgrader leave the installed release running.
    native refused wrong-origin
    wp eval 'delete_site_transient( "update_plugins" );'
    wp gq-support update-check >/dev/null
    for mode in corrupt unauthorized withdrawn; do
      native mode "$mode"
      native refused "gq_support_update_$mode"
      native unchanged "$version"
    done

    # Support disabled and the report credential revoked: the approved update still installs,
    # renewing its expired download access through the signed metadata request.
    # WP-CLI's update, like the Updates screen, reactivates the plugin core deactivated to replace it.
    native mode expired-once disabled
    native disconnect
    native recovering
    wp plugin update gq-support
    native renewed
    native upgraded "$next_version" "$next_main"

    # The next release is withdrawn: the approved recovery release is the earlier verified candidate (#144).
    # Core never downgrades, so its scheduled update event installs it through the guarded recovery path,
    # from the exact verified bytes, then the installed files must be exactly the candidate's.
    cp "$zip" ".test-site/$recovery_zip"
    candidate_files=$(python3 - ".test-site/$recovery_zip" <<'PY'
import hashlib, sys, zipfile
archive = zipfile.ZipFile(sys.argv[1])
files = sorted((info.filename[len("gq-support/"):], hashlib.sha256(archive.read(info)).hexdigest()) for info in archive.infolist() if not info.is_dir())
print(hashlib.sha256("".join(f"{path}\0{digest}\n" for path, digest in files).encode()).hexdigest())
PY
)
    native serve "$recovery_zip" "$version" recovery "$candidate_files"
    native mode ok disabled
    wp cron event run wp_update_plugins >/dev/null
    native recovered "$version" "$candidate_files"
    # Recovered once: nothing loops back to the withdrawn release or reinstalls the recovery.
    [[ "$(wp gq-support update-recover)" == *'No recovery is needed'* ]]

    native cleanup
    wp plugin install "$zip" --force
    node scripts/ci/release-package.mjs installed "$package_dir" "$plugin"
    wp plugin is-active gq-support
    echo 'Installed native update passed.'
    ;;

  central)
    # After single: central deployment (#143) applies approved releases over hosting access with
    # WP-CLI, here `docker exec` into the site, while report submission is disabled and the report credential is
    # gone, then the approved recovery package; worker/test/central-installed.test.ts drives it.
    [[ ! -L "$plugin" ]] || { echo 'central needs the installed copy, never the plugin/ checkout' >&2; exit 1; }
    next_zip=.test-site/central-next.zip
    trap 'rm -f "$next_zip"; wp config delete GQ_SUPPORT_DISABLED >/dev/null 2>&1 || true' EXIT
    next_release "$next_zip" "$version.1"
    native() { wp eval-file plugin/tests/integration/native-update.php "$@"; }
    wp config set GQ_SUPPORT_DISABLED true --raw
    native disconnect
    native recovering
    GQ_SUPPORT_CENTRAL_PACKAGE="$package_dir" GQ_SUPPORT_CENTRAL_NEXT="$next_zip" \
      pnpm --filter gq-support-worker exec vitest run test/central-installed.test.ts
    # The recovery package is the candidate, file for file.
    node scripts/ci/release-package.mjs installed "$package_dir" "$plugin"
    wp plugin is-active gq-support
    native cleanup
    echo 'Installed central deployment passed.'
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
    # One native update key for the network, whichever site's context asks.
    key_id=$(wp gq-support update-key | sed -n 's/^Key ID: //p')
    [[ "$(wp --url="$subsite_url" gq-support update-status --format=json | jq -r '.[0].key_id')" == "$key_id" ]]
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
    echo "usage: package.sh single|native|central|network" >&2
    exit 2
    ;;
esac
