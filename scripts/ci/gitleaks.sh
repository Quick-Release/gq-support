#!/usr/bin/env bash
# Runs the pinned gitleaks release with this repository's rules (.gitleaks.toml), always redacting
# matched values from its output and reports. The release is downloaded once into a cache and
# refused unless its SHA-256 matches the pin below (from the release's checksums file).
#   scripts/ci/gitleaks.sh git .                  every commit's changes, the full history
#   scripts/ci/gitleaks.sh dir package-dist       files, such as a package or test artifacts
set -euo pipefail

VERSION=8.30.1
case "$(uname -s)_$(uname -m)" in
  Linux_x86_64) asset=linux_x64 sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Linux_aarch64 | Linux_arm64) asset=linux_arm64 sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Darwin_x86_64) asset=darwin_x64 sha=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Darwin_arm64) asset=darwin_arm64 sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  *) echo "No pinned gitleaks build for $(uname -sm)" >&2; exit 2 ;;
esac

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cache=${GITLEAKS_CACHE:-${RUNNER_TOOL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}}/gq-support-gitleaks}/$VERSION-$asset
bin=$cache/gitleaks

if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  download=$(mktemp -d)
  trap 'rm -rf "$download"' EXIT
  archive=$download/gitleaks.tar.gz
  curl -fsSL --retry 3 -o "$archive" "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_$asset.tar.gz"
  if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$archive" | cut -d' ' -f1)
  else
    actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
  fi
  if [ "$actual" != "$sha" ]; then
    echo "gitleaks $VERSION ($asset) has SHA-256 $actual, expected $sha" >&2
    exit 2
  fi
  tar -xzf "$archive" -C "$download" gitleaks
  mv "$download/gitleaks" "$bin"
  rm -rf "$download"
  trap - EXIT
fi

exec "$bin" "$@" --config "$root/.gitleaks.toml" --redact --no-banner
