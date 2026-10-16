#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
source "$script_dir/android-env.sh"
cd "$project_dir"

./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug \
  :app:assembleRelease :fixture:assembleDebug --console=plain "$@"

for apk in app/build/outputs/apk/debug/app-debug.apk \
           app/build/outputs/apk/release/app-release-unsigned.apk; do
  permissions="$("$ANDROID_HOME/build-tools/35.0.0/aapt2" dump permissions "$apk")"
  if printf '%s\n' "$permissions" | grep -Eq \
    "android.permission.(INTERNET|ACCESS_NETWORK_STATE|RECORD_AUDIO|CAMERA|QUERY_ALL_PACKAGES)'"; then
    printf 'Unexpected permission in %s\n%s\n' "$apk" "$permissions" >&2
    exit 1
  fi
  printf 'Permission check passed: %s\n' "$apk"
done
