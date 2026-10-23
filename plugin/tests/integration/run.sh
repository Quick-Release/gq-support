#!/usr/bin/env bash
# Run from the repository root; creates an isolated disposable DDEV WordPress site.
# A CI matrix cell (.github/runtime-matrix.json) selects its runtime with WP_VERSION,
# GQ_SUPPORT_PHP_VERSION (8.0) and GQ_SUPPORT_DATABASE (mysql:8.0); unset keeps .ddev/config.yaml.
# An existing site keeps its WordPress and database, so switching either needs a fresh site.
set -euo pipefail
cd "$(dirname "$0")/../../.."
site=${GQ_SUPPORT_TEST_URL:-https://gq-support-lifecycle-testsite.ddev.site}
# DDEV merges config.*.yaml over config.yaml; this one is untracked.
runtime_config=.ddev/config.gq-runtime.yaml
{
  [[ -z "${GQ_SUPPORT_PHP_VERSION:-}" ]] || printf 'php_version: "%s"\n' "$GQ_SUPPORT_PHP_VERSION"
  [[ -z "${GQ_SUPPORT_DATABASE:-}" ]] || printf 'database:\n  type: %s\n  version: "%s"\n' "${GQ_SUPPORT_DATABASE%%:*}" "${GQ_SUPPORT_DATABASE#*:}"
} > "$runtime_config"
[[ -s "$runtime_config" ]] || rm "$runtime_config"
mkdir -p .test-site/wp-content/plugins/gq-design .test-site/wp-content/plugins
# GQ_SUPPORT_PLUGIN_DIR links another tree, such as the assembled package, in place of plugin/.
# GQ_SUPPORT_PLUGIN_ZIP (repository-relative) installs a release ZIP instead, once WordPress is up.
installed=.test-site/wp-content/plugins/gq-support
if [[ -n "${GQ_SUPPORT_PLUGIN_ZIP:-}" ]]; then
  [[ ! -L "$installed" ]] || rm "$installed"
else
  [[ -L "$installed" || ! -e "$installed" ]] || rm -rf "$installed"
  ln -sfn "../../../${GQ_SUPPORT_PLUGIN_DIR:-plugin}" "$installed"
fi
printf '%s\n' '<?php /* Plugin Name: GETQUICK Design */ define( "GETQUICK_DESIGN_VERSION", "test" );' > .test-site/wp-content/plugins/gq-design/gq-design.php
ddev start
# A running site keeps its PHP until restarted, including after an earlier cell's override.
php_version=${GQ_SUPPORT_PHP_VERSION:-$(sed -n 's/^php_version: *"\(.*\)"/\1/p' .ddev/config.yaml)}
if [[ "$(ddev exec php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;')" != "$php_version" ]]; then ddev restart; fi
wp() { ddev wp --path=.test-site "$@"; }
if ! ddev exec test -f .test-site/wp-includes/version.php 2>/dev/null; then
  core_args=(--skip-content)
  if [[ -n "${WP_VERSION:-}" ]]; then core_args+=("--version=$WP_VERSION"); fi
  wp core download "${core_args[@]}"
fi
# WordPress reports x.y.0 releases as x.y.
expected_wp=${WP_VERSION:-}
[[ "$expected_wp" =~ ^([0-9]+\.[0-9]+)\.0$ ]] && expected_wp=${BASH_REMATCH[1]}
if [[ "$expected_wp" =~ ^[0-9.]+$ && "$(wp core version)" != "$expected_wp" ]]; then
  echo "The test site runs WordPress $(wp core version), not $WP_VERSION; remove .test-site to switch versions." >&2
  exit 1
fi
if ! ddev exec test -f .test-site/wp-config.php 2>/dev/null; then wp config create --dbname=db --dbuser=db --dbpass=db --dbhost=db; fi
if ! wp core is-installed >/dev/null 2>&1; then
  wp core install --url="$site" --title='Lifecycle test' --admin_user=admin --admin_password=admin --admin_email=admin@example.test --skip-email
fi
if wp eval 'exit( is_multisite() ? 0 : 1 );' >/dev/null 2>&1; then
  echo 'run.sh requires a single-site test installation; multisite.sh runs after it.' >&2
  exit 1
fi
wp theme install twentytwentyfour --activate
# Avatars load from gravatar.com, and an admin page's load event waits for them: keep browser tests off the internet.
wp option update show_avatars 0
# The object-cache cell: Redis from the ddev-redis add-on, which CI installs before this script.
if [[ -n "${GQ_SUPPORT_REDIS_CACHE_VERSION:-}" ]]; then
  wp config set WP_REDIS_HOST redis
  wp plugin install redis-cache --version="$GQ_SUPPORT_REDIS_CACHE_VERSION" --activate
  wp redis enable --force
fi
if [[ -n "${GQ_SUPPORT_PLUGIN_ZIP:-}" ]]; then
  # WordPress's package installer unpacks the archive; the site then runs exactly those files.
  wp plugin install "$GQ_SUPPORT_PLUGIN_ZIP" --force
  node scripts/ci/release-package.mjs installed "$(dirname "$GQ_SUPPORT_PLUGIN_ZIP")" "$installed"
fi
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
wp eval-file plugin/tests/integration/access.php
wp eval-file plugin/tests/integration/privacy.php
# Its own process: it defines GQ_SUPPORT_DISABLED for the rest of the request.
wp eval-file plugin/tests/integration/fail-safe.php
ddev exec --dir /var/www/html/plugin composer install --quiet
wp eval-file plugin/tests/contract/run.php
# Verify actual public and admin HTTP responses, not hook registrations.
page_id=$(wp post create --post_type=page --post_title='Lifecycle page' --post_status=publish --post_content='Lifecycle body' --porcelain)
page_url=$(wp post url "$page_id")
page_html=$(curl -fsSL "$page_url")
[[ "$page_html" == *'Lifecycle body'* ]]
[[ "$page_html" != *'gq-support-root'* && "$page_html" != *'/plugins/gq-support/'* ]]
if ! wp user get editor >/dev/null 2>&1; then
  wp user create editor editor@example.test --role=editor --user_pass=editor >/dev/null
fi
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
