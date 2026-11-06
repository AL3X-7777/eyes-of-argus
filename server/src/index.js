// The Eyes of Argus — sync server (Cloudflare Worker + D1 + R2)
//
//   GET  /config          proof-of-work difficulty and thresholds
//   POST /register        { secret, nonce }            -> { id }
//   POST /votes           { secret, votes: [{k, f, v, name}] }
//   GET  /snapshot.json   community list (cached, supports ETag)
//   POST /admin/rebuild   Authorization: Bearer <ADMIN_TOKEN>  -> full snapshot rebuild
//   cron                  every 15 min: recount changed channels, patch snapshot

const SNAPSHOT = 'snapshot.json';
const DAY = 86400e3;
const NEW_USER_MS = 7 * DAY;     // new installs count as 1/4 vote for their first week
const NEW_USER_WEIGHT = 0.25;
const MAX_BATCH = 100;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, if-none-match',
  'access-control-expose-headers': 'etag',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });

const num = (v, d) => (Number.isFinite(+v) ? +v : d);

function cfg(env) {
  return {
    powBits: num(env.POW_BITS, 18),
    minVotes: num(env.MIN_VOTES, 5),
    minAgree: num(env.MIN_AGREE, 70),
    votesPerDay: num(env.VOTES_PER_DAY, 500),
    votesPerIpDay: num(env.VOTES_PER_IP_DAY, 3000),
    regPerIpDay: num(env.REG_PER_IP_DAY, 5),
  };
}

// ---------- small helpers ----------
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function zeroBits(hex) {
  let bits = 0;
  for (const ch of hex) {
    const v = parseInt(ch, 16);
    if (v === 0) { bits += 4; continue; }
    return bits + Math.clz32(v) - 28;
  }
  return bits;
}

const today = () => Math.floor(Date.now() / DAY);

async function ipHash(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  return (await sha256hex(`${ip}|${today()}|${env.SALT || 'dev-salt'}`)).slice(0, 24);
}

// Adds `amount` to a daily counter; returns false when the limit is passed.
async function allow(env, bucket, amount, limit) {
  const row = await env.DB.prepare(
    `INSERT INTO limits (bucket, day, n) VALUES (?1, ?2, ?3)
     ON CONFLICT(bucket) DO UPDATE SET n = CASE WHEN day = ?2 THEN n + ?3 ELSE ?3 END, day = ?2
     RETURNING n`
  ).bind(bucket, today(), amount).first();
  return row.n <= limit;
}

const validKey = k =>
  typeof k === 'string' && (/^@[^\s/?#]{1,100}$/.test(k) || /^UC[\w-]{22}$/.test(k));

const normKey = k => (typeof k === 'string' && k.startsWith('@') ? k.toLowerCase() : k);

async function body(req) {
  try { return await req.json(); } catch { return null; }
}

async function userFromSecret(env, secret) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) return null;
  const id = (await sha256hex(secret)).slice(0, 32);
  const u = await env.DB.prepare('SELECT id, created_at FROM users WHERE id = ?').bind(id).first();
  return u || null;
}

// ---------- handlers ----------
async function register(req, env) {
  const c = cfg(env);
  const b = await body(req);
  const secret = b?.secret, nonce = String(b?.nonce ?? '');
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret) || nonce.length > 32)
    return json({ error: 'bad request' }, 400);

  const id = (await sha256hex(secret)).slice(0, 32);
  if (zeroBits(await sha256hex(`${id}:${nonce}`)) < c.powBits)
    return json({ error: 'proof of work too weak' }, 400);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (existing) return json({ id });

  if (!(await allow(env, 'reg:' + (await ipHash(req, env)), 1, c.regPerIpDay)))
    return json({ error: 'too many registrations from this network today' }, 429);

  await env.DB.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').bind(id, Date.now()).run();
  return json({ id });
}

