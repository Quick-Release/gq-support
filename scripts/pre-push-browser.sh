#!/usr/bin/env bash
# Optional pre-push check: the browser specs affected by the pushed files, against the shared
# DDEV test site. CI stays the merge gate; this only catches failures before a CI round trip.
#
# - Skips when the test site is not running, or with GQ_SUPPORT_SKIP_PRE_PUSH=1.
# - One run at a time: every agent shares one site, and the specs change its state.
# - From a worktree, the site serves a copy of that worktree's plugin/ for the run, then
#   points back at the main checkout's plugin/.
set -euo pipefail

project=gq-support-lifecycle-testsite
repo=$(git rev-parse --show-toplevel)

[ -n "${GQ_SUPPORT_SKIP_PRE_PUSH:-}" ] && exit 0

specs=()
add() { for spec in "$@"; do [[ " ${specs[*]-} " == *" $spec "* ]] || specs+=("$spec"); done; }
for file in "$@"; do
	case "$file" in
		plugin/tests/browser/*.spec.ts) add "$(basename "$file")" ;;
		plugin/tests/performance/* | plugin/assets/launcher.* | plugin/includes/class-gq-support-plugin.php)
			add performance.spec.ts launcher.spec.ts ;;
		plugin/app/src/useRequests.ts | plugin/app/src/Requests.tsx) add requests.spec.ts status-change.spec.ts ;;
		plugin/app/src/useSubmission.ts) add submission.spec.ts requests.spec.ts ;;
		plugin/app/src/useSession.ts | plugin/includes/class-gq-support-access.php) add session.spec.ts submission.spec.ts requests.spec.ts status-change.spec.ts ;;
		plugin/app/* | plugin/includes/* | plugin/languages/* | plugin/*.php)
			add launcher.spec.ts session.spec.ts submission.spec.ts requests.spec.ts status-change.spec.ts ;;
	esac
done
[ ${#specs[@]} -eq 0 ] && exit 0

describe=$(ddev describe "$project" -j 2>/dev/null || true)
if ! grep -q '"status":"running"' <<<"$describe"; then
	echo "pre-push: DDEV site '$project' is not running; skipping ${specs[*]} (CI will still run them)." >&2
	exit 0
fi
site_root=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).raw.approot)' <<<"$describe")
site=$site_root/.test-site
link=$site/wp-content/plugins/gq-support

# A directory is created atomically; a lock whose owner has exited is stale.
lock=$site/.pre-push.lock
until mkdir "$lock" 2>/dev/null; do
	owner=$(cat "$lock/pid" 2>/dev/null || true)
	if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$lock"; continue; fi
	echo "pre-push: waiting for another test run on the shared site (pid ${owner:-?})..." >&2
	sleep 5
done
echo $$ >"$lock/pid"

# PHP-FPM caches resolved paths (realpath cache and opcache): after repointing the plugin
# symlink, reload it, or the site keeps resolving the plugin to the old directory.
reload_php() { (cd "$site_root" && ddev exec 'sudo kill -USR2 "$(cat /run/php/php*-fpm.pid)"' && sleep 1); }
created_link=""
cleanup() {
	if [ "$repo" != "$site_root" ]; then ln -sfn ../../../plugin "$link" && reload_php; fi
	if [ -n "$created_link" ]; then rm -f "$repo/.test-site"; fi
	rm -rf "$lock"
}
trap cleanup EXIT

if [ ! -d "$repo/node_modules" ]; then (cd "$repo" && pnpm install --frozen-lockfile --silent); fi
# assets/dist is not committed, so build what this checkout would ship.
(cd "$repo" && pnpm --silent build:app >/dev/null)

if [ "$repo" != "$site_root" ]; then
	rsync -a --delete --exclude vendor/ --exclude node_modules/ "$repo/plugin/" "$site/.pre-push-plugin/"
	ln -sfn ../../.pre-push-plugin "$link"
	reload_php
	# The specs find the site through <checkout>/.test-site.
	if [ ! -e "$repo/.test-site" ]; then ln -s "$site" "$repo/.test-site"; created_link=1; fi
	if [ "$(uname)" = Darwin ]; then ddev mutagen sync "$project"; fi
fi

echo "pre-push: running ${specs[*]} on the shared test site (skip with GQ_SUPPORT_SKIP_PRE_PUSH=1)." >&2
# DDEV resolves the project from the working directory, so run from the site's checkout.
cd "$site_root"
"$repo/node_modules/.bin/playwright" test --config "$repo/plugin/tests/browser/playwright.config.ts" --reporter=line "${specs[@]}"
