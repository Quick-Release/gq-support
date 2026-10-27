#!/usr/bin/env bash
# Shared WP-CLI entry for the disposable runtime-cell site. Source from the repo root.
# PHP's documented CLI stream setting must precede PHAR bootstrap. Keep warnings
# visible on stderr, while version/JSON/ID captures receive only command output.
# Do not lower error_reporting or change the HTTP PHP configuration.
wp() {
  # Match ddev wp's Mutagen sync, including host-created release ZIPs on macOS.
  if [[ "$(uname -s)" == Darwin ]]; then ddev mutagen sync >&2 || return; fi
  ddev exec --raw -- php -d display_errors=stderr /usr/local/bin/wp-cli --path=.test-site "$@"
}
