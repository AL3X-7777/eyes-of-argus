"""Build The Eyes of Argus for Firefox and Chromium browsers.

Usage:  python build.py
Output: dist/firefox/, dist/chrome/ and a .zip of each.
"""
import json, shutil, zipfile
from pathlib import Path

ROOT = Path(__file__).parent
SRC, DIST = ROOT / "src", ROOT / "dist"
VERSION = "0.2.0"

ICONS = {s: f"icons/icon{s}.png" for s in (16, 32, 48, 128)}

BASE = {
    "manifest_version": 3,
    "name": "The Eyes of Argus",
    "version": VERSION,
    "description": "Mark YouTube channels that use AI or are owned by private equity.",
    "icons": ICONS,
    "permissions": ["contextMenus", "storage", "alarms", "unlimitedStorage"],
    "host_permissions": ["*://*.youtube.com/*"],
    "optional_host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    "action": {"default_title": "The Eyes of Argus", "default_icon": ICONS},
    "options_ui": {"page": "options.html", "open_in_tab": True},
    "content_scripts": [{
        "matches": ["*://*.youtube.com/*"],
        "js": ["content.js"],
        "css": ["content.css"],
        "run_at": "document_start",
    }],
}

TARGETS = {
    "firefox": {
        "background": {"scripts": ["background.js"]},
        "browser_specific_settings": {"gecko": {
            "id": "eyes-of-argus@argus.local",
            "strict_min_version": "140.0",
            "data_collection_permissions": {"required": ["none"]},
        }, "gecko_android": {"strict_min_version": "142.0"}},
    },
    "chrome": {
        "background": {"service_worker": "background.js"},
    },
}

for name, extra in TARGETS.items():
    out = DIST / name
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SRC, out)
    (out / "manifest.json").write_text(json.dumps({**BASE, **extra}, indent=2))
    zpath = DIST / f"eyes-of-argus-{name}-{VERSION}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out).as_posix())
    print("built", zpath.name)
