// The Eyes of Argus — background (context menu, shared list, community sync)
const api = globalThis.browser ?? chrome;
const YT = ['*://*.youtube.com/*'];

// ---------- context menu ----------
async function buildMenus() {
  await api.contextMenus.removeAll();
  const add = o => api.contextMenus.create({ contexts: ['all'], ...o });
  add({ id: 'argus', title: 'The Eyes of Argus', documentUrlPatterns: YT });
  add({ id: 'ai', parentId: 'argus', title: 'Mark as AI channel' });
  add({ id: 'pe', parentId: 'argus', title: 'Mark as private-equity owned' });
  add({ id: 'sep1', parentId: 'argus', type: 'separator' });
  add({ id: 'notai', parentId: 'argus', title: 'Not AI (disagree)' });
  add({ id: 'notpe', parentId: 'argus', title: 'Not PE-owned (disagree)' });
  add({ id: 'clear', parentId: 'argus', title: 'Clear' });
  add({ id: 'sep2', parentId: 'argus', type: 'separator' });
  add({ id: 'settings', parentId: 'argus', title: 'Settings' });
  add({ id: 'help', parentId: 'argus', title: 'Help' });
}

api.contextMenus.onClicked.addListener((info, tab) => {
  const id = info.menuItemId;
  if (id === 'settings') return api.runtime.openOptionsPage();
  if (id === 'help') return api.tabs.create({ url: api.runtime.getURL('options.html#help') });
  if (['ai', 'pe', 'notai', 'notpe', 'clear'].includes(id) && tab?.id != null) {
    api.tabs.sendMessage(tab.id, { type: 'argus-menu', action: id }, { frameId: 0 })
      .catch(() => {}); // page opened before install: needs a reload
  }
});

api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

// ---------- shared list (any static JSON file, e.g. on GitHub) ----------
function normalize(data) {
  const src = data?.channels && typeof data.channels === 'object' ? data.channels : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    const key = k.startsWith('@') ? k.toLowerCase() : k;
    out[key] = { ai: v.ai === true || v.ai === 1, pe: v.pe === true || v.pe === 1, name: String(v.name || key).slice(0, 100) };
  }
  return out;
}

async function updateShared() {
  const { listUrl } = await api.storage.local.get('listUrl');
  if (!listUrl) return { ok: false, error: 'No list URL set' };
  try {
    const r = await fetch(listUrl, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const channels = normalize(await r.json());
    const count = Object.keys(channels).length;
    await api.storage.local.set({ sharedList: { channels, count, updated: Date.now() } });
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: String(e.message || e) }; // offline etc.: keep the old copy
  }
}

async function maybeUpdateShared() {
  const { sharedList } = await api.storage.local.get('sharedList');
  if (!sharedList || Date.now() - (sharedList.updated || 0) > 12 * 3600e3) updateShared();
}

// ---------- community sync ----------
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

function zeroBits(h) {
  let bits = 0;
  for (const ch of h) {
    const v = parseInt(ch, 16);
    if (v === 0) { bits += 4; continue; }
    return bits + Math.clz32(v) - 28;
  }
  return bits;
}

// One-time puzzle that makes creating thousands of fake installs slow.
async function solvePow(id, bits) {
  for (let base = 0; ; base += 2000) {
    const batch = [];
    for (let n = base; n < base + 2000; n++) batch.push(sha256hex(`${id}:${n}`).then(h => [n, h]));
    for (const [n, h] of await Promise.all(batch)) if (zeroBits(h) >= bits) return String(n);
  }
}

async function getSync() {
  const { sync = {} } = await api.storage.local.get('sync');
  return { enabled: false, server: '', ...sync };
}

async function call(server, path, body) {
  const r = await fetch(server + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'HTTP ' + r.status), { status: r.status });
  return data;
}

