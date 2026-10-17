#!/usr/bin/env bash
set -euo pipefail
integration_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$integration_root/.toolchain/bin" ]]; then export PATH="$integration_root/.toolchain/bin:$PATH"; fi
command -v cmake >/dev/null || { echo 'CMake 3.20+ is required.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Node.js 22.12+ and npm are required to build the frontend.' >&2; exit 1; }
cd "$integration_root/InteractiveTreeBuilder"
npm ci
npm run typecheck
npm test
npm run build
cmake -S "$integration_root/ArborEnum/native" -B "$integration_root/build/native" -DCMAKE_BUILD_TYPE=Release
cmake --build "$integration_root/build/native" --parallel "${BUILD_JOBS:-2}"
ctest --test-dir "$integration_root/build/native" --output-on-failure
mkdir -p "$integration_root/bin"
cp "$integration_root/build/native/arborenum-builder" "$integration_root/bin/arborenum-builder"
echo 'Build complete. Run ./launch.sh and open http://127.0.0.1:8765'
