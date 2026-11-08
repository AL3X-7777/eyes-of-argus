/**
 * @file Background script of The Eyes of Argus.
 *
 * Runs as an event page in Firefox and as a service worker in Chromium; either can be
 * stopped at any time and restarted by an event, so every listener is registered
 * synchronously at the top level and all state lives in `storage.local`.
 *
 * Responsibilities:
 * 1. The right-click menu on YouTube.
 * 2. The **only writer** of your marks, the vote queue and sync settings. The content
 *    script and the settings page send messages (see `Argus.MSG`); every change runs
 *    through one promise chain ({@link serial}), so two tabs can never overwrite each
 *    other's change.
 * 3. Community sync: anonymous registration (proof of work), sending queued votes,
 *    downloading the community list. Upload and download fail independently, so the
 *    last community list always keeps working offline.
 * 4. The optional subscribed shared list (any static JSON file).
 *
 * Storage keys (all in `storage.local`):
 * | key            | written by  | content |
 * |----------------|-------------|---------|
 * | marks          | background  | `{ [key]: {ai, pe, name, uc?, t} }` with ai/pe ∈ {1, -1, 0} |
 * | queue          | background  | `{ ["key|flag"]: {k, f, v, name, t} }` votes not yet sent |
 * | syncReplace    | background  | true → next upload replaces all your votes on the server |
 * | sync           | background  | `{enabled, server}` |
 * | identity       | background  | `{secret, id, registeredAt}` anonymous install identity |
 * | powProgress    | background  | `{id, bits, next}` so a stopped worker resumes the puzzle |
 * | pendingForget  | background  | `{server, secret}` "delete my votes" still to be sent |
 * | community      | background  | `{c: {[key]: entry}}` only rewritten when the list changed |
 * | communityMeta  | background  | `{count, etag, generated, checked}` |
 * | syncStatus     | background  | result of the last sync |
 * | sharedList     | background  | `{channels, count, updated}` |
 * | listUrl        | options     | subscribed shared-list URL |
 * | settings       | options     | `{badges, tint, dim}` display toggles |
 */
'use strict';

/* global importScripts */
if (typeof importScripts === 'function' && !globalThis.Argus) importScripts('shared.js'); // Chromium service worker

const api = globalThis.browser ?? globalThis.chrome;
const A = globalThis.Argus;
const { FLAGS, MSG, LIMITS } = A;

const YT = ['*://*.youtube.com/*'];
const SYNC_ALARM = 'argus-sync';        // periodic: download the community list, retry votes
const FLUSH_ALARM = 'argus-flush';      // one-shot backup for sending fresh votes
const SHARED_ALARM = 'argus-shared';    // periodic: refresh the subscribed shared list
const SYNC_PERIOD_MIN = 6 * 60;
const SHARED_PERIOD_MIN = 12 * 60;
const FLUSH_DELAY_MS = 5000;
const RETRY_MIN = 5;                    // retry interval while votes or deletions are waiting

// ---------------------------------------------------------------------------
// Serialized writes
// ---------------------------------------------------------------------------

let chain = Promise.resolve();

/**
 * Runs `fn` after every previously scheduled write has finished. All changes to
 * `marks`, `queue`, `sync` and related keys go through here, which removes
 * read-modify-write races between tabs, the settings page and the sync code.
 * @template T
 * @param {function(): Promise<T>} fn
 * @returns {Promise<T>}
 */
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/** @param {string|string[]} keys @returns {Promise<Object>} */
const get = keys => api.storage.local.get(keys);
/** @param {Object} obj @returns {Promise<void>} */
const set = obj => api.storage.local.set(obj);

/**
 * Normalizes one stored mark to the current format (tri-state numbers).
 * @param {Object|undefined} m
 * @returns {{ai: number, pe: number, name: string, uc: string, t: number}}
 */
function readMark(m) {
  return { ...(m || {}), ai: A.val(m?.ai), pe: A.val(m?.pe) };
}

/**
 * Adds the votes for the given flags of one mark to `queue` (mutates it).
 * A mark saved with a `UC…` id votes for both the handle and the id, because
 * YouTube shows either form depending on the page.
 * @param {Object} queue
 * @param {string} key
 * @param {Object} mark
 * @param {Iterable<string>} flags
 * @param {number} t timestamp shared by these votes
 */