async function ensureIdentity(server) {
  let { identity } = await api.storage.local.get('identity');
  if (identity?.registeredAt === server) return identity;
  const secret = identity?.secret || hex(crypto.getRandomValues(new Uint8Array(32)));
  const id = (await sha256hex(secret)).slice(0, 32);
  const { powBits } = await (await fetch(server + '/config')).json();
  const nonce = await solvePow(id, powBits);
  await call(server, '/register', { secret, nonce });
  identity = { secret, id, registeredAt: server };
  await api.storage.local.set({ identity });
  return identity;
}

async function flushQueue(server) {
  const { queue = {} } = await api.storage.local.get('queue');
  const items = Object.entries(queue);
  if (!items.length) return 0;
  let identity = await ensureIdentity(server);
  let sent = 0;
  for (let i = 0; i < items.length; i += 100) {
    const part = items.slice(i, i + 100);
    const votes = part.map(([, v]) => ({ k: v.k, f: v.f, v: v.v, name: v.name }));
    try {
      await call(server, '/votes', { secret: identity.secret, votes });
    } catch (e) {
      if (e.status !== 401) throw e;
      // server forgot us (e.g. database reset): register again once
      await api.storage.local.set({ identity: { ...identity, registeredAt: null } });
      identity = await ensureIdentity(server);
      await call(server, '/votes', { secret: identity.secret, votes });
    }
    // remove what was sent, unless it changed again meanwhile
    const { queue: cur = {} } = await api.storage.local.get('queue');
    for (const [k, v] of part) if (cur[k]?.t === v.t) delete cur[k];
    await api.storage.local.set({ queue: cur });
    sent += part.length;
  }
  return sent;
}

async function fetchCommunity(server) {
  const { community } = await api.storage.local.get('community');
  const headers = community?.etag ? { 'if-none-match': community.etag } : {};
  const r = await fetch(server + '/snapshot.json', { headers, cache: 'no-cache' });
  if (r.status === 304) {
    await api.storage.local.set({ community: { ...community, checked: Date.now() } });
    return community.count;
  }
  if (!r.ok) throw new Error('snapshot HTTP ' + r.status);
  const data = await r.json();
  const c = data?.c && typeof data.c === 'object' ? data.c : {};
  const count = Object.keys(c).length;
  await api.storage.local.set({
    community: { c, count, etag: r.headers.get('etag'), generated: data.generated || 0, checked: Date.now() },
  });
  return count;
}

let syncing = null;
function syncNow() {
  if (syncing) return syncing;
  syncing = (async () => {
    const s = await getSync();
    if (!s.enabled || !s.server) return { ok: false, error: 'Sync is off' };
    try {
      const sent = await flushQueue(s.server);
      const count = await fetchCommunity(s.server);
      const status = { ok: true, sent, count, at: Date.now() };
      await api.storage.local.set({ syncStatus: status });
      return status;
    } catch (e) {
      // offline or server down: votes stay queued, the last community copy keeps working
      const status = { ok: false, error: String(e.message || e), at: Date.now() };
      await api.storage.local.set({ syncStatus: status });
      return status;
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

// Send new votes shortly after they're made, and sync every 30 minutes
let debounce;
api.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.queue) return;
  if (Object.keys(ch.queue.newValue || {}).length === 0) return;
  clearTimeout(debounce);
  debounce = setTimeout(syncNow, 5000);
});

api.alarms.onAlarm.addListener(a => {
  if (a.name === 'argus-sync') syncNow();
  if (a.name === 'argus-shared') maybeUpdateShared();
});

function setup() {
  buildMenus();
  api.alarms.create('argus-sync', { periodInMinutes: 30, delayInMinutes: 1 });
  api.alarms.create('argus-shared', { periodInMinutes: 360, delayInMinutes: 2 });
}
api.runtime.onInstalled.addListener(setup);
api.runtime.onStartup.addListener(setup);

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'argus-update-list') { updateShared().then(sendResponse); return true; }
  if (msg?.type === 'argus-sync-now') { syncNow().then(sendResponse); return true; }
});
