/**
 * @file Moderation dashboard of the sync server.
 *
 * `GET /admin` serves one self-contained page (no external resources). Everything it
 * does goes through the small API below, and every API call needs the admin token as
 * `Authorization: Bearer <ADMIN_TOKEN>`; the page itself contains no data.
 *
 * | Route                         | What it does |
 * |-------------------------------|--------------|
 * | `GET  /admin`                 | the dashboard page |
 * | `GET  /admin/api/channels`    | `?q=<search>&shown=1` → up to 100 entries with tallies and overrides |
 * | `POST /admin/api/override`    | `{key, ai, pe, note}` with ai/pe: 1 = always show, 0 = never show, null = let votes decide |
 * | `POST /admin/api/purge`       | `{key}` → delete every vote for that entry |
 * | `POST /admin/rebuild`         | recount everything |
 */
import { A, json, readJson, safeEqual } from './lib.js';

/**
 * Handles every `/admin` route.
 * @param {Request} req
 * @param {Object} env
 * @param {string} pathname
 * @param {function(Object): Promise<Object>} rebuild recount function from index.js
 * @returns {Promise<Response>}
 */
export async function admin(req, env, pathname, rebuild) {
  if (req.method === 'GET' && pathname === '/admin') return page();

  // Only this server's own page, or a non-browser client (curl), may call the API.
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: 'forbidden origin' }, 403);
  const auth = req.headers.get('authorization') || '';
  if (!env.ADMIN_TOKEN || !(await safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`))) return json({ error: 'forbidden' }, 403);

  if (req.method === 'GET' && pathname === '/admin/api/channels') return list(req, env);
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);

  if (pathname === '/admin/rebuild') {
    await env.DB.prepare('UPDATE channels SET dirty = 1, rev = rev + 1').run();
    return json(await rebuild(env));
  }
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const key = A.normalizeKey(parsed.body?.key);
  if (!key) return json({ error: 'invalid key' }, 400);

  if (pathname === '/admin/api/override') {
    const flag = v => (v === 1 || v === 0 ? v : null);
    const ai = flag(parsed.body.ai), pe = flag(parsed.body.pe);
    const note = A.cleanName(parsed.body.note) || null;
    await env.DB.batch([
      ai === null && pe === null
        ? env.DB.prepare('DELETE FROM overrides WHERE key = ?').bind(key)
        : env.DB.prepare('INSERT OR REPLACE INTO overrides (key, ai, pe, note) VALUES (?, ?, ?, ?)').bind(key, ai, pe, note),
      touch(env, key),
    ]);
    return json({ ok: true, ...(await rebuild(env)) });
  }
  if (pathname === '/admin/api/purge') {
    await env.DB.batch([env.DB.prepare('DELETE FROM votes WHERE channel_key = ?').bind(key), touch(env, key)]);
    return json({ ok: true, ...(await rebuild(env)) });
  }
  return json({ error: 'not found' }, 404);
}

/** Queues one entry for recounting (creating its row if an override is its only reason to exist). */
const touch = (env, key) => env.DB.prepare(
  `INSERT INTO channels (key, dirty, rev, updated_at) VALUES (?, 1, 1, ?)
   ON CONFLICT(key) DO UPDATE SET dirty = 1, rev = channels.rev + 1`
).bind(key, Date.now());

/** `GET /admin/api/channels` */
async function list(req, env) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const shownOnly = url.searchParams.get('shown') === '1' ? 1 : 0;
  const { results } = await env.DB.prepare(
    `SELECT c.key, c.name, c.ai_pct, c.ai_n, c.pe_pct, c.pe_n, c.entry, o.ai AS o_ai, o.pe AS o_pe, o.note
     FROM channels c LEFT JOIN overrides o ON o.key = c.key
     WHERE (?1 = '' OR c.key LIKE ?2 ESCAPE '\\' OR lower(c.name) LIKE ?2 ESCAPE '\\') AND (?3 = 0 OR c.entry IS NOT NULL)
     ORDER BY (c.ai_n + c.pe_n) DESC, c.key LIMIT 100`
  ).bind(q, like, shownOnly).all();
  return json({
    channels: results.map(r => {
      const e = r.entry ? JSON.parse(r.entry) : null;
      return {
        key: r.key, name: r.name || '', url: A.urlForKey(r.key), platform: A.labelForKey(r.key),
        ai: { pct: r.ai_pct, votes: r.ai_n, shown: !!(e && e[0]), override: r.o_ai },
        pe: { pct: r.pe_pct, votes: r.pe_n, shown: !!(e && e[2]), override: r.o_pe },
        note: r.note || '',
      };
    }),
  });
}

/** The dashboard page. Inline script and style are allowed only through a per-response nonce. */
function page() {
  const nonce = A.toHex(crypto.getRandomValues(new Uint8Array(16)));
  return new Response(PAGE.replaceAll('__NONCE__', nonce), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eyes of Argus: moderation</title>
<style nonce="__NONCE__">
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0d0d10;color:#e8e8ec;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:20px;margin:0 0 4px}.muted{color:#9b9ba6}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0}
input[type=text],input[type=password],input[type=search]{background:#0f0f13;color:inherit;border:1px solid #26262e;border-radius:8px;padding:8px 10px;font:inherit}
input[type=search]{flex:1;min-width:200px}
button{background:#24242c;color:inherit;border:1px solid #32323c;border-radius:7px;padding:5px 10px;font:inherit;font-size:12.5px;cursor:pointer}
button:hover{background:#2d2d37}button.bad{color:#fca5a5;border-color:#4b1f24;background:#2a1518}
table{width:100%;border-collapse:collapse}th{text-align:left;color:#9b9ba6;font-weight:500;font-size:12px;padding:6px 8px;border-bottom:1px solid #26262e}
td{padding:8px;border-bottom:1px solid #1e1e25;vertical-align:top}td a{color:inherit}
.k{color:#9b9ba6;font-size:12px}.tag{display:inline-block;font-weight:700;font-size:10px;color:#fff;padding:0 5px;border-radius:4px;margin-right:4px}
.ai{background:#7c3aed}.pe{background:#d97706}.off{background:#33333d;color:#9b9ba6}.act{display:flex;gap:4px;flex-wrap:wrap}
#status{min-height:1.5em}.err{color:#fca5a5}.ok{color:#86efac}
</style></head><body><main>
<h1>Eyes of Argus: moderation</h1>
<p class="muted">Community marks on this sync server. "Hide" stops a mark from showing for everyone, whatever the votes say. "Auto" lets the votes decide again.</p>
<div class="bar">
  <label for="token">Admin token</label><input id="token" type="password" autocomplete="off" size="30">
  <button id="load">Load</button><button id="recount">Recount everything</button>
</div>
<div class="bar">
  <input id="q" type="search" placeholder="Search by key or name…" aria-label="Search">
  <label><input id="shown" type="checkbox" checked> only marks currently shown</label>
</div>
<p id="status" class="muted" aria-live="polite"></p>
<table><thead><tr><th>Channel / account / site</th><th>AI</th><th>PE</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
</main>
<script nonce="__NONCE__">
'use strict';
const $ = id => document.getElementById(id);
const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props || {}); e.append(...kids); return e; };
const setStatus = (text, cls) => { $('status').textContent = text; $('status').className = cls || 'muted'; };
$('token').value = sessionStorage.getItem('argus-admin') || '';

async function api(path, body) {
  sessionStorage.setItem('argus-admin', $('token').value);
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + $('token').value, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 403 ? 'Wrong admin token' : data.error || 'HTTP ' + res.status);
  return data;
}

function flagCell(f, cls, label) {
  const state = f.override === 1 ? 'forced on' : f.override === 0 ? 'hidden by you' : f.shown ? 'shown' : 'not shown';
  return el('td', null, el('span', { className: 'tag ' + (f.shown ? cls : 'off') }, label), state, el('div', { className: 'k' }, f.pct + '% yes · ' + f.votes + ' votes'));
}

async function load() {
  try {
    setStatus('Loading…');
    const { channels } = await api('/admin/api/channels?q=' + encodeURIComponent($('q').value) + '&shown=' + ($('shown').checked ? 1 : 0));
    const rows = $('rows'); rows.textContent = '';
    for (const c of channels) {
      const link = el('a', { href: c.url, target: '_blank', rel: 'noreferrer noopener' }, c.name || c.key);
      const set = (ai, pe) => act('/admin/api/override', { key: c.key, ai, pe, note: 'dashboard' });
      const btn = (label, fn, cls) => { const b = el('button', { className: cls || '' }, label); b.addEventListener('click', fn); return b; };
      rows.append(el('tr', null,
        el('td', null, link, el('div', { className: 'k' }, c.platform + ' · ' + c.key)),
        flagCell(c.ai, 'ai', 'AI'), flagCell(c.pe, 'pe', 'PE'),
        el('td', null, el('div', { className: 'act' },
          btn('Hide AI', () => set(0, c.pe.override)), btn('Hide PE', () => set(c.ai.override, 0)), btn('Hide both', () => set(0, 0)),
          btn('Auto', () => set(null, null)),
          btn('Delete votes', () => { if (confirm('Delete every vote for ' + c.key + '?')) act('/admin/api/purge', { key: c.key }); }, 'bad')))));
    }
    setStatus(channels.length + (channels.length === 100 ? '+ entries (showing the first 100; search to narrow down)' : ' entries'), 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
}

async function act(path, body) {
  try { setStatus('Saving…'); await api(path, body); await load(); } catch (e) { setStatus(e.message, 'err'); }
}

$('load').addEventListener('click', load);
$('shown').addEventListener('change', load);
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
$('recount').addEventListener('click', () => act('/admin/rebuild', {}));
if ($('token').value) load();
</script></body></html>`;