function queueVotes(queue, key, mark, flags, t) {
  for (const f of flags) {
    for (const k of [key, mark.uc].filter(Boolean)) {
      queue[A.queueKey(k, f)] = { k, f, v: mark[f], name: mark.name || key, t };
    }
  }
}

// ---------------------------------------------------------------------------
// Changing marks (message handlers)
// ---------------------------------------------------------------------------

/**
 * Applies a change to one channel and queues the resulting votes when sync is on.
 * @param {{key: string, name: string, uc: string, changes: Object<string, number>}} msg
 * @returns {Promise<{ok: boolean, error: string, mark: Object}>}
 */
function applyMark(msg) {
  return serial(async () => {
    const key = A.normalizeKey(msg.key);
    if (!key) return { ok: false, error: 'invalid channel' };
    const changes = {};
    for (const f of FLAGS) {
      if (msg.changes && f in msg.changes) {
        const v = msg.changes[f];
        if (![1, 0, -1].includes(v)) return { ok: false, error: 'invalid value' };
        changes[f] = v;
      }
    }
    const { marks = {}, queue = {}, sync } = await get(['marks', 'queue', 'sync']);
    const m = readMark(marks[key]);
    const name = A.cleanName(msg.name);
    if (name) m.name = name;
    if (A.isChannelId(msg.uc)) m.uc = msg.uc;
    delete m.src; // you changed it yourself, so it is now your own opinion (sent as votes)
    const changed = Object.keys(changes).filter(f => m[f] !== changes[f]);
    Object.assign(m, changes);
    m.t = Date.now();

    if (m.ai || m.pe) marks[key] = m; else delete marks[key];
    const out = { marks };
    if (sync?.enabled && changed.length) {
      queueVotes(queue, key, m, changed, m.t);
      out.queue = queue;
    }
    await set(out);
    if (out.queue) scheduleFlush();
    return { ok: true, mark: m };
  });
}

/**
 * Merges an exported or shared file into your marks in one write.
 *
 * - `data.mine` (your own backup, written by "Export") restores exact values,
 *   including "Not" choices and UC ids, and counts as your votes when sync is on.
 * - `data.channels` (a shared list or a v0.1/v0.2 export) only fills in "yes" where you
 *   have no opinion, and is **not** sent as your votes: importing someone else's list
 *   must not turn their opinions into yours.
 *
 * @param {{data: Object}} msg
 * @returns {Promise<{ok: boolean, error: string, count: number}>}
 */
function importData(msg) {
  return serial(async () => {
    const data = msg.data;
    if (!data || typeof data !== 'object') return { ok: false, error: 'not an Eyes of Argus file' };
    const mine = data.mine && typeof data.mine === 'object' ? data.mine : null;
    const channels = data.channels && typeof data.channels === 'object' ? data.channels : null;
    if (!mine && !channels) return { ok: false, error: 'not an Eyes of Argus file' };

    const { marks = {}, queue = {}, sync } = await get(['marks', 'queue', 'sync']);
    const t = Date.now();
    let count = 0, voted = false;

    if (mine) {
      for (const [k, v] of Object.entries(mine)) {
        const key = A.normalizeKey(k);
        if (!key || !v || typeof v !== 'object') continue;
        const m = readMark(marks[key]);
        const next = { ai: A.val(v.ai), pe: A.val(v.pe) };
        const changed = FLAGS.filter(f => next[f] !== m[f]);
        if (!changed.length) continue;
        Object.assign(m, next, { t });
        const name = A.cleanName(v.name);
        if (name) m.name = name;
        if (A.isChannelId(v.uc)) m.uc = v.uc;
        if (v.src === 'import') m.src = 'import'; else delete m.src;
        if (m.ai || m.pe) marks[key] = m; else delete marks[key];
        if (sync?.enabled && !m.src) { queueVotes(queue, key, m, changed, t); voted = true; }
        count++;
      }
    } else {
      for (const [k, v] of Object.entries(channels)) {
        const key = A.normalizeKey(k);
        if (!key || !v || typeof v !== 'object') continue;
        const m = readMark(marks[key]);
        let changed = false;
        for (const f of FLAGS) {
          if (A.val(v[f]) > 0 && !m[f]) { m[f] = 1; changed = true; }
        }
        if (!changed) continue;
        m.name = m.name || A.cleanName(v.name) || key;
        m.t = t;
        m.src = 'import';
        marks[key] = m;
        count++;
      }
    }
    await set(voted ? { marks, queue } : { marks });
    if (voted) scheduleFlush();
    return { ok: true, count };
  });
}

