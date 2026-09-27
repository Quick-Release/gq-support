#!/usr/bin/env bash
# Run from the repository root; creates an isolated disposable DDEV WordPress site.
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p .test-site/wp-content/plugins/getquick-design .test-site/wp-content/plugins
ln -sfn ../../../plugin .test-site/wp-content/plugins/gq-support
printf '%s\n' '<?php /* Plugin Name: GETQUICK Design */ define( "GETQUICK_DESIGN_VERSION", "test" );' > .test-site/wp-content/plugins/getquick-design/getquick-design.php
ddev start
wp() { ddev wp --path=.test-site "$@"; }
if ! ddev exec test -f .test-site/wp-includes/version.php; then wp core download --skip-content; fi
if ! ddev exec test -f .test-site/wp-config.php; then wp config create --dbname=db --dbuser=db --dbpass=db --dbhost=db; fi
if ! wp core is-installed >/dev/null 2>&1; then
  wp core install --url=https://gq-support-lifecycle-testsite.ddev.site --title='Lifecycle test' --admin_user=admin --admin_password=admin --admin_email=admin@example.test --skip-email
fi
wp theme install twentytwentyfive --activate
wp plugin activate getquick-design
wp plugin activate gq-support
wp eval-file plugin/tests/integration/lifecycle.php active
wp eval-file plugin/tests/integration/lifecycle.php upgrade
id_before=$(wp option get gq_support_installation_id)
wp plugin deactivate gq-support
[[ "$(wp option get gq_support_installation_id)" == "$id_before" ]]
wp plugin activate gq-support
[[ "$(wp option get gq_support_installation_id)" == "$id_before" ]]
wp eval-file plugin/tests/integration/lifecycle.php active
# Verify actual public and admin HTTP responses, not hook registrations.
wp post create --post_type=page --post_title='Lifecycle page' --post_status=publish --post_content='Lifecycle body' >/dev/null
! curl -fsS https://gq-support-lifecycle-testsite.ddev.site/?p=2 | grep -Eq 'gq-support-root|gq-support-app'
wp user create editor editor@example.test --role=editor --user_pass=editor --porcelain >/dev/null 2>&1 || true
cookie=$(mktemp)
trap 'rm -f "$cookie"' EXIT
curl -fsSL -c "$cookie" -b "$cookie" -d 'log=editor&pwd=editor&wp-submit=Log+In&testcookie=1' https://gq-support-lifecycle-testsite.ddev.site/wp-login.php -o /dev/null
admin=$(curl -fsSL -b "$cookie" https://gq-support-lifecycle-testsite.ddev.site/wp-admin/)
[[ "$admin" == *'wpadminbar'* ]]
[[ "$admin" != *'gq-support-root'* && "$admin" != *'gq-support-app'* ]]
echo 'Single-site lifecycle and HTTP contexts passed.'
