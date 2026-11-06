// The Eyes of Argus — settings page
const api = globalThis.browser ?? chrome;
const $ = s => document.querySelector(s);
const DEFAULTS = { badges: true, tint: true, dim: false };
const val = x => (x === true || x === 1 ? 1 : x === -1 ? -1 : 0);

let marks = {};
let syncCfg = { enabled: false, server: '' };

function status(el, text, kind) {
  el.textContent = text;
  el.className = 'muted ' + (kind || '');
}

// ---------- display settings ----------
async function loadSettings() {
  const { settings = {} } = await api.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  for (const box of document.querySelectorAll('[data-setting]')) {
    box.checked = !!s[box.dataset.setting];
    box.addEventListener('change', async () => {
      const { settings: cur = {} } = await api.storage.local.get('settings');
      await api.storage.local.set({ settings: { ...DEFAULTS, ...cur, [box.dataset.setting]: box.checked } });
    });
  }
}

// ---------- marks table ----------
function channelUrl(key) {
  return key.startsWith('@') ? `https://www.youtube.com/${key}` : `https://www.youtube.com/channel/${key}`;
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const tbody = $('#marks tbody');
  tbody.textContent = '';
  const all = Object.entries(marks).filter(([, v]) => val(v.ai) || val(v.pe));
  $('#count').textContent = all.length;
  $('#empty').hidden = all.length > 0;

  const rows = all
    .filter(([k, v]) => !q || k.toLowerCase().includes(q) || (v.name || '').toLowerCase().includes(q))
    .sort((a, b) => (b[1].t || 0) - (a[1].t || 0));

  for (const [key, v] of rows) {
    const tr = document.createElement('tr');

    const td = document.createElement('td');
    const a = document.createElement('a');
    a.href = channelUrl(key); a.target = '_blank'; a.rel = 'noreferrer';
    a.textContent = v.name || key;
    const k = document.createElement('span');
    k.className = 'k'; k.textContent = key;
    td.append(a, k);
    tr.append(td);

    for (const flag of ['ai', 'pe']) {
      const c = document.createElement('td');
      const sel = document.createElement('select');
      for (const [value, label] of [['0', '–'], ['1', 'Yes'], ['-1', 'Not']]) sel.add(new Option(label, value));
      const cur = val(v[flag]);
      sel.value = String(cur);
      sel.className = `${flag} ${cur > 0 ? 'yes' : cur < 0 ? 'no' : ''}`;
      sel.title = flag === 'ai' ? 'Uses AI' : 'Private-equity owned';
      sel.addEventListener('change', () => save(key, { [flag]: +sel.value }));
      c.append(sel); tr.append(c);
    }

    const del = document.createElement('td');
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '✕'; x.title = 'Remove mark';
    x.addEventListener('click', () => save(key, { ai: 0, pe: 0 }));
    del.append(x); tr.append(del);

    tbody.append(tr);
  }
}

// Updates one channel and, with sync on, queues the changed votes.
async function save(key, changes) {
  const { marks: cur = {}, queue = {} } = await api.storage.local.get(['marks', 'queue']);
  const old = cur[key] || {};
  const e = { ...old, ai: val(old.ai), pe: val(old.pe), t: Date.now() };
  const changed = [];
  for (const [f, v] of Object.entries(changes)) { if (e[f] !== v) changed.push(f); e[f] = v; }
  if (e.ai || e.pe) cur[key] = e; else delete cur[key];

  const out = { marks: cur };
  if (syncCfg.enabled && changed.length) {
    for (const f of changed) for (const k of [key, e.uc].filter(Boolean))
      queue[`${k}|${f}`] = { k, f, v: e[f], name: e.name || key, t: e.t };
    out.queue = queue;
  }
  await api.storage.local.set(out);
}

// ---------- community sync ----------
function fmtTime(t) { return t ? new Date(t).toLocaleString() : 'never'; }

