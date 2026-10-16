#!/usr/bin/env python3
"""Package only the Chrome extension's runtime files and installation guide."""

import hashlib
import json
from pathlib import Path
import zipfile


def main():
    root = Path(__file__).resolve().parent.parent
    extension = root / "chrome-extension"
    files = (
        "manifest.json", "background.js", "content.js", "popup.html",
        "popup.js", "popup.css", "lib/rules.js", "README.md",
    )
    version = json.loads((extension / "manifest.json").read_text())["version"]
    output = root / "output" / f"FuturePrice-Chrome-{version}.zip"
    output.parent.mkdir(exist_ok=True)
    # Keep the last verified package if building or checking the next one fails.
    temporary = output.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as package:
            for name in files:
                package.write(extension / name, f"chrome-extension/{name}")
        with zipfile.ZipFile(temporary) as package:
            assert package.testzip() is None
            assert set(package.namelist()) == {f"chrome-extension/{n}" for n in files}
            for name in files:
                assert package.read(f"chrome-extension/{name}") == (extension / name).read_bytes()
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(output.relative_to(root))
    print("SHA-256:", hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
