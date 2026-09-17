#!/usr/bin/env bash
# Runs PHPCS on staged plugin PHP files inside the DDEV test site.
set -euo pipefail

project=gq-support-testsite
plugin_dir=/var/www/html/web/app/plugins/gq-support

files=()
for file in "$@"; do
	files+=("${file#plugin/}")
done

[ ${#files[@]} -eq 0 ] && exit 0

if ! ddev describe "$project" -j 2>/dev/null | grep -q '"status":"running"'; then
	echo "phpcs: DDEV site '$project' is not running; skipping (CI will still check). Start it with 'pnpm wp:start'." >&2
	exit 0
fi

ddev exec -p "$project" --dir "$plugin_dir" composer install --quiet
ddev exec -p "$project" --dir "$plugin_dir" vendor/bin/phpcs "${files[@]}"
