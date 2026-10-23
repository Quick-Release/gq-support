#!/usr/bin/env bash
# Installs the real GETQUICK Design release a runtime matrix cell pins (`gqDesign`) into the
# disposable DDEV site, the way a Bedrock site gets it: Composer from the private GETQUICK registry,
# through its authenticating proxy, then the Composer autoloader loaded before plugins.
# COMPOSER_AUTH holds the registry login ({"http-basic":{"proxy.composer.getquick.io":{…}}}); CI
# reads it from the gq-design-sandbox environment, which pull requests from forks never receive.
# Composer runs on the host, so the login never enters the site's container. Does nothing when the
# release is already installed. plugin/tests/integration/run.sh writes the fixture instead when
# its cell pins no release.
#   COMPOSER_AUTH=… scripts/ci/install-gq-design.sh 0.8.1
set -euo pipefail
cd "$(dirname "$0")/../.."
version=${1:?usage: install-gq-design.sh <version>}
project=.test-site/gq-design
plugin=.test-site/wp-content/plugins/gq-design
package=$project/vendor/getquick/gq-design

installed_version() { [[ -f "$package/gq-design.php" ]] && sed -n 's/^ \* Version: *//p' "$package/gq-design.php"; }
if [[ -L "$plugin" && "$(installed_version)" == "$version" ]]; then
  echo "GETQUICK Design $version is already installed."
  exit 0
fi
if [[ -z "${COMPOSER_AUTH:-}" ]]; then
  echo '::error title=GETQUICK Design::COMPOSER_AUTH is empty. CI reads it from the gq-design-sandbox environment, which pull requests from forks never receive: a maintainer pushes the branch to this repository to run this cell. See README, "Real GETQUICK Design cell".' >&2
  exit 1
fi

mkdir -p "$project" .test-site/wp-content/plugins .test-site/wp-content/mu-plugins
# Only the registry: Packagist is off, and the exact version leaves Composer nothing to resolve.
jq -n --arg version "$version" '{
  repositories: [{ type: "composer", url: "https://proxy.composer.getquick.io" }, { "packagist.org": false }],
  require: { "getquick/gq-design": $version },
  config: { "allow-plugins": false }
}' > "$project/composer.json"
# The cell's WordPress enforces the release's "Requires PHP", and run.sh fails on a refusal.
composer update --working-dir="$project" --no-dev --no-interaction --no-progress --prefer-dist --ignore-platform-req=php
[[ "$(installed_version)" == "$version" ]] || { echo "Composer installed GETQUICK Design $(installed_version), not $version." >&2; exit 1; }

rm -rf "$plugin"
ln -sfn ../../gq-design/vendor/getquick/gq-design "$plugin"
# What Bedrock's config/application.php does with its root vendor/autoload.php.
printf '%s\n' '<?php require dirname( __DIR__, 2 ) . "/gq-design/vendor/autoload.php";' > .test-site/wp-content/mu-plugins/gq-design-autoload.php
echo "Installed GETQUICK Design $version."
