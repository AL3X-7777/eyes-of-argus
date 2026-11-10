# Firefox Add-ons (AMO) listing (copy and paste)

**Package to upload:** `dist/eyes-of-argus-firefox-<version>.zip`
**Source code upload:** not needed (the package is the unminified source; `build.py` only adds the manifest).

- **Name:** The Eyes of Argus
- **Summary (max 250 characters):**
  Mark YouTube channels, social media accounts and search results that use AI or are owned by private equity. Marks show as badges wherever they appear. Works offline, no account, optional anonymous community sync.
- **Description:** use the description from `chrome-listing.md`.
- **Categories:** Search Tools; Social & Communication
- **License:** MIT
- **Privacy policy:** paste the contents of `PRIVACY.md`
- **Support site:** https://github.com/AL3X-7777/eyes-of-argus/issues
- **Homepage:** https://github.com/AL3X-7777/eyes-of-argus

**Notes to reviewer:**

No build step or minification: the package contains the source files from `src/` plus a generated
manifest (repo: https://github.com/AL3X-7777/eyes-of-argus, `python build.py`).

- No remote code; no eval; DOM is built with `textContent` / DOM methods only.
- Network requests happen only if the user (1) enters a shared-list URL or (2) turns on community
  sync and enters a sync server address. Each needs an optional host permission that is requested
  for that single origin from a click. `data_collection_permissions` declares `websiteActivity`
  as optional and it is requested together with the sync server permission.
- To test: open youtube.com, right-click a channel name → The Eyes of Argus → Mark as AI. A badge
  appears next to that channel. The same menu works on the other listed sites and on search results.
- Community sync can be tested against a local server: `cd server && npm install && npm run db:local && npm run dev`,
  then enter `http://localhost:8787` in the settings page.

**Add-on ID:** `eyes-of-argus@argus.local` (set in `build.py`; it can't be changed after the first upload).
