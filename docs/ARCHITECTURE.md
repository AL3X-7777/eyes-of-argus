# Eyes of Argus: architecture and reference

Generated API reference (every function, with its parameters): open `docs/api/index.html`.
Regenerate it with `npm run docs`.

## Parts

| File | Runs in | Job |
|---|---|---|
| `src/shared.js` | everywhere (also imported by the server) | key normalization, vote values, hashing, message names, limits |
| `src/platforms.js` | supported sites | one adapter per site: which links are accounts or results, how to turn a link into a key, what counts as a card |
| `src/content.js` + `content.css` | supported sites (top frame) | generic: tags links and cards with `data-argus` attributes, which CSS shows as badges; works out what was right-clicked |
| `src/background.js` | Firefox event page / Chromium service worker | context menu; **only writer** of marks, vote queue and sync settings; community sync; shared list |
| `src/options.html/.js/.css` | settings page | shows and edits everything by sending messages to the background |
| `server/src/index.js` | Cloudflare Worker | registration, votes, forget, snapshot, recount cron |
| `server/src/admin.js` | Cloudflare Worker | moderation dashboard at `/admin` and its API |
| `server/src/lib.js` | Worker (and Node tests) | config, IPv6 grouping, request checks, scoring |
| `build.py` | your PC | builds `dist/firefox` and `dist/chrome` with the right manifest each |

## Keys

| What | Key | Example |
|---|---|---|
| YouTube channel | `@handle` or `UC…` id (unprefixed, as in earlier versions) | `@nileblue` |
| X account | `x:handle` | `x:nasa` |
| Reddit user / subreddit | `reddit:u/name`, `reddit:r/name` | `reddit:r/askreddit` |
| Instagram, TikTok, Twitch, Facebook | `instagram:…`, `tiktok:…`, `twitch:…`, `facebook:…` | `twitch:somestreamer` |
| Website (from a search result) | `site:hostname` without `www.` | `site:example.com` |

`Argus.normalizeKey` is the only place that decides what a valid key is; the extension and the
server both use it. On Google, Bing and DuckDuckGo a result is keyed by its website, except when it
points at a supported platform: then it is keyed by the account (`x:nasa`), and a result that
points at the platform itself can't be marked, so one result can never mark all of YouTube.

**Any other website.** The right-click menu is on every page. Where the content script doesn't
run, the background marks from the link address (or the page address) that the menu click hands
over, and confirms on the toolbar icon. With "Show badges on every website" turned on (an optional
permission), the content script is registered for all https sites and uses the generic adapter:
links that leave the current site are keyed by where they point.

To support another site: add an adapter to `src/platforms.js`, its hosts to `SITES` in `build.py`,
and, for a new key prefix, an entry in `PLATFORMS` in `src/shared.js`.

## Data flow

```
right-click ─▶ background (menu) ─▶ content.js resolves the channel
            ─▶ background.applyMark (serialized) ─▶ storage: marks (+ queue if sync on)
storage change ─▶ every YouTube tab re-tags its links (CSS draws the badges)

queue ─▶ background.syncNow ─▶ POST /votes ─▶ D1 votes, channel marked dirty
cron (15 min) ─▶ rebuild ─▶ channel rows (D1) ─▶ KV snapshot.json ─▶ GET /snapshot.json (ETag) ─▶ storage: community
```

Display priority for each flag: **your mark** (yes / not) → **shared list** → **community list**
(community only while sync is on).

## Storage keys (`storage.local`)

