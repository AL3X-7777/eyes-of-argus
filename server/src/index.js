/**
 * @file The Eyes of Argus sync server (Cloudflare Worker + D1 + R2).
 *
 * | Route                | What it does |
 * |----------------------|--------------|
 * | `GET  /config`       | puzzle difficulty and thresholds |
 * | `GET  /snapshot.json`| the community list (ETag, edge cache) |
 * | `POST /register`     | `{secret, nonce}` → `{id}`: anonymous install, proof of work |
 * | `POST /votes`        | `{secret, votes:[{k,f,v,name}], replace?}` |
 * | `POST /forget`       | `{secret}`: delete all of this install's votes and the install |
 * | `POST /admin/rebuild`| `Authorization: Bearer <ADMIN_TOKEN>`: recount everything |
 * | cron (15 min)        | recount changed channels, patch the snapshot |
 *
 * Abuse resistance (see server/README.md, "Threat model"): POSTs only from extensions
 * or non-browser clients; daily limits per install and per network (IPv6 grouped by
 * /56); new installs carry no weight for their first days; at most `MAX_PER_NET`
 * votes per channel count from installs registered on the same network.
 */
import { A, DAY, cfg, netOf, originAllowed, readJson, safeEqual, chunks, score } from './lib.js';

const SNAPSHOT = 'snapshot.json';
/** Fixed edge-cache key for the snapshot, so a rebuild can invalidate it. */
const CACHE_KEY = 'https://argus.cache/snapshot.json';

/** CORS only for reading; POST routes are for the extension, which needs no CORS. */
const CORS_GET = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'if-none-match',
  'access-control-expose-headers': 'etag',
};

/**
 * @param {any} data
 * @param {number} [status]
 * @param {Object} [headers]
 */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

const today = () => Math.floor(Date.now() / DAY);

/**
 * Salted hash of the caller's network. With `daily`, the hash changes every day
 * (used for rate limits); without, it is stable (stored with an install to cap how
 * many installs from one network can count on the same channel).
 * @param {Request} req
 * @param {Object} env
 * @param {boolean} daily
 */
async function netHash(req, env, daily) {
  const net = netOf(req.headers.get('cf-connecting-ip') || 'local');
  return (await A.sha256hex(`${net}|${daily ? today() : 'reg'}|${env.SALT || 'dev-salt'}`)).slice(0, 24);
}

/**
 * Adds `amount` to a daily counter; false once the limit is passed.
 * @param {Object} env
 * @param {string} bucket
 * @param {number} amount
 * @param {number} limit
 */
async function allow(env, bucket, amount, limit) {
  const row = await env.DB.prepare(
    `INSERT INTO limits (bucket, day, n) VALUES (?1, ?2, ?3)
     ON CONFLICT(bucket) DO UPDATE SET n = CASE WHEN day = ?2 THEN n + ?3 ELSE ?3 END, day = ?2
     RETURNING n`
  ).bind(bucket, today(), amount).first();
  return row.n <= limit;
}

/**
 * Looks up the install that owns `secret`.
 * @param {Object} env
 * @param {unknown} secret 64 hex characters
 * @returns {Promise<{id: string, created_at: number}|null>}
 */
async function userFromSecret(env, secret) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) return null;
  const id = (await A.sha256hex(secret)).slice(0, 32);
  return env.DB.prepare('SELECT id, created_at FROM users WHERE id = ?').bind(id).first();
}

/** Marks every channel this user voted on as needing a recount. */
const dirtyUserChannels = (env, id) => env.DB.prepare(
  'UPDATE channels SET dirty = 1, rev = rev + 1 WHERE key IN (SELECT channel_key FROM votes WHERE user_id = ?)'
).bind(id);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** `POST /register` */
async function register(req, env, body) {
  const c = cfg(env);
  const secret = body?.secret, nonce = String(body?.nonce ?? '');
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret) || nonce.length > 32) {
    return json({ error: 'bad request' }, 400);
  }
  const id = (await A.sha256hex(secret)).slice(0, 32);
  if (A.zeroBits(await A.sha256hex(`${id}:${nonce}`)) < c.powBits) return json({ error: 'proof of work too weak' }, 400);

  if (await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first()) return json({ id });
  if (!(await allow(env, 'reg:' + (await netHash(req, env, true)), 1, c.regPerNetDay))) {
    return json({ error: 'too many registrations from this network today' }, 429);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at, reg_net) VALUES (?, ?, ?)')
    .bind(id, Date.now(), await netHash(req, env, false)).run();
  return json({ id });
}

