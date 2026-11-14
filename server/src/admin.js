/**
 * @file Moderation dashboard of the sync server.
 *
 * `GET /admin` serves one self-contained page (no external resources). Everything it
 * does goes through the small API below, and every API call needs the admin token as
 * `Authorization: Bearer <ADMIN_TOKEN>`; the page itself contains no data.
 *
 * | Route                              | What it does |
 * |------------------------------------|--------------|
 * | `GET  /admin`                      | the dashboard page |
 * | `GET  /admin/api/state`            | vote rules and categories |
 * | `POST /admin/api/rules`            | `{minVotes, notFactor, warmupDays, maxPerNet}` → save, recount everything |
 * | `POST /admin/api/category`         | `{id, label, title, color}` → add or change a category |
 * | `POST /admin/api/category/delete`  | `{id}` → remove an added category and its votes |
 * | `GET  /admin/api/channels`         | `?q=<search>&shown=1` → up to 90 entries with tallies and overrides |
 * | `POST /admin/api/override`         | `{key, set: {<category>: 1 | 0 | null}}`: always show, never show, let votes decide |
 * | `POST /admin/api/purge`            | `{key}` → delete every vote for that entry |
 * | `POST /admin/rebuild`              | recount everything |
 */
import { A, json, readJson, safeEqual, cleanRules } from './lib.js';
import { loadState } from './schema.js';

/** Everything gets recounted (after a rule or category change). */
const dirtyAll = env => env.DB.prepare('UPDATE channels SET dirty = 1, rev = rev + 1');
const markStale = env => env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('stale', 1)");

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
  if (req.method === 'GET' && pathname === '/admin/api/state') return state(env);
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);

  if (pathname === '/admin/rebuild') {
    await dirtyAll(env).run();
    return json(await rebuild(env));
  }
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.body || {};
  /** Applies the change, then recounts with fresh rules and categories. */
  const finish = async stmts => {
    await env.DB.batch(stmts);
    await loadState(env, true);
    return json({ ok: true, ...(await rebuild(env)) });
  };

  if (pathname === '/admin/api/rules') {
    const rules = cleanRules(body);
    return finish([
      ...Object.entries(rules).map(([k, v]) => env.DB.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind(k, String(v))),
      dirtyAll(env), markStale(env),
    ]);
  }
  if (pathname === '/admin/api/category') {
    const cat = A.cleanCategory(body);
    if (!cat) return json({ error: 'invalid category: the id needs 2 to 12 letters or digits starting with a letter, plus a badge text and a colour like #16a34a' }, 400);
    const { extra } = await loadState(env, true);
    if (!extra.some(c => c.id === cat.id) && extra.length >= A.MAX_EXTRA_CATEGORIES) return json({ error: 'too many categories' }, 400);
    return finish([
      env.DB.prepare(
        `INSERT INTO categories (id, label, title, color, pos) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET label = ?2, title = ?3, color = ?4`
      ).bind(cat.id, cat.label, cat.title, cat.color, Date.now()),
      markStale(env),
    ]);
  }
  if (pathname === '/admin/api/category/delete') {
    const id = String(body.id || '');
    const { extra } = await loadState(env, true);
    if (!extra.some(c => c.id === id)) return json({ error: 'unknown category (the built-in ones cannot be removed)' }, 400);
    return finish([
      env.DB.prepare('UPDATE channels SET dirty = 1, rev = rev + 1 WHERE key IN (SELECT channel_key FROM votes WHERE flag = ?1 UNION SELECT key FROM overrides WHERE flag = ?1)').bind(id),
      env.DB.prepare('DELETE FROM votes WHERE flag = ?').bind(id),
      env.DB.prepare('DELETE FROM overrides WHERE flag = ?').bind(id),
      env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
      markStale(env),
    ]);
  }

  const key = A.normalizeKey(body.key);
  if (!key) return json({ error: 'invalid key' }, 400);

  if (pathname === '/admin/api/override') {
    const { ids } = await loadState(env);
    const stmts = [];
    for (const [flag, v] of Object.entries(body.set && typeof body.set === 'object' ? body.set : {})) {
      if (!ids.includes(flag)) return json({ error: 'unknown category' }, 400);
      stmts.push(v === 1 || v === 0
        ? env.DB.prepare('INSERT OR REPLACE INTO overrides (key, flag, value, note) VALUES (?, ?, ?, ?)').bind(key, flag, v, A.cleanName(body.note) || null)
        : env.DB.prepare('DELETE FROM overrides WHERE key = ? AND flag = ?').bind(key, flag));
    }
    if (!stmts.length) return json({ error: 'nothing to change' }, 400);
    return finish([...stmts, touch(env, key)]);
  }
  if (pathname === '/admin/api/purge') {
    return finish([env.DB.prepare('DELETE FROM votes WHERE channel_key = ?').bind(key), touch(env, key)]);
  }
  return json({ error: 'not found' }, 404);
}

