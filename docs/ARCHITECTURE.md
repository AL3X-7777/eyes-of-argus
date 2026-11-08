# The Eyes of Argus: architecture and reference

Generated API reference (every function, with its parameters): open `docs/api/index.html`.
Regenerate it with `npm run docs`.

## Parts

| File | Runs in | Job |
|---|---|---|
| `src/shared.js` | everywhere (also imported by the server) | key normalization, vote values, hashing, message names, limits |
| `src/content.js` + `content.css` | YouTube tabs (top frame) | tags channel links and cards with `data-argus` attributes, which CSS shows as badges; works out which channel was right-clicked |
| `src/background.js` | Firefox event page / Chromium service worker | context menu; **only writer** of marks, vote queue and sync settings; community sync; shared list |
| `src/options.html/.js/.css` | settings page | shows and edits everything by sending messages to the background |
| `server/src/index.js` | Cloudflare Worker | registration, votes, forget, snapshot, recount cron |
| `server/src/lib.js` | Worker (and Node tests) | config, IPv6 grouping, request checks, scoring |
| `build.py` | your PC | builds `dist/firefox` and `dist/chrome` with the right manifest each |

## Data flow

```
right-click ─▶ background (menu) ─▶ content.js resolves the channel
            ─▶ background.applyMark (serialized) ─▶ storage: marks (+ queue if sync on)
storage change ─▶ every YouTube tab re-tags its links (CSS draws the badges)

queue ─▶ background.syncNow ─▶ POST /votes ─▶ D1 votes, channel marked dirty
cron (15 min) ─▶ rebuild ─▶ R2 snapshot.json ─▶ GET /snapshot.json (ETag) ─▶ storage: community
```

Display priority for each flag: **your mark** (yes / not) → **shared list** → **community list**
(community only while sync is on).

## Storage keys (`storage.local`)

| Key | Content |
|---|---|
| `marks` | `{ "@handle" or "UC…": {ai, pe, name, uc?, t, src?} }`, where ai/pe are 1 = yes, -1 = not, 0 = none (`true` from v0.1 still means yes); `src: "import"` = came from someone else's list |
| `queue` | `{ "key|flag": {k, f, v, name, t} }` votes waiting to be sent (latest wins) |
| `syncReplace` | true → the next upload replaces all of this install's votes on the server |
| `sync` | `{enabled, server}` |
| `identity` | `{secret, id, registeredAt}`; the server only ever sees `secret` over HTTPS and stores `sha256(secret)` |
| `powProgress` | `{id, bits, next}` saved puzzle progress |
| `pendingForget` | `{server, secret}` "delete my votes" still to be sent |
| `community` / `communityMeta` | the community list / its ETag, count and times (kept apart so a "no change" check doesn't make tabs reload the list) |
| `syncStatus` | result of the last sync (`sent`, `count`, `uploadError`, `downloadError`) |
| `sharedList`, `listUrl` | subscribed shared list and its address |
| `settings` | `{badges, tint, dim}` |

## Messages (`Argus.MSG`)

| Type | From → to | Payload | Answer |
|---|---|---|---|
| `argus-menu` | background → content | `{action}` | none |
| `argus-mark` | content/options → background | `{key, name?, uc?, changes: {ai?, pe?}}` | `{ok, mark}` |
| `argus-import` | options → background | `{data}` (export file) | `{ok, count}` |
| `argus-wipe` | options → background | none | `{ok}` |
| `argus-sync-config` | options → background | `{enabled, server?, withdraw?}` | `{ok}` |
| `argus-sync-now` | options → background | none | sync status |
| `argus-update-list` | options → background | none | `{ok, count}` |

The background only answers messages from its own extension (`sender.id`).

## File formats

**Export / shared list** (`version: 2`):

```json
{ "app": "eyes-of-argus", "version": 2,
  "channels": { "@x": { "ai": true, "pe": false, "name": "X" } },
  "mine":     { "@x": { "ai": 1, "pe": -1, "name": "X", "uc": "UC…" } } }
```

`channels` is the simple format, which any shared list or older export uses. `mine` is the exact backup.
Importing `mine` restores your choices (and votes them if sync is on). Importing only `channels`
adds "yes" where you have no opinion and is **not** sent as your votes.

**Community snapshot** (`GET /snapshot.json`):

```json
{ "v": 1, "generated": 1794000000000, "min": { "votes": 15, "agree": 70 },
  "c": { "@x": [92, 41, 0, 0, "X"], "UC…": [100, 0, 0, 0, "Y", 1] } }
```

Each entry is `[aiPct, aiVotes, pePct, peVotes, name, overrideBits?]`. A pct of 0 means not shown.
In `overrideBits`, 1 means AI was set by the admin and 2 means PE was.

## Server API

| Route | Body | Responses |
|---|---|---|
| `GET /config` | none | `{powBits, minVotes, minAgree, maxBatch}` |
| `GET /snapshot.json` | `If-None-Match` | 200 / 304 |
| `POST /register` | `{secret, nonce}` | 200 `{id}`, 400 weak puzzle, 429 network limit |
| `POST /votes` | `{secret, votes:[{k,f,v,name}], replace?}` (≤ 100) | 200, 400, 401 unknown install, 429 daily limit |
| `POST /forget` | `{secret}` | 200 |
| `POST /admin/rebuild` | `Authorization: Bearer …` | 200 `{changed,total}`, 403 |

All POSTs require `content-type: application/json` and a body of 64 KB or less. Any `Origin` header must be an extension origin.

## Tests and tooling

`npm test` runs 26 tests: content script, background, server end-to-end against a real local
`wrangler dev`, and regression tests for every review finding. `npm run lint` runs ESLint and
web-ext lint. `npm run docs` generates the API reference. `.github/workflows/ci.yml` runs build,
lint and tests on every push.