/**
 * Deletes all of your marks in one write; with sync on, withdraws your votes too.
 * @returns {Promise<{ok: boolean}>}
 */
function wipe() {
  return serial(async () => {
    const { marks = {}, queue = {}, sync } = await get(['marks', 'queue', 'sync']);
    const t = Date.now();
    if (sync?.enabled) {
      for (const [key, raw] of Object.entries(marks)) {
        const m = readMark(raw);
        const flags = FLAGS.filter(f => m[f]);
        for (const f of flags) m[f] = 0;
        queueVotes(queue, key, m, flags, t);
      }
      await set({ marks: {}, queue });
      scheduleFlush();
    } else {
      await set({ marks: {} });
    }
    return { ok: true };
  });
}

/**
 * Turns community sync on or off, or moves it to another server.
 *
 * Turning it on (or changing server) queues **all** current marks and flags the next
 * upload as a full replacement, so the server ends up with exactly your current
 * opinions — including withdrawing anything you cleared while sync was off.
 * Turning it off can also ask the server to delete everything it has from you.
 *
 * @param {{enabled: boolean, server: string, withdraw: boolean}} msg
 * @returns {Promise<{ok: boolean, error: string}>}
 */
function configureSync(msg) {
  return serial(async () => {
    const { sync = {}, marks = {}, identity, pendingForget = [] } = await get(['sync', 'marks', 'identity', 'pendingForget']);
    const gen = (sync.gen || 0) + 1; // running uploads compare this and stop when it changes
    const forgets = Array.isArray(pendingForget) ? pendingForget : [pendingForget];
    /** Queues "delete my votes" for the server this identity was used with (even mid-registration). */
    const forgetCurrent = () => {
      const where = identity?.registeredAt || sync.server;
      if (identity?.secret && where) forgets.push({ server: where, secret: identity.secret });
    };
    if (!msg.enabled) {
      if (msg.withdraw) forgetCurrent();
      await set({ sync: { enabled: false, server: sync.server || '', gen }, queue: {}, syncReplace: 0, pendingForget: forgets });
      if (msg.withdraw) await api.storage.local.remove('identity'); // a fresh anonymous ID next time
      await api.storage.local.remove(['community', 'communityMeta', 'syncStatus']);
      if (forgets.length) syncNow();
      return { ok: true };
    }
    const server = A.serverBase(msg.server);
    if (!server) return { ok: false, error: 'invalid server address' };
    if (sync.server && sync.server !== server) {
      // Moving servers: delete your votes from the old one and use a new identity, so
      // the two servers can't link you.
      forgetCurrent();
      await api.storage.local.remove(['identity', 'powProgress']);
    }

    const queue = {};
    const t = Date.now();
    for (const [key, raw] of Object.entries(marks)) {
      const m = readMark(raw);
      if (m.src === 'import') continue; // other people's lists are not your votes
      queueVotes(queue, key, m, FLAGS.filter(f => m[f]), t);
    }
    const out = { sync: { enabled: true, server, gen }, queue, syncReplace: gen, pendingForget: forgets };
    await set(out);
    if (sync.server !== server) await api.storage.local.remove(['community', 'communityMeta', 'syncStatus']);
    syncNow();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Community sync
// ---------------------------------------------------------------------------

/** Error from the sync server, carrying the HTTP status. */
class HttpError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * POSTs JSON to the sync server.
 * @param {string} server base address
 * @param {string} path e.g. `/votes`
 * @param {Object} body
 * @returns {Promise<Object>} parsed response
 * @throws {HttpError|TypeError} HttpError for non-2xx, TypeError when offline
 */
async function post(server, path, body) {
  const r = await fetch(server + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(data.error || 'HTTP ' + r.status, r.status);
  return data;
}

/**
 * Solves the one-time registration puzzle: finds a nonce so that
 * `sha256(id + ':' + nonce)` starts with `bits` zero bits.
 *
 * Progress is saved every ~50,000 attempts so a stopped service worker resumes instead
 * of restarting, and a cheap extension API call keeps Chromium's worker alive.
 *
 * @param {string} id
 * @param {number} bits already capped at `LIMITS.POW_MAX_BITS`
 * @param {number} start nonce to start from
 * @returns {Promise<string>} the nonce
 */
async function solvePow(id, bits, start) {
  const BATCH = 2000;
  for (let base = start, round = 0; ; base += BATCH, round++) {
    const hashes = [];
    for (let n = base; n < base + BATCH; n++) hashes.push(A.sha256hex(`${id}:${n}`));
    const results = await Promise.all(hashes);
    const hit = results.findIndex(h => A.zeroBits(h) >= bits);
    if (hit >= 0) return String(base + hit);
    if (round % 25 === 24) {
      await set({ powProgress: { id, bits, next: base + BATCH } });
      await api.runtime.getPlatformInfo?.(); // counts as activity for Chromium's idle timer
    }
  }
}

/**
 * Makes sure this install is registered with `server`, registering if needed.
 * @param {string} server
 * @returns {Promise<{secret: string, id: string, registeredAt: string}>}
 */
async function ensureIdentity(server) {
  const { identity, powProgress } = await get(['identity', 'powProgress']);
  if (identity?.registeredAt === server) return identity;
  const secret = identity?.secret || A.toHex(crypto.getRandomValues(new Uint8Array(32)));
  const id = (await A.sha256hex(secret)).slice(0, 32);
  await set({ identity: { secret, id, registeredAt: null } }); // keep the secret even if we stop now

  const cfgRes = await fetch(server + '/config');
  if (!cfgRes.ok) throw new HttpError('config HTTP ' + cfgRes.status, cfgRes.status);
  const cfg = await cfgRes.json();
  const bits = Math.min(Math.max(Number(cfg.powBits) | 0, 0), LIMITS.POW_MAX_BITS);
  const start = powProgress?.id === id && powProgress.bits === bits ? powProgress.next : 0;
  const nonce = await solvePow(id, bits, start);
  await post(server, '/register', { secret, nonce });

  const done = { secret, id, registeredAt: server };
  await set({ identity: done });
  await api.storage.local.remove('powProgress');
  return done;
}

/**
 * Removes sent votes from the queue, unless the vote changed again meanwhile.
 * @param {Array<Array>} sent queue entries that were sent (or dropped)
 */
function unqueue(sent) {
  return serial(async () => {
    const { queue = {} } = await get('queue');
    for (const [k, v] of sent) if (queue[k]?.t === v.t) delete queue[k];
    await set({ queue });
  });
}

/**
 * Sends queued votes in batches.
 * - 400 (a batch the server rejects): that batch is dropped so it can't block forever.
 * - 401 (server forgot this install): registers again once.
 * - 429 (daily limit) / network errors: stop; votes stay queued for later.
 * @param {string} server
 * @returns {Promise<number>} number of votes accepted
 */
async function flushQueue(server) {
  const { queue = {}, syncReplace, sync } = await get(['queue', 'syncReplace', 'sync']);
  const items = Object.entries(queue);
  if (!items.length && !syncReplace) return 0;
  const gen = sync?.gen || 0;
  /** Stops the upload if sync was turned off or moved since it started. */
  const stillWanted = async () => {
    const { sync: now } = await get('sync');
    if (!now?.enabled || (now.gen || 0) !== gen || now.server !== server) throw new Error('sync settings changed');
  };

  let identity = await ensureIdentity(server);
  let replace = !!syncReplace;
  let sent = 0;
  for (let i = 0; i < items.length || replace; i += LIMITS.MAX_BATCH) {
    await stillWanted();
    const part = items.slice(i, i + LIMITS.MAX_BATCH);
    const body = () => ({ secret: identity.secret, replace, votes: part.map(([, v]) => ({ k: v.k, f: v.f, v: v.v, name: v.name })) });
    try {
      try {
        await post(server, '/votes', body());
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 401) throw e;
        await set({ identity: { ...identity, registeredAt: null } });
        identity = await ensureIdentity(server);
        await post(server, '/votes', body());
      }
      sent += part.length;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400) throw e;
      console.warn('[Argus] server rejected a vote batch; dropping it:', e.message);
    }
    if (replace) {
      replace = false;
      await serial(async () => { // only clear the flag this upload was started for
        const { syncReplace: cur } = await get('syncReplace');
        if (cur === syncReplace) await set({ syncReplace: 0 });
      });
    }
    await unqueue(part);
  }
  return sent;
}

/**
 * Downloads the community list if it changed (ETag). Only rewrites the large
 * `community` key when the list really changed, so open YouTube tabs don't reload it
 * after every sync.
 * @param {string} server
 * @returns {Promise<number>} number of channels in the list
 */
async function fetchCommunity(server) {
  const { communityMeta: meta } = await get('communityMeta');
  const headers = meta?.etag ? { 'if-none-match': meta.etag } : {};
  const r = await fetch(server + '/snapshot.json', { headers, cache: 'no-store' });
  if (r.status === 304 && meta) {
    await set({ communityMeta: { ...meta, checked: Date.now() } });
    return meta.count;
  }
  if (!r.ok) throw new HttpError('community list HTTP ' + r.status, r.status);
  const data = await r.json();
  const c = {};
  for (const [k, e] of Object.entries(data?.c && typeof data.c === 'object' ? data.c : {})) {
    if (A.normalizeKey(k) === k && A.isCommunityEntry(e)) c[k] = e;
  }
  const count = Object.keys(c).length;
  await set({
    community: { c },
    communityMeta: { count, etag: r.headers.get('etag'), generated: Number(data?.generated) || 0, checked: Date.now() },
  });
  return count;
}

/**
 * Sends a pending "delete everything I voted" request, if any.
 * Kept until the server confirms, so it also works after coming back online.
 */
async function sendPendingForget() {
  const { pendingForget } = await get('pendingForget');
  const list = Array.isArray(pendingForget) ? pendingForget : pendingForget ? [pendingForget] : [];
  for (const p of list) {
    try {
      await post(p.server, '/forget', { secret: p.secret });
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500 || e.status === 429) continue; // retry later
    }
    await serial(async () => {
      const { pendingForget: cur = [] } = await get('pendingForget');
      await set({ pendingForget: (Array.isArray(cur) ? cur : [cur]).filter(x => x.secret !== p.secret || x.server !== p.server) });
    });
  }
}

/**
 * One sync round: pending forget, then upload, then download. Upload and download fail
 * independently, so a rejected vote can never stop the community list from updating.
 * @returns {Promise<Object>} status, also saved as `syncStatus`
 */
async function syncOnce() {
  await sendPendingForget();
  const { sync } = await get('sync');
  if (!sync?.enabled || !sync.server) {
    const { pendingForget = [] } = await get('pendingForget');
    if (Array.isArray(pendingForget) && pendingForget.length) api.alarms.create(FLUSH_ALARM, { delayInMinutes: RETRY_MIN });
    return { ok: false, error: 'Sync is off' };
  }
  const status = { at: Date.now(), sent: 0, count: 0 };
  try { status.sent = await flushQueue(sync.server); } catch (e) { status.uploadError = String(e.message || e); }
  try { status.count = await fetchCommunity(sync.server); } catch (e) { status.downloadError = String(e.message || e); }
  status.ok = !status.uploadError && !status.downloadError;
  if (!status.ok) status.error = status.uploadError || status.downloadError;
  await set({ syncStatus: status });
  const { queue = {}, pendingForget = [] } = await get(['queue', 'pendingForget']);
  if (Object.keys(queue).length || (Array.isArray(pendingForget) && pendingForget.length)) {
    api.alarms.create(FLUSH_ALARM, { delayInMinutes: RETRY_MIN }); // retry soon: online windows can be short
  }
  return status;
}

let running = null;
let rerun = false;

/**
 * Starts a sync, or joins the one in progress. A vote made during a sync triggers one
 * more round afterwards, so it isn't left waiting for the next alarm.
 * @returns {Promise<Object>} status of the last round
 */
function syncNow() {
  if (running) { rerun = true; return running; }
  running = (async () => {
    let status;
    do { rerun = false; status = await syncOnce(); } while (rerun);
    return status;
  })().finally(() => { running = null; });
  return running;
}

let flushTimer = null;

/**
 * Sends fresh votes a few seconds after they were made. The timer can be lost if the
 * worker is stopped, so a one-shot alarm is set as a backup.
 */
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(syncNow, FLUSH_DELAY_MS);
  flushTimer?.unref?.(); // Node (tests): don't keep the process alive
  api.alarms.create(FLUSH_ALARM, { delayInMinutes: 1 });
}

