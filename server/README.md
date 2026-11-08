# The Eyes of Argus: sync server

A tiny Cloudflare Worker that collects anonymous votes and publishes one community list
(`snapshot.json`). It uses D1 (SQLite) for votes and R2 for the list file, and it fits in
Cloudflare's free plan for a long time.

## How it works
- Each install registers once with a random secret and solves a one-time puzzle (proof of work,
  usually a few seconds in a browser). It only slows browsers down, not determined attackers,
  so the real protection is the rules below.
- Votes are `+1` (yes), `-1` (not) or `0` (withdraw), per channel and flag (`ai` / `pe`).
- Every 15 minutes a scheduled job recounts only the channels that changed and patches
  `snapshot.json`. A flag shows for everyone at **≥ 15 weighted votes and ≥ 70 % agreement**.
- `overrides` table: your manual "always show" / "never show" per channel.

## Threat model

| Attack | Defence |
|---|---|
| One person marks a channel with many fake installs | new installs carry **no weight for 3 days**; at most **2 counted votes per channel per network**; at most 5 new installs per network per day; 15 weighted votes needed |
| A website uses its visitors' browsers to register or vote | POSTs need `application/json` (forces a CORS preflight that is never allowed) and an extension `Origin` (or none) |
| IPv6 address hopping | networks are grouped by /56 |
| Huge requests | bodies over 64 KB are refused |
| Votes lost in races or crashes | `rev` counter, snapshot written before dirty flags are cleared, ETag-guarded writes |
| Wrong marks | your admin `overrides` table can always hide or force a flag |

Not covered: a determined attacker with many networks over many days. For that, watch the
`channels` table and use overrides.

## Data kept and for how long

- `users`: anonymous id (hash of the install's secret), creation time, a salted hash of the
  network it registered from. Deleted with all its votes by `POST /forget`, which the extension
  sends when you turn sync off and choose to delete your votes.
- `votes`: channel, flag, yes/no and time, per install.
- `limits`: daily counters keyed by salted hashes; anything from previous days is deleted on every run.
- IP addresses themselves are never stored.

## Free-plan budget

- **Recount:** at most 1,800 channels per run, about 42 queries (the free plan allows 50).
- **Snapshot:** served through the edge cache, and the R2 file is only rewritten when it actually changes.
- **Downloads:** each install downloads the list about every 6 hours and sends votes as they are made.

## Run it locally (offline, nothing leaves your PC)
```
npm install
copy .dev.vars.example .dev.vars        (Windows)   or   cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```
The server runs at `http://localhost:8787`. In the extension's settings, set the sync server to that
address and turn on Community sync. Run the scheduled recount by opening
`http://localhost:8787/cdn-cgi/handler/scheduled`.

## Deploy (only when you decide to)
```
npx wrangler login
npx wrangler d1 create argus              -> copy the database_id into wrangler.toml
npx wrangler r2 bucket create eyes-of-argus
npm run db:remote
npx wrangler secret put SALT              -> any long random text
npx wrangler secret put ADMIN_TOKEN       -> another long random text
npm run deploy
```
You get an address like `https://eyes-of-argus.<you>.workers.dev`. That's the sync server URL.

## Admin
- Lock a channel:
  `npx wrangler d1 execute argus --remote --command "INSERT OR REPLACE INTO overrides VALUES ('@handle', NULL, 0, 'reason')"`
  (columns: key, ai, pe, note; 1 = always show, 0 = never show, NULL = let votes decide)
- Rebuild the whole list now:
  `curl -X POST https://<your-worker>/admin/rebuild -H "authorization: Bearer <ADMIN_TOKEN>"`
- Tune thresholds and limits in `wrangler.toml` under `[vars]`.

## If it gets big
Make the R2 bucket public (custom domain) and point the extension at that address for
`snapshot.json`, so list downloads skip the Worker entirely.
