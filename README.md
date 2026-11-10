# The Eyes of Argus

A browser extension that marks YouTube channels, social media accounts and websites that use AI and/or are owned by private equity.

Works on YouTube, X, Reddit, Instagram, TikTok, Twitch and Facebook, and on Google, Bing and DuckDuckGo results (a result marks its whole website).
Right-click a channel name or video → **The Eyes of Argus** → mark it. Works offline, with no account.
Optional community sync through a tiny self-hosted server (see `server/README.md`).

## Install

**Firefox (for testing)**
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `eyes-of-argus-firefox-0.4.0.zip`
3. Reload any open YouTube tabs

Temporary add-ons disappear when Firefox restarts. To keep it installed, upload the zip to
https://addons.mozilla.org/developers/ as **"On your own"** (unlisted). Signing is free and you
get a signed `.xpi` you can install permanently.

**Chrome / Edge / Brave / Opera**
1. Unzip `eyes-of-argus-chrome-0.4.0.zip` into a folder
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**
3. Click **Load unpacked** and pick the folder

## Using it
- Right-click a channel name, a video thumbnail, or anywhere on a watch/channel page
- **Mark as AI channel** / **Mark as private-equity owned** (a channel can be both)
- **Not AI** / **Not PE-owned**: you disagree. This hides community/shared marks for you and votes against them
- **Clear**: back to no opinion
- Marked channels get an `AI` / `PE` badge and tinted name everywhere on YouTube
- Click the toolbar icon for settings: badges, tinting, fading marked videos, your list of marks

## Community sync
Turn it on in settings and enter your sync server address. Votes are queued while you're offline
and sent when you're back online. The community list is cached for offline use.

## Sharing marks without a server
- **Export marks** in settings creates a JSON file you can send to others, who **Import** it
- Or host that file somewhere static and free (e.g. a GitHub repo) and others paste its raw URL
  into **Shared list**. It updates twice a day when online. Your own marks always override it.

List format:
```json
{ "app": "eyes-of-argus", "version": 1,
  "channels": {
    "@somechannel": { "ai": true, "pe": false, "name": "Some Channel" },
    "UCxxxxxxxxxxxxxxxxxxxxxx": { "ai": false, "pe": true, "name": "Other" }
  } }
```

## Building from source
Edit files in `src/`, then run `python build.py`. Output goes to `dist/`.

## Development
```
npm install && (cd server && npm install)
python build.py      # builds dist/
npm test             # 68 tests, including a local sync server
npm run test:browser # loads the Chrome build into a real Chrome
npm run lint         # ESLint + Mozilla's add-on linter
npm run docs         # API reference in docs/api
```
Architecture, storage keys, messages and file formats: `docs/ARCHITECTURE.md`.
Publishing to the Chrome Web Store and Firefox Add-ons: `store/PUBLISHING.md`. Privacy policy: `PRIVACY.md`.
