#!/usr/bin/env bash
set -euo pipefail
build_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$build_root/.toolchain/bin" ]]; then export PATH="$build_root/.toolchain/bin:$PATH"; fi
command -v node >/dev/null || { echo 'Building requires Node.js 22.12+ and npm. Downloaded apps do not.' >&2; exit 1; }
exec node "$build_root/scripts/build-desktop.mjs" "$@"
