# The Eyes of Argus: sync server

A tiny Cloudflare Worker that collects anonymous votes and publishes one community list
(`snapshot.json`). It uses D1 (SQLite) for votes and R2 for the list file, and it fits in
Cloudflare's free plan for a long time.

## How it works
- Each install registers once with a random secret and solves a ~1 second puzzle (proof of work),
  so making thousands of fake installs is slow.
- Votes are `+1` (yes), `-1` (not) or `0` (withdraw), per channel and flag (`ai` / `pe`).
- Every 15 minutes a scheduled job recounts only the channels that changed and patches
  `snapshot.json`. A flag shows for everyone at **≥ 5 weighted votes and ≥ 70 % agreement**.
- New installs count as ¼ vote for their first week. Daily limits apply per install and per network.
  The network is stored only as a salted hash that changes every day.
- `overrides` table: your manual "always show" / "never show" per channel.

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