/** Queues one entry for recounting (creating its row if an override is its only reason to exist). */
const touch = (env, key) => env.DB.prepare(
  `INSERT INTO channels (key, dirty, rev, updated_at) VALUES (?, 1, 1, ?)
   ON CONFLICT(key) DO UPDATE SET dirty = 1, rev = channels.rev + 1`
).bind(key, Date.now());

/** `GET /admin/api/state` */
async function state(env) {
  const s = await loadState(env, true);
  return json({ rules: s.rules, categories: s.cats.map((c, i) => ({ ...c, builtin: i < A.DEFAULT_CATEGORIES.length })) });
}

/** `GET /admin/api/channels` */
async function list(req, env) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const shownOnly = url.searchParams.get('shown') === '1' ? 1 : 0;
  const { results } = await env.DB.prepare(
    `SELECT key, name, tally, votes FROM channels
     WHERE (?1 = '' OR key LIKE ?2 ESCAPE '\\' OR lower(name) LIKE ?2 ESCAPE '\\') AND (?3 = 0 OR shown = 1)
     ORDER BY votes DESC, key LIMIT 90`
  ).bind(q, like, shownOnly).all();
  const ov = {};
  if (results.length) {
    const { results: rows } = await env.DB.prepare(
      `SELECT key, flag, value FROM overrides WHERE key IN (${results.map(() => '?').join(',')})`
    ).bind(...results.map(r => r.key)).all();
    for (const r of rows) (ov[r.key] ||= {})[r.flag] = r.value;
  }
  return json({
    channels: results.map(r => {
      let tally = {};
      try { tally = JSON.parse(r.tally || '{}'); } catch { /* not counted yet */ }
      const flags = {};
      for (const id of new Set([...Object.keys(tally), ...Object.keys(ov[r.key] || {})])) {
        const t = tally[id] || [0, 0, 0];
        flags[id] = { yes: t[0], no: t[1], shown: !!t[2], override: ov[r.key]?.[id] ?? null };
      }
      return { key: r.key, name: r.name || '', url: A.urlForKey(r.key), platform: A.labelForKey(r.key), votes: r.votes, flags };
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
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}.muted{color:#9b9ba6}
section{background:#16161b;border:1px solid #26262e;border-radius:12px;padding:16px 18px;margin:14px 0}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
label.f{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#9b9ba6}
input[type=text],input[type=password],input[type=search],input[type=number]{background:#0f0f13;color:#e8e8ec;border:1px solid #26262e;border-radius:8px;padding:7px 9px;font:inherit}
input[type=number]{width:110px}input[type=search]{flex:1;min-width:200px}input[type=color]{width:44px;height:34px;padding:2px;background:#0f0f13;border:1px solid #26262e;border-radius:8px}
button{background:#24242c;color:inherit;border:1px solid #32323c;border-radius:7px;padding:5px 10px;font:inherit;font-size:12.5px;cursor:pointer}
button:hover{background:#2d2d37}button.bad{color:#fca5a5;border-color:#4b1f24;background:#2a1518}button.main{background:#4c1d95;border-color:#6d28d9}
table{width:100%;border-collapse:collapse}th{text-align:left;color:#9b9ba6;font-weight:500;font-size:12px;padding:6px 8px;border-bottom:1px solid #26262e}
td{padding:8px;border-bottom:1px solid #1e1e25;vertical-align:top}td a{color:inherit}
.k{color:#9b9ba6;font-size:12px}.tag{display:inline-block;font-weight:700;font-size:10px;color:#fff;padding:0 5px;border-radius:4px;margin-right:6px}
.off{background:#33333d !important;color:#9b9ba6}.line{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0}.act{display:flex;gap:4px;flex-wrap:wrap}
#status{min-height:1.5em}.err{color:#fca5a5}.ok{color:#86efac}
</style></head><body><main>
<h1>Eyes of Argus: moderation</h1>
<p class="muted">Community marks on this sync server.</p>
<div class="bar">
  <label for="token">Admin token</label><input id="token" type="password" autocomplete="off" size="30">
  <button id="load" class="main">Load</button><button id="recount">Recount everything</button>
</div>
<p id="status" class="muted" aria-live="polite"></p>

<section>
  <h2>Vote rules</h2>
  <p class="muted">A mark shows for everyone once it has enough "yes" votes, unless the "not" votes outnumber them by more than the factor. Example with 1 and 2: one vote marks, and a mark with 2 yes votes needs 5 "not" votes to go.</p>
  <div class="bar">
    <label class="f">Yes votes needed<input id="minVotes" type="number" min="1" max="1000" step="1"></label>
    <label class="f">"Not" votes needed per yes vote<input id="notFactor" type="number" min="0.5" max="100" step="0.5"></label>
    <label class="f">Days before a new install's votes count<input id="warmupDays" type="number" min="0" max="30" step="1"></label>
    <label class="f">Counted votes per network per mark<input id="maxPerNet" type="number" min="1" max="100" step="1"></label>
    <button id="saveRules">Save rules</button>
  </div>
</section>

<section>
  <h2>Categories</h2>
  <p class="muted">Extensions pick up new categories with their next list download and add them to the right-click menu.</p>
  <table><thead><tr><th>Badge</th><th>Id</th><th>Menu text ("Mark as …")</th><th></th></tr></thead><tbody id="cats"></tbody></table>
  <div class="bar">
    <label class="f">Id (letters/digits)<input id="catId" type="text" maxlength="12" size="12" placeholder="sponsored"></label>
    <label class="f">Badge text<input id="catLabel" type="text" maxlength="8" size="8" placeholder="AD"></label>
    <label class="f">Menu text<input id="catTitle" type="text" maxlength="40" size="24" placeholder="sponsored content"></label>
    <label class="f">Colour<input id="catColor" type="color" value="#16a34a"></label>
    <button id="addCat">Add category</button>
  </div>
</section>

<section>
  <h2>Marks</h2>
  <p class="muted">"Hide" stops a mark from showing for everyone, whatever the votes say. "Auto" lets the votes decide again.</p>
  <div class="bar">
    <input id="q" type="search" placeholder="Search by key or name…" aria-label="Search">
    <label><input id="shown" type="checkbox" checked> only marks currently shown</label>
  </div>
  <table><thead><tr><th>Channel / account / site</th><th>Categories</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
</section>
</main>
<script nonce="__NONCE__">
'use strict';
const $ = id => document.getElementById(id);
const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props || {}); e.append(...kids); return e; };
const btn = (label, fn, cls) => { const b = el('button', { className: cls || '' }, label); b.addEventListener('click', fn); return b; };
const setStatus = (text, cls) => { $('status').textContent = text; $('status').className = cls || 'muted'; };
const RULES = ['minVotes', 'notFactor', 'warmupDays', 'maxPerNet'];
let cats = [];
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

function tag(c, on) {
  const t = el('span', { className: 'tag' + (on ? '' : ' off') }, c ? c.label : '?');
  if (c && on) t.style.background = c.color;
  return t;
}

async function loadState() {
  const s = await api('/admin/api/state');
  cats = s.categories;
  for (const k of RULES) $(k).value = s.rules[k];
  const body = $('cats'); body.textContent = '';
  for (const c of cats) {
    body.append(el('tr', null, el('td', null, tag(c, true)), el('td', null, c.id), el('td', null, 'Mark as ' + c.title),
      el('td', null, c.builtin ? el('span', { className: 'k' }, 'built in') :
        btn('Remove', () => { if (confirm('Remove the category "' + c.label + '" and delete all its votes?')) act('/admin/api/category/delete', { id: c.id }); }, 'bad'))));
  }
}

async function loadMarks() {
  const { channels } = await api('/admin/api/channels?q=' + encodeURIComponent($('q').value) + '&shown=' + ($('shown').checked ? 1 : 0));
  const rows = $('rows'); rows.textContent = '';
  for (const ch of channels) {
    const set = change => act('/admin/api/override', { key: ch.key, set: change, note: 'dashboard' });
    const lines = el('td');
    for (const [id, f] of Object.entries(ch.flags)) {
      const c = cats.find(x => x.id === id);
      const how = f.override === 1 ? 'forced on' : f.override === 0 ? 'hidden by you' : f.shown ? 'shown' : 'not shown';
      lines.append(el('div', { className: 'line' }, tag(c, f.shown), how + ' · ' + f.yes + ' yes, ' + f.no + ' not',
        f.override === null ? btn('Hide', () => set({ [id]: 0 })) : btn('Auto', () => set({ [id]: null }))));
    }
    const all = v => Object.fromEntries(Object.keys(ch.flags).map(id => [id, v]));
    rows.append(el('tr', null,
      el('td', null, el('a', { href: ch.url, target: '_blank', rel: 'noreferrer noopener' }, ch.name || ch.key), el('div', { className: 'k' }, ch.platform + ' · ' + ch.key)),
      lines,
      el('td', null, el('div', { className: 'act' }, btn('Hide all', () => set(all(0))), btn('Auto all', () => set(all(null))),
        btn('Delete votes', () => { if (confirm('Delete every vote for ' + ch.key + '?')) act('/admin/api/purge', { key: ch.key }); }, 'bad')))));
  }
  return channels.length;
}

async function load() {
  try {
    setStatus('Loading…');
    await loadState();
    const n = await loadMarks();
    setStatus(n + (n === 90 ? '+ entries (showing the first 90; search to narrow down)' : ' entries'), 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
}

async function act(path, body) {
  try { setStatus('Saving…'); await api(path, body); await load(); } catch (e) { setStatus(e.message, 'err'); }
}

$('load').addEventListener('click', load);
$('shown').addEventListener('change', load);
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
$('recount').addEventListener('click', () => act('/admin/rebuild', {}));
$('saveRules').addEventListener('click', () => act('/admin/api/rules', Object.fromEntries(RULES.map(k => [k, Number($(k).value)]))));
$('addCat').addEventListener('click', () => act('/admin/api/category',
  { id: $('catId').value, label: $('catLabel').value, title: $('catTitle').value, color: $('catColor').value }));
if ($('token').value) load();
</script></body></html>`;