| Key | Content |
|---|---|
| `marks` | `{ "@handle" or "UC…": {ai, pe, name, uc?, t, src?} }`, where ai/pe are 1 = yes, -1 = not, 0 = none (`true` from v0.1 still means yes); `src: "import"` = came from someone else's list |
| `queue` | `{ "key|flag": {k, f, v, name, t} }` votes waiting to be sent (latest wins) |
| `syncReplace` | non-zero token → the next upload replaces all of this install's votes on the server |
| `sync` | `{enabled, server, gen}`; `gen` changes on every on/off/server change and stops uploads already running |
| `identity` | `{secret, id, registeredAt}`; the server only ever sees `secret` over HTTPS and stores `sha256(secret)` |
| `powProgress` | `{id, bits, next}` saved puzzle progress |
| `pendingForget` | `[{server, secret}]` "delete my votes" requests still to be sent (retried every 5 min) |
| `community` / `communityMeta` | the community list / its ETag, count and times (kept apart so a "no change" check doesn't make tabs reload the list) |
| `syncStatus` | result of the last sync (`sent`, `count`, `uploadError`, `downloadError`) |
| `sharedList`, `listUrl` | subscribed shared list and its address |
| `settings` | `{badges, tint, dim}` |

## Messages (`Argus.MSG`)

| Type | From → to | Payload | Answer |
|---|---|---|---|
| `argus-menu` | background → content | `{action}` | none |
| `argus-mark` | content/options → background | `{key, name?, uc?, changes: {ai?, pe?}}` | `{ok, mark}` |
| `argus-import` | options → background | `{data, mode}`; `mode: "restore"` reads `mine`, anything else reads `channels` | `{ok, count}` |
| `argus-wipe` | options → background | none | `{ok}` |
| `argus-sync-config` | options → background | `{enabled, server?, withdraw?}` | `{ok}` |
| `argus-sync-now` | options → background | none | sync status |
| `argus-update-list` | options → background | none | `{ok, count}` |
| `argus-everywhere` | options → background | `{on}` | `{ok}` |

The background only answers messages from its own extension (`sender.id`). Pages are told apart by address: only the extension's own pages may send anything other than `argus-mark` (the settings page also runs in a tab, so `sender.tab` can't be used for this).

## File formats

**Export / shared list** (`version: 2`):

```json
{ "app": "eyes-of-argus", "version": 2,
  "channels": { "@x": { "ai": true, "pe": false, "name": "X" } },
  "mine":     { "@x": { "ai": 1, "pe": -1, "name": "X", "uc": "UC…" } } }
```

`channels` is the simple format, which any shared list or older export uses. `mine` is the exact backup.
**Restore backup** reads `mine` and restores your choices (and votes them if sync is on).
**Import list** reads `channels`, adds "yes" where you have no opinion and is **not** sent as your
votes. The button decides, because every export contains both sections.

**Community snapshot** (`GET /snapshot.json`):

```json
{ "v": 1, "generated": 1794000000000, "min": { "votes": 15, "agree": 70 },
  "c": { "@x": [92, 41, 0, 0, "X"], "UC…": [100, 0, 0, 0, "Y", 1] } }
```

Each entry is `[aiPct, aiVotes, pePct, peVotes, "", overrideBits?]` (the fifth slot is always empty: names come from voters and are never published). The vote counts include only votes that counted (weighted, network cap applied). A pct of 0 means not shown.
In `overrideBits`, 1 means AI was set by the admin and 2 means PE was.

## Server API

| Route | Body | Responses |
|---|---|---|
| `GET /config` | none | `{powBits, minVotes, minAgree, maxBatch}` |
| `GET /snapshot.json` | `If-None-Match` | 200 / 304 |
| `POST /register` | `{secret, nonce}` | 200 `{id}`, 400 weak puzzle, 429 network limit |
| `POST /votes` | `{secret, votes:[{k,f,v,name}], replace?}` (≤ 100) | 200, 400, 401 unknown install, 429 daily limit |
| `POST /forget` | `{secret}` | 200 |
| `GET /admin` | none | the moderation dashboard page |
| `GET /admin/api/channels` | `?q=&shown=1`, `Authorization: Bearer …` | list with tallies and overrides |
| `POST /admin/api/override` | `{key, ai, pe, note}` | 200, 400, 403 |
| `POST /admin/api/purge` | `{key}` | 200, 400, 403 |
| `POST /admin/rebuild` | `Authorization: Bearer …` | 200 `{changed,total}`, 403 |

All POSTs require `content-type: application/json` and a body of 64 KB or less. Any `Origin` header must be an extension origin.

## Tests and tooling

`npm test` runs 72 tests: content script on every platform, background, settings page, server
end-to-end against a real local `wrangler dev`, and regression tests for every review finding.
`npm run test:browser` loads the Chrome build into a real Chrome and checks the service worker,
the settings page and badges on locally served copies of YouTube, Google, X and Reddit pages. `npm run lint` runs ESLint and
web-ext lint. `npm run docs` generates the API reference. `.github/workflows/ci.yml` runs build,
lint and tests on every push.
