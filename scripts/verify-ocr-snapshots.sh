#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/android-env.sh"
cd "$script_dir/.."
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --console=plain "$@"
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
python3 - <<'PYTHON'
import re, subprocess
cases = {"multi-product.png": ["192", "38", "60", "389"], "observed-miss.png": ["192"]}
for asset, expected in cases.items():
    result = subprocess.run(["adb", "shell", "am", "instrument", "-w", "-e", "asset", asset,
        "-e", "mode", "both", "dev.futureprice.app.test/dev.futureprice.app.OcrSnapshotInstrumentation"],
        check=True, capture_output=True, text=True, timeout=90).stdout
    labels = re.findall(r'^"10年≈(\d+)" source=', result, re.MULTILINE)
    if "INSTRUMENTATION_CODE: -1" not in result or sorted(labels) != sorted(expected):
        raise SystemExit(f"FAIL {asset}: expected={expected}, actual={labels}\n{result}")
    print(f"PASS {asset}: {len(labels)} expected labels")
for tight in ("false", "true"):
    result = subprocess.run(["adb", "shell", "am", "instrument", "-w", "-e", "mode", "sales_fixture",
        "-e", "tight", tight, "dev.futureprice.app.test/dev.futureprice.app.OcrSnapshotInstrumentation"],
        check=True, capture_output=True, text=True, timeout=90).stdout
    if "INSTRUMENTATION_CODE: -1" not in result or "INSTRUMENTATION_RESULT: passed=true" not in result:
        raise SystemExit(f"FAIL sales_fixture tight={tight}:\n{result}")
    print(f"PASS sales_fixture tight={tight}: 4 correct labels; coupon, range and literal Y rejected")
PYTHON
