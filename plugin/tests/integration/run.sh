#!/usr/bin/env bash
# Run from the repository root; creates an isolated disposable DDEV WordPress site.
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p .test-site/wp-content/plugins/gq-design .test-site/wp-content/plugins
# GQ_SUPPORT_PLUGIN_DIR installs another tree, such as the release package, in place of plugin/.
ln -sfn "../../../${GQ_SUPPORT_PLUGIN_DIR:-plugin}" .test-site/wp-content/plugins/gq-support
printf '%s\n' '<?php /* Plugin Name: GETQUICK Design */ define( "GETQUICK_DESIGN_VERSION", "test" );' > .test-site/wp-content/plugins/gq-design/gq-design.php
ddev start
wp() { ddev wp --path=.test-site "$@"; }
if ! ddev exec test -f .test-site/wp-includes/version.php 2>/dev/null; then
  core_args=(--skip-content)
  if [[ -n "${WP_VERSION:-}" ]]; then core_args+=("--version=$WP_VERSION"); fi
  wp core download "${core_args[@]}"
fi
if ! ddev exec test -f .test-site/wp-config.php 2>/dev/null; then wp config create --dbname=db --dbuser=db --dbpass=db --dbhost=db; fi
if ! wp core is-installed >/dev/null 2>&1; then
  wp core install --url=https://gq-support-lifecycle-testsite.ddev.site --title='Lifecycle test' --admin_user=admin --admin_password=admin --admin_email=admin@example.test --skip-email
fi
if wp eval 'exit( is_multisite() ? 0 : 1 );' >/dev/null 2>&1; then
  echo 'run.sh requires a single-site test installation; multisite.sh runs after it.' >&2
  exit 1
fi
wp theme install twentytwentyfour --activate
if wp plugin is-active gq-support 2>/dev/null; then wp plugin deactivate gq-support; fi
if wp plugin is-active gq-design 2>/dev/null; then wp plugin deactivate gq-design; fi
had_identity=0
if wp option get gq_support_state >/dev/null 2>&1; then had_identity=1; fi
if wp plugin activate gq-support >/dev/null 2>&1; then
  echo 'Plugin activated without its required dependency.' >&2
  exit 1
fi
if [[ "$had_identity" == 0 ]] && wp option get gq_support_state >/dev/null 2>&1; then
  echo 'Activation without the dependency initialized local state.' >&2
  exit 1
fi
wp plugin activate gq-design
wp plugin activate gq-support
wp eval-file plugin/tests/integration/lifecycle.php active
wp eval-file plugin/tests/integration/lifecycle.php upgrade
installation_id() { wp eval 'echo GQ_Support_State::get()["installation_id"];'; }
id_before=$(installation_id)
wp plugin deactivate gq-support
[[ "$(wp option pluck gq_support_state installation_id)" == "$id_before" ]]
wp plugin activate gq-support
[[ "$(installation_id)" == "$id_before" ]]
wp eval-file plugin/tests/integration/lifecycle.php active
# Connection design tests (docs/support-onboarding-design.md), against a mocked service.
for scenario in state no-remote-calls legacy-upgrade enroll interrupted-setup test-connection disconnect clone no-key-exposure constants; do
  wp eval-file plugin/tests/integration/connection.php "$scenario"
done
# Verify actual public and admin HTTP responses, not hook registrations.
page_id=$(wp post create --post_type=page --post_title='Lifecycle page' --post_status=publish --post_content='Lifecycle body' --porcelain)
page_url=$(wp post url "$page_id")
page_html=$(curl -fsSL "$page_url")
[[ "$page_html" == *'Lifecycle body'* ]]
[[ "$page_html" != *'gq-support-root'* && "$page_html" != *'/plugins/gq-support/'* ]]
if ! wp user get editor >/dev/null 2>&1; then
  wp user create editor editor@example.test --role=editor --user_pass=editor >/dev/null
fi
site=https://gq-support-lifecycle-testsite.ddev.site
cookies=$(mktemp -d)
reset_editor() { wp eval '( new WP_User( get_user_by( "login", "editor" ) ) )->remove_cap( "gq_support_submit_requests" );'; }
trap 'rm -rf "$cookies"; reset_editor' EXIT
reset_editor
login() { curl -fsSL -c "$cookies/$1" -b "$cookies/$1" -d "log=$1&pwd=$2&wp-submit=Log+In&testcookie=1" "$site/wp-login.php" -o /dev/null; }
status_of() { curl -sS -o /dev/null -w '%{http_code}' -b "$cookies/$1" "${@:2}"; }
login editor editor
admin=$(curl -fsSL -b "$cookies/editor" "$site/wp-admin/")
[[ "$admin" == *'wpadminbar'* ]]
[[ "$admin" != *'gq-support-root'* && "$admin" != *'gq-support-app'* ]]

# Design test 8: only gq_support_manage_settings reaches the setup page and its handlers.
wp eval-file plugin/tests/integration/connection.php enroll
wp user add-cap editor gq_support_submit_requests >/dev/null
if ! wp user get noadmin >/dev/null 2>&1; then
  wp user create noadmin noadmin@example.test --role=administrator --user_pass=noadmin >/dev/null
fi
wp eval '( new WP_User( get_user_by( "login", "noadmin" ) ) )->add_cap( "gq_support_manage_settings", false );'
login noadmin noadmin
for user in editor noadmin; do
  [[ "$(status_of "$user" "$site/wp-admin/admin.php?page=gq-support")" == 403 ]]
  for action in enroll test disconnect; do
    [[ "$(status_of "$user" -d "action=gq_support_$action&code=ABCD" "$site/wp-admin/admin-post.php")" == 403 ]]
  done
done
[[ "$(wp option pluck gq_support_state connection)" == connected ]]
if ! wp user get siteadmin >/dev/null 2>&1; then
  wp user create siteadmin siteadmin@example.test --role=administrator --user_pass=siteadmin >/dev/null
fi
login siteadmin siteadmin
page=$(curl -fsSL -b "$cookies/siteadmin" "$site/wp-admin/admin.php?page=gq-support")
[[ "$page" == *'Key fingerprint'* && "$page" == *'Disconnect'* ]]
secret=$(wp option pluck gq_support_signing_key active secret)
[[ -n "$secret" && "$page" != *"$secret"* ]]
[[ "$(status_of siteadmin -d 'action=gq_support_disconnect' "$site/wp-admin/admin-post.php")" != 302 ]]
[[ "$(wp option pluck gq_support_state connection)" == connected ]]
wp gq-support status --format=json | grep -q '"connection":"connected"'
echo 'Single-site lifecycle and HTTP contexts passed.'