/** `POST /votes` (with `replace: true`, first deletes all of this install's votes) */
async function votes(req, env, body) {
  const c = cfg(env);
  const replace = body?.replace === true;
  if (!body || !Array.isArray(body.votes) || body.votes.length > A.LIMITS.MAX_BATCH || (!body.votes.length && !replace)) {
    return json({ error: 'bad request' }, 400);
  }
  const user = await userFromSecret(env, body.secret);
  if (!user) return json({ error: 'unknown user, register first' }, 401);

  const clean = [];
  for (const v of body.votes) {
    const k = A.normalizeKey(v?.k);
    if (!k || !A.FLAGS.includes(v?.f) || ![-1, 0, 1].includes(v?.v)) continue;
    clean.push({ k, f: v.f, v: v.v, name: A.cleanName(v.name) || null });
  }
  if (!clean.length && !replace) return json({ error: 'no valid votes' }, 400);

  const amount = Math.max(clean.length, 1);
  if (!(await allow(env, 'vote:' + user.id, amount, c.votesPerDay))) return json({ error: 'daily vote limit reached' }, 429);
  if (!(await allow(env, 'vote-net:' + (await netHash(req, env, true)), amount, c.votesPerNetDay))) {
    return json({ error: 'daily vote limit reached for this network' }, 429);
  }

  const now = Date.now();
  const stmts = [];
  if (replace) {
    stmts.push(dirtyUserChannels(env, user.id));
    stmts.push(env.DB.prepare('DELETE FROM votes WHERE user_id = ?').bind(user.id));
  }
  for (const v of clean) {
    stmts.push(v.v === 0
      ? env.DB.prepare('DELETE FROM votes WHERE user_id = ? AND channel_key = ? AND flag = ?').bind(user.id, v.k, v.f)
      : env.DB.prepare(
        `INSERT INTO votes (user_id, channel_key, flag, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, channel_key, flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(user.id, v.k, v.f, v.v, now));
    // The first name a channel was seen with is kept, so voters can't rename channels.
    stmts.push(env.DB.prepare(
      `INSERT INTO channels (key, name, dirty, rev, updated_at) VALUES (?, ?, 1, 1, ?)
       ON CONFLICT(key) DO UPDATE SET dirty = 1, rev = channels.rev + 1, name = COALESCE(channels.name, excluded.name)`
    ).bind(v.k, v.name, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, accepted: clean.length });
}

/** `POST /forget`: deletes the install and everything it voted. */
async function forget(_req, env, body) {
  const user = await userFromSecret(env, body?.secret);
  if (!user) return json({ ok: true, deleted: false });
  await env.DB.batch([
    dirtyUserChannels(env, user.id),
    env.DB.prepare('DELETE FROM votes WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true, deleted: true });
}

/** `GET /snapshot.json`: edge cache in front of R2, conditional requests → 304. */
async function snapshot(req, env, ctx) {
  const inm = req.headers.get('if-none-match');
  const cacheKey = new Request(CACHE_KEY);
  const cache = globalThis.caches?.default;
  let res = cache && (await cache.match(cacheKey));
  if (!res) {
    const obj = await env.BUCKET.get(SNAPSHOT);
    if (!obj) return json({ v: 1, generated: 0, c: {} }, 200, CORS_GET);
    res = new Response(obj.body, {
      headers: { 'content-type': 'application/json', etag: obj.httpEtag, 'cache-control': 'public, max-age=300', ...CORS_GET },
    });
    if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  if (inm && inm === res.headers.get('etag')) return new Response(null, { status: 304, headers: res.headers });
  return res;
}

// ---------------------------------------------------------------------------
// Recount
// ---------------------------------------------------------------------------

/**
 * Recounts channels marked dirty and patches the snapshot.
 *
 * Safe against crashes and concurrent votes:
 * - at most `MAX_PER_RUN` channels per run (stays under the free plan's 50 queries per
 *   invocation: 2 + 2 per 90-channel chunk);
 * - the snapshot is written to R2 **before** any `dirty` flag is cleared, with an ETag
 *   condition so two rebuilds can't overwrite each other;
 * - `dirty` is only cleared if `rev` is unchanged, so a vote that arrives during the
 *   recount keeps its channel dirty for the next run.
 *
 * @param {Object} env
 * @returns {Promise<{changed: number, total: number, conflict: boolean}>}
 */
async function rebuild(env) {
  const c = cfg(env);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM limits WHERE day < ?').bind(today()).run();
  const { results: dirty } = await env.DB.prepare('SELECT key, rev FROM channels WHERE dirty = 1 LIMIT ?').bind(c.maxPerRun).all();
  if (!dirty.length) return { changed: 0 };

  const obj = await env.BUCKET.get(SNAPSHOT);
  let snap = { v: 1, generated: 0, c: {} };
  if (obj) { try { snap = await obj.json(); } catch { /* corrupt: start fresh */ } }
  const before = JSON.stringify(snap.c);

  const updates = [];
  for (const part of chunks(dirty, 90)) {
    const keys = part.map(r => r.key);
    const ph = keys.map((_, i) => `?${i + 3}`).join(',');
    const [tallies, overrides, names] = await env.DB.batch([
      env.DB.prepare(
        `WITH ranked AS (
           SELECT v.channel_key AS k, v.flag AS f, v.value AS val,
                  CASE WHEN u.created_at > ?1 THEN 0.0 ELSE 1.0 END AS w,
                  ROW_NUMBER() OVER (PARTITION BY v.channel_key, v.flag, COALESCE(u.reg_net, u.id) ORDER BY u.created_at) AS rn
           FROM votes v JOIN users u ON u.id = v.user_id
           WHERE v.channel_key IN (${ph}))
         SELECT k, f, COUNT(*) AS n,
                SUM(CASE WHEN val > 0 AND rn <= ?2 THEN w ELSE 0 END) AS up,
                SUM(CASE WHEN val < 0 AND rn <= ?2 THEN w ELSE 0 END) AS down
         FROM ranked GROUP BY k, f`
      ).bind(now - c.warmupMs, c.maxPerNet, ...keys),
      env.DB.prepare(`SELECT key, ai, pe FROM overrides WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys),
      env.DB.prepare(`SELECT key, name FROM channels WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys),
    ]);
    const t = {};
    for (const r of tallies.results) (t[r.k] ||= {})[r.f] = r;
    const ov = Object.fromEntries(overrides.results.map(r => [r.key, r]));
    const nm = Object.fromEntries(names.results.map(r => [r.key, r.name]));

    for (const { key, rev } of part) {
      const s = score(t[key], ov[key], nm[key], c);
      if (s.entry) snap.c[key] = s.entry; else delete snap.c[key];
      updates.push({ key, rev, raw: s.raw, remove: s.total === 0 && !ov[key] });
    }
  }

  if (JSON.stringify(snap.c) !== before || !obj) {
    snap.generated = now;
    snap.min = { votes: c.minVotes, agree: c.minAgree };
    const put = await env.BUCKET.put(SNAPSHOT, JSON.stringify(snap), {
      httpMetadata: { contentType: 'application/json' },
      ...(obj ? { onlyIf: { etagMatches: obj.etag } } : {}),
    });
    if (!put) return { changed: 0, conflict: true }; // another rebuild won; dirty flags stay set
    await globalThis.caches?.default.delete(new Request(CACHE_KEY));
  }

  for (const part of chunks(updates, 90)) {
    await env.DB.batch(part.map(u => (u.remove
      ? env.DB.prepare('DELETE FROM channels WHERE key = ? AND rev = ?').bind(u.key, u.rev)
      : env.DB.prepare(
        'UPDATE channels SET ai_pct = ?, ai_n = ?, pe_pct = ?, pe_n = ?, dirty = 0, updated_at = ? WHERE key = ? AND rev = ?'
      ).bind(u.raw.ai.pct, u.raw.ai.n, u.raw.pe.pct, u.raw.pe.n, now, u.key, u.rev))));
  }
  return { changed: dirty.length, total: Object.keys(snap.c).length };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const POST_ROUTES = { '/register': register, '/votes': votes, '/forget': forget };

export default {
  /** @param {Request} req @param {Object} env @param {ExecutionContext} ctx */
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_GET });
      if (req.method === 'GET' && pathname === '/snapshot.json') return await snapshot(req, env, ctx);
      if (req.method === 'GET' && pathname === '/config') {
        const c = cfg(env);
        return json({ powBits: c.powBits, minVotes: c.minVotes, minAgree: c.minAgree, maxBatch: A.LIMITS.MAX_BATCH }, 200, CORS_GET);
      }
      if (req.method !== 'POST') return json({ error: 'not found' }, 404);
      if (!originAllowed(req)) return json({ error: 'forbidden origin' }, 403);

      if (pathname === '/admin/rebuild') {
        const auth = req.headers.get('authorization') || '';
        if (!env.ADMIN_TOKEN || !(await safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`))) return json({ error: 'forbidden' }, 403);
        await env.DB.prepare('UPDATE channels SET dirty = 1, rev = rev + 1').run();
        return json(await rebuild(env));
      }
      const handler = POST_ROUTES[pathname];
      if (!handler) return json({ error: 'not found' }, 404);
      const parsed = await readJson(req);
      if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
      return await handler(req, env, parsed.body);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },

  /** Cron trigger: recount changed channels. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(rebuild(env));
  },
};
