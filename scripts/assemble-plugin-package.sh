#!/usr/bin/env bash
# Assembles the release package tree from a built checkout. Run `pnpm build:app` first.
# Usage: scripts/assemble-plugin-package.sh [destination]   (default: package-dist)
set -euo pipefail
cd "$(dirname "$0")/.."
dest=${1:-package-dist}

rm -rf "$dest"
mkdir -p "$dest/assets"
cp plugin/gq-support.php "$dest/"
cp plugin/uninstall.php "$dest/"
cp plugin/readme.txt "$dest/"
cp plugin/README.md "$dest/"
cp plugin/composer.json "$dest/"
cp -R plugin/includes "$dest/includes"
cp plugin/assets/launcher.js plugin/assets/launcher.css "$dest/assets/"
cp -R plugin/assets/dist "$dest/assets/dist"
mkdir -p "$dest/languages"
cp plugin/languages/*.json plugin/languages/*.mo "$dest/languages/"
