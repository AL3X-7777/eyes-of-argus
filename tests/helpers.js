// Shared test helpers: a fake WebExtension API, a YouTube-like DOM, and a local sync server.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Scripts in the order the manifest loads them (kept in sync with build.py). */
const present = list => list.filter(f => fs.existsSync(path.join(SRC, f)));
const CONTENT_SCRIPTS = present(['shared.js', 'platforms.js', 'content.js']);
const BACKGROUND_SCRIPTS = present(['shared.js', 'background.js']);

const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const wait = ms => new Promise(r => setTimeout(r, ms));

/** In-memory browser.storage.local with onChanged events, shared between "contexts". */
function fakeStorage(initial = {}) {
  const data = clone(initial);
  const listeners = [];
  return {
    data,
    local: {
      async get(keys) {
        const out = {};
        const list = keys == null ? Object.keys(data) : [].concat(keys);
        for (const k of list) if (k in data) out[k] = clone(data[k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const k of Object.keys(obj)) {
          changes[k] = { oldValue: clone(data[k]), newValue: clone(obj[k]) };
          data[k] = clone(obj[k]);
        }
        listeners.forEach(f => f(changes, 'local'));
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) { changes[k] = { oldValue: clone(data[k]) }; delete data[k]; }
        listeners.forEach(f => f(changes, 'local'));
      },
    },
    onChanged: { addListener: f => listeners.push(f) },
  };
}

const event = () => {
  const fns = [];
  return { addListener: f => fns.push(f), fns };
};

/** Minimal chrome.* surface used by the extension. */
function fakeApi(storage) {
  return {
    storage,
    runtime: {
      id: 'argus-test-extension',
      onMessage: event(), onInstalled: event(), onStartup: event(),
      getURL: p => 'ext://' + p, openOptionsPage() {}, sendMessage: async () => ({}),
    },
    contextMenus: { removeAll: async () => {}, create() {}, onClicked: event() },
    action: { onClicked: event() },
    alarms: { create() {}, onAlarm: event() },
    tabs: { create() {}, sendMessage: async () => {} },
    permissions: { request: async () => true },
  };
}

/** A tiny YouTube-like page with the content scripts loaded. */
function youtubePage(html, storage, url = 'https://www.youtube.com/') {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, runScripts: 'outside-only' });
  const api = fakeApi(storage);
  // Content scripts ask the background (the single writer) to change marks
  const bg = loadBackground(storage);
  api.runtime.sendMessage = msg => bg.ask(msg, { id: bg.api.runtime.id, tab: { id: 1 }, url });
  dom.window.chrome = api;
  for (const f of CONTENT_SCRIPTS) dom.window.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  const $ = id => dom.window.document.getElementById(id);
  /** Simulates right-click on an element followed by a menu choice. */
  const menu = async (id, action) => {
    $(id).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
    for (const f of api.runtime.onMessage.fns) f({ type: 'argus-menu', action });
    await wait(80);
  };
  return { dom, window: dom.window, api, $, menu, bg };
}

/** Loads background scripts into a sandboxed global with the given storage. */
function loadBackground(storage) {
  const vm = require('node:vm');
  const api = fakeApi(storage);
  const ctx = vm.createContext({
    chrome: api, fetch, crypto: globalThis.crypto, TextEncoder, URL, console, setTimeout, clearTimeout, Headers,
  });
  ctx.globalThis = ctx;
  for (const f of BACKGROUND_SCRIPTS) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  /** Sends a runtime message and resolves with the background's response. */
  const ask = (msg, sender) => new Promise(resolve => {
    for (const f of api.runtime.onMessage.fns) {
      const r = f(msg, sender || { id: api.runtime.id, tab: { id: 99 }, url: api.runtime.getURL('options.html') }, resolve);
      if (r && typeof r.then === 'function') r.then(resolve);
    }
  });
  return { api, ask, ctx };
}

/** Starts `wrangler dev` with a fresh local database. Returns { url, stop, sql }. */
async function startServer(port = 8790) {
  const serverDir = path.join(ROOT, 'server');
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-'));
  const wrangler = path.join(serverDir, 'node_modules', '.bin', 'wrangler');
  const common = ['--persist-to', persist];
  execFileSync(wrangler, ['d1', 'execute', 'argus', '--local', ...common, '--file', 'schema.sql'], { cwd: serverDir, stdio: 'ignore' });
  const vars = { POW_BITS: '10', MIN_VOTES: '2', SALT: 'test-salt', ADMIN_TOKEN: 'test-admin', REG_PER_NET_DAY: '50' };
  const args = ['dev', '--port', String(port), '--test-scheduled', '--ip', '127.0.0.1', ...common];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const proc = spawn(wrangler, args, { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url + '/config')).ok) break; } catch { /* not up yet */ }
    await wait(500);
    if (i === 119) throw new Error('server did not start:\n' + log);
  }
  const sql = command => execFileSync(wrangler, ['d1', 'execute', 'argus', '--local', ...common, '--command', command], { cwd: serverDir, stdio: 'ignore' });
  const stop = () => { proc.kill('SIGTERM'); fs.rmSync(persist, { recursive: true, force: true }); };
  return { url, stop, sql, log: () => log };
}

module.exports = { fakeStorage, fakeApi, youtubePage, loadBackground, startServer, wait, clone, ROOT, SRC };
