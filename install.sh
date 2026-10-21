#!/usr/bin/env bash
set -euo pipefail

command -v node >/dev/null 2>&1 || { printf '%s\n' 'Install Node.js 22.20.0 or newer first.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' 'Install npm first.' >&2; exit 1; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 20)) { console.error("Node.js 22.20.0 or newer is required."); process.exit(1); }'

package_url="${HUMAN_FORMAT_PACKAGE:-https://github.com/zhysky/human-format/releases/latest/download/human-format.tgz}"
install_tmp="$(mktemp -d "${TMPDIR:-/tmp}/human-format-install.XXXXXX")"
trap 'rm -rf "$install_tmp"' EXIT
cd "$install_tmp"

install_args=(install --global --registry=https://registry.npmjs.org --no-audit --no-fund)
if [[ -n "${HUMAN_FORMAT_INSTALL_PREFIX:-}" ]]; then
  install_args+=(--prefix "$HUMAN_FORMAT_INSTALL_PREFIX")
fi
npm "${install_args[@]}" "$package_url"
printf '%s\n' 'Installed. Run human-format --help to get started.'
