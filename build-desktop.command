#!/bin/bash
build_root="$(cd -- "$(dirname -- "$0")" && pwd)"
"$build_root/build-desktop.sh" "$@"
build_status=$?
if [[ $build_status -ne 0 ]]; then
  printf '\nBuild failed. Review the error above. Press Return to close.\n'
  read -r
else
  open "$build_root/dist/apps"
fi
exit "$build_status"
