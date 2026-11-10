"""Build The Eyes of Argus for Firefox and Chromium browsers.

Usage:  python build.py
Output: dist/firefox/, dist/chrome/ and a .zip of each.
"""
import json, shutil, zipfile
from pathlib import Path

ROOT = Path(__file__).parent
SRC, DIST = ROOT / "src", ROOT / "dist"
VERSION = json.loads((ROOT / "package.json").read_text())["version"]  # single source of truth

# Google runs search on one domain per country; match patterns can't wildcard the ending.
GOOGLE_TLDS = """com co.uk de fr es it nl pl ca com.au co.in com.br co.jp ru com.mx se no dk fi at ch be pt ie
cz gr hu ro com.tr co.za co.nz com.ar co.kr com.ua sk bg hr rs lt lv ee si lu is co.il ae com.sa com.eg
com.sg com.hk com.tw co.th co.id com.my com.ph com.vn com.pk com.bd com.ng co.ke cl com.co com.pe""".split()

# Every site the content script runs on. background.js reads this list from the manifest
# for the right-click menu, and src/platforms.js has the matching adapter for each.
SITES = [
    "*://*.youtube.com/*",
    "*://*.x.com/*", "*://*.twitter.com/*",
    "*://*.reddit.com/*",
    "*://*.instagram.com/*",
    "*://*.tiktok.com/*",
    "*://*.twitch.tv/*",
    "*://*.facebook.com/*",
    "*://www.bing.com/search*",
    "*://duckduckgo.com/*", "*://html.duckduckgo.com/*",
    *[f"*://www.google.{tld}/search*" for tld in GOOGLE_TLDS],
]

ICONS = {s: f"icons/icon{s}.png" for s in (16, 32, 48, 128)}

BASE = {
    "manifest_version": 3,
    "name": "The Eyes of Argus",
    "version": VERSION,
    "description": "Mark YouTube channels, social accounts and search results that use AI or are owned by private equity. Works offline.",
    "icons": ICONS,
    "permissions": ["contextMenus", "storage", "alarms", "unlimitedStorage"],
    "host_permissions": SITES,
    "optional_host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    "action": {"default_title": "The Eyes of Argus", "default_icon": ICONS},
    "options_ui": {"page": "options.html", "open_in_tab": True},
    "content_scripts": [{
        "matches": SITES,
        "js": ["shared.js", "platforms.js", "content.js"],
        "css": ["content.css"],
        "run_at": "document_start",
    }],
}

TARGETS = {
    "firefox": {
        "background": {"scripts": ["shared.js", "background.js"]},
        "browser_specific_settings": {"gecko": {
            "id": "eyes-of-argus@argus.local",
            "strict_min_version": "142.0",
            "data_collection_permissions": {"required": ["none"], "optional": ["websiteActivity"]},
        }},  # desktop only: marking needs the right-click menu, which Firefox for Android lacks
    },
    "chrome": {
        "background": {"service_worker": "background.js"},  # loads shared.js via importScripts
        "minimum_chrome_version": "111",
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
