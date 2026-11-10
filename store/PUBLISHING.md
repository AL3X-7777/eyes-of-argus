# Publishing checklist

Everything you need is in this folder. Both stores need you to sign in and submit yourself.

## Before you submit (both stores)
1. `npm test && npm run lint && python build.py`: the packages land in `dist/`.
2. Load the build in a real browser and try it on YouTube, one social site and a Google search.
   The automated tests use simulated pages, so this is the one check that only you can do.
3. Take one real screenshot (1280×800) of YouTube with a badge and the right-click menu open and
   add it to `store/screenshots/`.
4. Decide whether you run a public sync server. Without one, users can still mark, export, import
   and subscribe to shared lists; community sync asks them for a server address.

## Chrome Web Store
1. Register at https://chrome.google.com/webstore/devconsole (one-time $5 fee).
2. **New item** → upload `dist/eyes-of-argus-chrome-<version>.zip`.
3. Fill in the tabs from `chrome-listing.md` (listing text, graphics, privacy practices, permission justifications).
4. Distribution: Public, all regions. Submit for review. Extensions with host permissions on
   several sites usually get a longer review (days rather than hours).

## Firefox Add-ons
1. Sign in at https://addons.mozilla.org/developers/ (free).
2. **Submit a New Add-on** → "On this site" → upload `dist/eyes-of-argus-firefox-<version>.zip`.
3. Fill in the listing from `firefox-listing.md`, including the reviewer notes.
4. Firefox for Android is not targeted: marking needs the right-click menu, which it lacks.

## Edge, Brave, Opera
Brave and Opera install from the Chrome Web Store. For Edge, upload the Chrome zip at
https://partner.microsoft.com/dashboard/microsoftedge (free) with the same listing text.

## Updating later
Change `version` in `package.json`, run `python build.py`, upload the new zips to each store.

## Things reviewers and users may ask about
- **Labels about real people and companies.** A mark is the opinion of whoever set it. The listing
  says so. If you run a public sync server, keep the `overrides` table handy for disputes and
  consider a contact address for removal requests.
- **Third-party site changes.** The selectors for each site are in `src/platforms.js`. If a site
  changes its layout, badges may stop appearing there until that file is updated.
