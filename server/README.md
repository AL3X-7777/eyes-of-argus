# Eyes of Argus: sync server

A tiny Cloudflare Worker that collects anonymous votes and publishes one community list
(`snapshot.json`). It uses D1 (SQLite) for votes and KV for the published list, and runs on
Cloudflare's free plan. It includes a moderation dashboard at `/admin`.

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
| Votes lost in races or crashes | `rev` counter; the database rows are the source of truth and the published list is rebuilt from them |
| A voter gives a channel a misleading name | names sent by voters are stored but never published in the snapshot |
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

## Costs and limits

**You cannot be charged while the account stays on the Workers Free plan.** Everything this server
uses (Workers, D1, KV, Cron Triggers) is part of that plan, and on it a limit that is reached makes
requests fail until the daily reset at 00:00 UTC. Nothing is billed. Charges only become possible
if you upgrade the account to Workers Paid ($5 a month plus usage). R2 is deliberately not used:
it needs a payment method and bills for usage above its free allowance.

Limits checked against Cloudflare's documentation in November 2026:

| Limit (Free plan) | Allowance | What uses it | When it is reached |
|---|---|---|---|
| Worker requests | 100,000 a day | every call from an extension | all requests fail (error 1027) until midnight UTC |
| CPU time | 10 ms per request and per cron run | the recount | that run fails; nothing is lost, the next run continues |
| D1 rows written | 100,000 a day | votes, rate-limit counters, recounts | votes are refused for the rest of the day |
| D1 rows read | 5 million a day | recounts, the dashboard | recounts and votes fail for the rest of the day |
| D1 queries per run | 50 | the recount (at most 900 channels a run, about 26 queries) | not reached by design |
| KV writes | 1,000 a day | publishing the list (at most 96 a day) | not reached by design |
| KV reads | 100,000 a day | serving the list on a cache miss (cached 10 minutes per Cloudflare location) | the list can't be served until midnight UTC |

When a limit is reached the extension keeps working: it shows the last list it downloaded, keeps
unsent votes in its queue and retries later.

**Rough capacity on the free plan** (estimates, not measured under real traffic):
- about 15,000 installs using it daily (each makes about 6 requests a day: 4 list checks plus votes);
- about 10,000 to 15,000 votes a day (a vote writes roughly 6 to 8 database rows including indexes);
- a published list of up to roughly 10,000 to 20,000 entries before the 10 ms CPU limit gets tight.

Beyond that, the choice is yours: stay free and accept the daily cut-off, or move to Workers Paid.
Watch usage in the Cloudflare dashboard under Workers & Pages, D1 and KV.

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
npx wrangler kv namespace create argus  -> copy the id into wrangler.toml
npm run db:remote
npx wrangler secret put SALT              -> any long random text
npx wrangler secret put ADMIN_TOKEN       -> another long random text
npm run deploy
```
You get an address like `https://eyes-of-argus.<you>.workers.dev`. That's the sync server URL.

## Moderation dashboard

Open `https://<your-worker>/admin` and enter the `ADMIN_TOKEN` you set at deploy time. It lists the
community marks (search by key or name) and lets you:
- **Hide AI / Hide PE / Hide both:** stop a mark from showing for everyone, whatever the votes say;
- **Auto:** let the votes decide again;
- **Delete votes:** remove every vote for that entry;
- **Recount everything.**

Changes show in the published list immediately; extensions pick them up at their next list check
(within about 6 hours, or at once with "Sync now").

Use a long random `ADMIN_TOKEN` (40 characters or more): it is the only thing protecting this page.
The same actions work from a terminal, for example:
`curl -X POST https://<your-worker>/admin/api/override -H "authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" -d '{"key":"@handle","ai":0,"pe":null}'`

Tune thresholds and limits in `wrangler.toml` under `[vars]`.

Your own marks (not the community's) are removed in the extension: toolbar icon → **Your marks**.