async function renderSync() {
  const d = await api.storage.local.get(['sync', 'queue', 'syncStatus', 'community', 'identity']);
  syncCfg = { enabled: false, server: '', ...(d.sync || {}) };
  $('#syncEnabled').checked = syncCfg.enabled;
  if (document.activeElement !== $('#syncServer')) $('#syncServer').value = syncCfg.server;
  $('#syncPill').textContent = syncCfg.enabled ? 'On' : 'Off';
  $('#syncPill').classList.toggle('on', syncCfg.enabled);
  if (!syncCfg.enabled) return status($('#syncStatus'), 'Sync is off. Your marks stay on this computer.');

  const queued = Object.keys(d.queue || {}).length;
  const parts = [];
  parts.push(queued ? `${queued} vote${queued > 1 ? 's' : ''} waiting to be sent` : 'All votes sent');
  if (d.community) parts.push(`community list: ${d.community.count} channels`);
  parts.push(`last sync: ${fmtTime(d.syncStatus?.at)}`);
  if (d.identity?.id) parts.push(`your anonymous ID: ${d.identity.id.slice(0, 8)}…`);
  const s = d.syncStatus;
  if (s && !s.ok) parts.push(`last error: ${s.error} (will retry)`);
  status($('#syncStatus'), parts.join(' · '), s && !s.ok ? 'err' : 'ok');
}

function checkServer(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) return null;
  return u.origin;
}

async function runSync() {
  status($('#syncStatus'), 'Syncing… (the first time includes a one-time puzzle that takes a few seconds)');
  await api.runtime.sendMessage({ type: 'argus-sync-now' });
  renderSync();
}

$('#syncEnabled').addEventListener('change', async e => {
  const box = e.target;
  if (!box.checked) {
    await api.storage.local.set({ sync: { ...syncCfg, enabled: false }, queue: {} });
    return renderSync();
  }
  const server = $('#syncServer').value.trim().replace(/\/+$/, '');
  const origin = checkServer(server);
  if (!origin) {
    box.checked = false;
    return status($('#syncStatus'), 'Enter the sync server address first (must start with https://).', 'err');
  }
  // must be the first await so the browser still counts it as your click
  const granted = await api.permissions.request({ origins: [origin + '/*'] });
  if (!granted) { box.checked = false; return status($('#syncStatus'), 'Permission to reach that server was refused.', 'err'); }

  // Send everything you've marked so far as your first votes
  const { marks: cur = {}, queue = {} } = await api.storage.local.get(['marks', 'queue']);
  const t = Date.now();
  for (const [key, m] of Object.entries(cur)) {
    for (const f of ['ai', 'pe']) {
      const v = val(m[f]);
      if (!v) continue;
      for (const k of [key, m.uc].filter(Boolean)) queue[`${k}|${f}`] = { k, f, v, name: m.name || key, t };
    }
  }
  await api.storage.local.set({ sync: { enabled: true, server }, queue });
  syncCfg = { enabled: true, server };
  runSync();
});

$('#syncServer').addEventListener('change', async () => {
  const server = $('#syncServer').value.trim().replace(/\/+$/, '');
  if (!syncCfg.enabled) { await api.storage.local.set({ sync: { ...syncCfg, server } }); return; }
  const origin = checkServer(server);
  if (!origin) return status($('#syncStatus'), 'That isn\'t a valid server address.', 'err');
  const granted = await api.permissions.request({ origins: [origin + '/*'] });
  if (!granted) return status($('#syncStatus'), 'Permission to reach that server was refused.', 'err');
  await api.storage.local.set({ sync: { enabled: true, server }, community: null });
  syncCfg = { enabled: true, server };
  runSync();
});

$('#syncNow').addEventListener('click', () => {
  if (!syncCfg.enabled) return status($('#syncStatus'), 'Turn on community sync first.', 'err');
  runSync();
});

