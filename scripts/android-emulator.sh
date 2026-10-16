#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/android-env.sh"
exec "$ANDROID_HOME/emulator/emulator" \
  -avd FuturePrice_API35_ARM64 \
  -memory 3072 -cores 4 -gpu auto -no-audio "$@"
