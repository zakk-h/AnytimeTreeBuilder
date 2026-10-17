#!/usr/bin/env bash
set -euo pipefail
integration_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -x "$integration_root/bin/arborenum-builder" || ! -f "$integration_root/InteractiveTreeBuilder/dist/index.html" ]]; then
  "$integration_root/build.sh"
fi
exec "$integration_root/bin/arborenum-builder" --ui "$integration_root/InteractiveTreeBuilder/dist/index.html" "$@"