// ---------- shared list ----------
function showListInfo(sharedList, listUrl) {
  if (!listUrl) return status($('#listStatus'), 'No shared list.');
  if (!sharedList) return status($('#listStatus'), 'Not downloaded yet.');
  status($('#listStatus'), `${sharedList.count} channels · last updated ${fmtTime(sharedList.updated)}`, 'ok');
}

$('#saveList').addEventListener('click', async () => {
  const url = $('#listUrl').value.trim();
  if (!url) {
    await api.storage.local.remove(['listUrl', 'sharedList']);
    return status($('#listStatus'), 'Shared list removed.');
  }
  let origin;
  try { origin = new URL(url).origin; } catch { return status($('#listStatus'), 'That isn\'t a valid URL.', 'err'); }
  if (!url.startsWith('https://')) return status($('#listStatus'), 'The URL must start with https://', 'err');

  const granted = await api.permissions.request({ origins: [origin + '/*'] });
  if (!granted) return status($('#listStatus'), 'Permission to read that site was refused.', 'err');

  await api.storage.local.set({ listUrl: url });
  status($('#listStatus'), 'Downloading…');
  const res = await api.runtime.sendMessage({ type: 'argus-update-list' });
  if (res?.ok) status($('#listStatus'), `Loaded ${res.count} channels.`, 'ok');
  else status($('#listStatus'), `Couldn't download: ${res?.error || 'unknown error'} (the last copy is still used)`, 'err');
});

// ---------- export / import ----------
$('#export').addEventListener('click', () => {
  const channels = {};
  for (const [k, v] of Object.entries(marks)) {
    const ai = val(v.ai), pe = val(v.pe);
    if (ai > 0 || pe > 0) channels[k] = { ai: ai > 0, pe: pe > 0, name: v.name || k };
  }
  const data = { app: 'eyes-of-argus', version: 1, exported: new Date().toISOString(), channels };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `argus-marks-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status($('#ioStatus'), `Exported ${Object.keys(channels).length} channels.`, 'ok');
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const src = data?.channels;
    if (!src || typeof src !== 'object') throw new Error('not an Eyes of Argus file');
    let n = 0;
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== 'object') continue;
      const key = k.startsWith('@') ? k.toLowerCase() : k;
      const old = marks[key] || {};
      const changes = {};
      // imported "yes" fills in where you have no opinion; your own choices are kept
      for (const f of ['ai', 'pe']) if (val(v[f]) > 0 && !val(old[f])) changes[f] = 1;
      if (!Object.keys(changes).length) continue;
      if (!old.name) {
        const { marks: cur = {} } = await api.storage.local.get('marks');
        cur[key] = { ...(cur[key] || {}), name: String(v.name || key).slice(0, 100) };
        await api.storage.local.set({ marks: cur });
      }
      await save(key, changes);
      n++;
    }
    status($('#ioStatus'), `Imported ${n} channels.`, 'ok');
  } catch (err) {
    status($('#ioStatus'), `Import failed: ${err.message}`, 'err');
  }
});

$('#wipe').addEventListener('click', async () => {
  if (!confirm('Delete all of your marks? This can\'t be undone (export first if you want a backup).')) return;
  for (const key of Object.keys(marks)) await save(key, { ai: 0, pe: 0 });
  status($('#ioStatus'), 'All marks deleted.');
});

// ---------- init ----------
$('#search').addEventListener('input', render);

api.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.marks) { marks = ch.marks.newValue || {}; render(); }
  if (ch.sharedList || ch.listUrl) api.storage.local.get(['sharedList', 'listUrl']).then(d => showListInfo(d.sharedList, d.listUrl));
  if (ch.sync || ch.queue || ch.syncStatus || ch.community || ch.identity) renderSync();
});

(async () => {
  await loadSettings();
  const d = await api.storage.local.get(['marks', 'sharedList', 'listUrl']);
  marks = d.marks || {};
  $('#listUrl').value = d.listUrl || '';
  showListInfo(d.sharedList, d.listUrl);
  await renderSync();
  render();
  if (location.hash === '#help') $('#help').scrollIntoView();
})();