async function votes(req, env) {
  const c = cfg(env);
  const b = await body(req);
  if (!b || !Array.isArray(b.votes) || b.votes.length === 0 || b.votes.length > MAX_BATCH)
    return json({ error: 'bad request' }, 400);

  const user = await userFromSecret(env, b.secret);
  if (!user) return json({ error: 'unknown user, register first' }, 401);

  const clean = [];
  for (const v of b.votes) {
    const k = normKey(v?.k);
    if (!validKey(k) || !['ai', 'pe'].includes(v?.f) || ![-1, 0, 1].includes(v?.v)) continue;
    const name = typeof v.name === 'string' ? v.name.trim().slice(0, 100) || null : null;
    clean.push({ k, f: v.f, v: v.v, name });
  }
  if (!clean.length) return json({ error: 'no valid votes' }, 400);

  if (!(await allow(env, 'vote:' + user.id, clean.length, c.votesPerDay)))
    return json({ error: 'daily vote limit reached' }, 429);
  if (!(await allow(env, 'vote-ip:' + (await ipHash(req, env)), clean.length, c.votesPerIpDay)))
    return json({ error: 'daily vote limit reached for this network' }, 429);

  const now = Date.now();
  const stmts = [];
  for (const v of clean) {
    stmts.push(v.v === 0
      ? env.DB.prepare('DELETE FROM votes WHERE user_id = ? AND channel_key = ? AND flag = ?')
          .bind(user.id, v.k, v.f)
      : env.DB.prepare(
          `INSERT INTO votes (user_id, channel_key, flag, value, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, channel_key, flag) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).bind(user.id, v.k, v.f, v.v, now));
    stmts.push(env.DB.prepare(
      `INSERT INTO channels (key, name, dirty, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET dirty = 1, name = COALESCE(excluded.name, channels.name)`
    ).bind(v.k, v.name, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, accepted: clean.length });
}

async function snapshot(req, env) {
  const obj = await env.BUCKET.get(SNAPSHOT);
  if (!obj) return json({ v: 1, generated: 0, c: {} });
  const etag = obj.httpEtag;
  const headers = { ...CORS, etag, 'content-type': 'application/json', 'cache-control': 'public, max-age=600' };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { headers });
}

// ---------- recount + snapshot ----------
function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function rebuild(env, full) {
  const c = cfg(env);
  const now = Date.now();

  const { results: rows } = await env.DB.prepare(
    full ? 'SELECT key FROM channels' : 'SELECT key FROM channels WHERE dirty = 1 LIMIT 5000'
  ).all();
  const keys = rows.map(r => r.key);

  // Rate-limit counters from previous days are no longer needed.
  await env.DB.prepare('DELETE FROM limits WHERE day < ?').bind(today()).run();
  if (!keys.length && !full) return { changed: 0 };

  let snap = { v: 1, generated: 0, c: {} };
  if (!full) {
    const obj = await env.BUCKET.get(SNAPSHOT);
    if (obj) { try { snap = await obj.json(); } catch { /* start fresh */ } }
  }

  for (const part of chunks(keys, 90)) {
    const ph = part.map(() => '?').join(',');
    const [tallies, overrides, names] = await env.DB.batch([
      env.DB.prepare(
        `SELECT v.channel_key AS k, v.flag AS f, COUNT(*) AS n,
                SUM(CASE WHEN v.value > 0 THEN (CASE WHEN u.created_at > ? THEN ? ELSE 1.0 END) ELSE 0 END) AS up,
                SUM(CASE WHEN v.value < 0 THEN (CASE WHEN u.created_at > ? THEN ? ELSE 1.0 END) ELSE 0 END) AS down
         FROM votes v JOIN users u ON u.id = v.user_id
         WHERE v.channel_key IN (${ph}) GROUP BY v.channel_key, v.flag`
      ).bind(now - NEW_USER_MS, NEW_USER_WEIGHT, now - NEW_USER_MS, NEW_USER_WEIGHT, ...part),
      env.DB.prepare(`SELECT key, ai, pe FROM overrides WHERE key IN (${ph})`).bind(...part),
      env.DB.prepare(`SELECT key, name FROM channels WHERE key IN (${ph})`).bind(...part),
    ]);

    const t = {};
    for (const r of tallies.results) (t[r.k] ||= {})[r.f] = r;
    const ov = Object.fromEntries(overrides.results.map(r => [r.key, r]));
    const nm = Object.fromEntries(names.results.map(r => [r.key, r.name]));

    const stmts = [];
    for (const key of part) {
      const res = {};
      let total = 0;
      for (const f of ['ai', 'pe']) {
        const r = t[key]?.[f];
        const up = r?.up || 0, down = r?.down || 0, n = r?.n || 0;
        total += n;
        const pct = up + down > 0 ? Math.round((100 * up) / (up + down)) : 0;
        let shown = up + down >= c.minVotes && pct >= c.minAgree;
        const o = ov[key]?.[f];
        if (o === 1) shown = true;
        if (o === 0) shown = false;
        res[f] = { pct: shown ? Math.max(pct, 1) : 0, n, rawPct: pct };
      }

      if (res.ai.pct || res.pe.pct) {
        snap.c[key] = [res.ai.pct, res.ai.n, res.pe.pct, res.pe.n, nm[key] || ''];
      } else {
        delete snap.c[key];
      }

      if (total === 0 && !ov[key]) {
        stmts.push(env.DB.prepare('DELETE FROM channels WHERE key = ?').bind(key));
      } else {
        stmts.push(env.DB.prepare(
          'UPDATE channels SET ai_pct = ?, ai_n = ?, pe_pct = ?, pe_n = ?, dirty = 0, updated_at = ? WHERE key = ?'
        ).bind(res.ai.rawPct, res.ai.n, res.pe.rawPct, res.pe.n, now, key));
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  }

  snap.generated = now;
  snap.min = { votes: c.minVotes, agree: c.minAgree };
  await env.BUCKET.put(SNAPSHOT, JSON.stringify(snap), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=600' },
  });
  return { changed: keys.length, total: Object.keys(snap.c).length };
}

// ---------- entry points ----------
export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (req.method === 'GET' && pathname === '/snapshot.json') return await snapshot(req, env);
      if (req.method === 'GET' && pathname === '/config') {
        const c = cfg(env);
        return json({ powBits: c.powBits, minVotes: c.minVotes, minAgree: c.minAgree, maxBatch: MAX_BATCH });
      }
      if (req.method === 'POST' && pathname === '/register') return await register(req, env);
      if (req.method === 'POST' && pathname === '/votes') return await votes(req, env);
      if (req.method === 'POST' && pathname === '/admin/rebuild') {
        if (!env.ADMIN_TOKEN || req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`)
          return json({ error: 'forbidden' }, 403);
        return json(await rebuild(env, true));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(rebuild(env, false));
  },
};