// ---------------------------------------------------------------------------
// Shared list (any static JSON file, e.g. on GitHub)
// ---------------------------------------------------------------------------

/**
 * Turns a downloaded shared list into `{key: {ai, pe, name}}`, dropping invalid entries.
 * @param {Object} data
 * @returns {Object<string, {ai: boolean, pe: boolean, name: string}>}
 */
function normalizeShared(data) {
  const src = data?.channels && typeof data.channels === 'object' ? data.channels : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = A.normalizeKey(k);
    if (!key || !v || typeof v !== 'object') continue;
    const ai = A.val(v.ai) > 0, pe = A.val(v.pe) > 0;
    if (ai || pe) out[key] = { ai, pe, name: A.cleanName(v.name) || key };
  }
  return out;
}

/**
 * Downloads the subscribed shared list. Offline, the last copy is kept.
 * @returns {Promise<{ok: boolean, count: number, error: string}>}
 */
async function updateShared() {
  const { listUrl } = await get('listUrl');
  if (!listUrl) return { ok: false, error: 'No list URL set' };
  try {
    const r = await fetch(listUrl, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const channels = normalizeShared(await r.json());
    const count = Object.keys(channels).length;
    await set({ sharedList: { channels, count, updated: Date.now() } });
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

const MENU_ACTIONS = ['ai', 'pe', 'notai', 'notpe', 'clear'];
const MENU_CONTEXTS = ['page', 'link', 'image', 'video', 'selection'];

/** (Re)creates the right-click menu. Firefox for Android has no menus API. */
async function buildMenus() {
  if (!api.contextMenus) return;
  await api.contextMenus.removeAll();
  const add = o => api.contextMenus.create({ contexts: MENU_CONTEXTS, ...o });
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

if (api.contextMenus) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    const id = info.menuItemId;
    if (id === 'settings') return api.runtime.openOptionsPage();
    if (id === 'help') return api.tabs.create({ url: api.runtime.getURL('options.html#help') });
    // Only the top frame runs the content script; a click inside an iframe (live chat,
    // embeds) would otherwise act on whatever was right-clicked before.
    if (!MENU_ACTIONS.includes(id) || tab?.id == null || (info.frameId ?? 0) !== 0) return;
    api.tabs.sendMessage(tab.id, { type: MSG.MENU, action: id }, { frameId: 0 })
      .catch(() => {}); // tab opened before install: needs a reload
  });
}

api.action?.onClicked.addListener(() => api.runtime.openOptionsPage());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Menus and alarms; runs on install, update and browser start. */
function setup() {
  buildMenus();
  api.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN, delayInMinutes: 1 });
  api.alarms.create(SHARED_ALARM, { periodInMinutes: SHARED_PERIOD_MIN, delayInMinutes: 2 });
}
api.runtime.onInstalled.addListener(setup);
api.runtime.onStartup.addListener(() => { setup(); syncNow(); });

api.alarms.onAlarm.addListener(a => {
  if (a.name === SYNC_ALARM || a.name === FLUSH_ALARM) syncNow();
  if (a.name === SHARED_ALARM) updateShared();
});

// Coming back online: send waiting votes right away (useful with short online windows).
globalThis.addEventListener?.('online', () => syncNow());

/** Message type → handler. Each returns a promise of a JSON-serializable response. */
const HANDLERS = {
  [MSG.MARK]: applyMark,
  [MSG.IMPORT]: importData,
  [MSG.WIPE]: wipe,
  [MSG.SYNC_CONFIG]: configureSync,
  [MSG.SYNC_NOW]: syncNow,
  [MSG.UPDATE_LIST]: updateShared,
};

/** Messages a YouTube tab may send; everything else only from the extension's own pages. */
const FROM_TABS = new Set([MSG.MARK]);

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler || sender?.id !== api.runtime.id) return undefined; // only our own extension
  if (sender.tab && !FROM_TABS.has(msg.type)) return undefined;     // content scripts may only mark
  Promise.resolve()
    .then(() => handler(msg))
    .then(sendResponse, e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // keep the channel open for the async response (Chrome and Firefox)
});
