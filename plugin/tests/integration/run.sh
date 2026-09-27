#!/usr/bin/env bash
# Run from the repository root; creates an isolated disposable DDEV WordPress site.
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p .test-site/wp-content/plugins/getquick-design .test-site/wp-content/plugins
ln -sfn ../../../plugin .test-site/wp-content/plugins/gq-support
printf '%s\n' '<?php /* Plugin Name: GETQUICK Design */ define( "GETQUICK_DESIGN_VERSION", "test" );' > .test-site/wp-content/plugins/getquick-design/getquick-design.php
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
if wp plugin is-active getquick-design 2>/dev/null; then wp plugin deactivate getquick-design; fi
had_identity=0
if wp option get gq_support_installation_id >/dev/null 2>&1; then had_identity=1; fi
if wp plugin activate gq-support >/dev/null 2>&1; then
  echo 'Plugin activated without its required dependency.' >&2
  exit 1
fi
if [[ "$had_identity" == 0 ]] && wp option get gq_support_installation_id >/dev/null 2>&1; then
  echo 'Activation without the dependency initialized local state.' >&2
  exit 1
fi
wp plugin activate getquick-design
wp plugin activate gq-support
wp eval-file plugin/tests/integration/lifecycle.php active
wp eval-file plugin/tests/integration/lifecycle.php upgrade
wp eval-file plugin/tests/integration/lifecycle.php clone
id_before=$(wp option get gq_support_installation_id)
wp plugin deactivate gq-support
[[ "$(wp option get gq_support_installation_id)" == "$id_before" ]]
wp plugin activate gq-support
[[ "$(wp option get gq_support_installation_id)" == "$id_before" ]]
wp eval-file plugin/tests/integration/lifecycle.php active
# Verify actual public and admin HTTP responses, not hook registrations.
page_id=$(wp post create --post_type=page --post_title='Lifecycle page' --post_status=publish --post_content='Lifecycle body' --porcelain)
page_url=$(wp post url "$page_id")
page_html=$(curl -fsSL "$page_url")
[[ "$page_html" == *'Lifecycle body'* ]]
[[ "$page_html" != *'gq-support-root'* && "$page_html" != *'/plugins/gq-support/'* ]]
if ! wp user get editor >/dev/null 2>&1; then
  wp user create editor editor@example.test --role=editor --user_pass=editor >/dev/null
fi
cookie=$(mktemp)
trap 'rm -f "$cookie"' EXIT
curl -fsSL -c "$cookie" -b "$cookie" -d 'log=editor&pwd=editor&wp-submit=Log+In&testcookie=1' https://gq-support-lifecycle-testsite.ddev.site/wp-login.php -o /dev/null
admin=$(curl -fsSL -b "$cookie" https://gq-support-lifecycle-testsite.ddev.site/wp-admin/)
[[ "$admin" == *'wpadminbar'* ]]
[[ "$admin" != *'gq-support-root'* && "$admin" != *'gq-support-app'* ]]
echo 'Single-site lifecycle and HTTP contexts passed.'
