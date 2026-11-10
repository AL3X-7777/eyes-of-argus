// Real-browser smoke test: loads dist/chrome into Chrome and checks the service worker,
// the settings page (including Import and Delete all, which only a real browser exercises
// properly) and the content script on locally served pages mapped to the real hostnames.
//
// Usage:  python build.py && npm run test:browser      (needs Chrome and openssl)
//         CHROME=/path/to/chrome npm run test:browser
/* eslint-disable no-undef -- page.evaluate callbacks run inside the browser */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const EXT = path.join(__dirname, '..', '..', 'dist', 'chrome');
const wait = ms => new Promise(r => setTimeout(r, ms));
const PAGES = {};
// throwaway self-signed certificate for the local HTTPS server
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-smoke-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
  '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
require('node:https').createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (q, r) => {
  const body = PAGES['https://' + q.headers.host + q.url];
  if (body == null) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
}).listen(8443, '127.0.0.1');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', pipe: true, enableExtensions: [EXT],
    args: ['--no-sandbox', '--no-proxy-server', '--ignore-certificate-errors', '--host-resolver-rules=MAP * 127.0.0.1:8443', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const out = {};
  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 15000 });
    const sw = await swTarget.worker();
    const swErrors = [];
    sw.on('console', m => { if (m.type() === 'error') swErrors.push(m.text()); });
    const id = new URL(swTarget.url()).host;
    out.sw = await sw.evaluate(() => ({ argus: typeof Argus?.normalizeKey, key: Argus.normalizeKey('SITE:Example.com'), id: chrome.runtime.id, sites: chrome.runtime.getManifest().content_scripts[0].matches.length }));
    const UC = 'UC' + 'a'.repeat(22);
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ marks: {
        '@marked': { ai: 1, pe: 0, name: '<img src=x onerror=window.__xss=1>', t: 3 }, 'site:example.com': { ai: 1, pe: 1, name: 'example.com', t: 2 },
        'x:nasa': { ai: 0, pe: 1, name: '@nasa', t: 1 }, 'reddit:u/spez': { ai: 1, pe: 0, name: 'spez', t: 1 } } });
    });

    // ---- options page ----
    const opt = await browser.newPage();
    const optErrors = [];
    opt.on('console', m => { if (['error', 'warning'].includes(m.type())) optErrors.push(m.text()); });
    opt.on('pageerror', e => optErrors.push('pageerror ' + e.message));
    opt.on('dialog', d => d.accept());
    await opt.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'load' });
    await wait(500);
    out.options = await opt.evaluate(() => ({
      rows: document.querySelectorAll('#marks tbody tr').length, count: document.querySelector('#count').textContent,
      xss: window.__xss ?? null, img: !!document.querySelector('#marks img'),
      keys: [...document.querySelectorAll('#marks .k')].map(e => e.textContent), hrefs: [...document.querySelectorAll('#marks a')].map(e => e.href),
      sync: document.querySelector('#syncStatus').textContent, toggles: [...document.querySelectorAll('[data-setting]')].map(b => b.checked),
    }));
    // Q1: what does the background see as sender for the options tab?
    out.q1_mark = await opt.evaluate(() => Promise.race([chrome.runtime.sendMessage({ type: 'argus-mark', key: 'x:nasa', changes: { ai: 1 } }), new Promise(r => setTimeout(() => r('TIMEOUT'), 1500))]).catch(e => 'ERR ' + e.message));
    out.q1_import = await opt.evaluate(() => Promise.race([chrome.runtime.sendMessage({ type: 'argus-import', data: { channels: { '@imported': { ai: true } } } }), new Promise(r => setTimeout(() => r('TIMEOUT'), 1500))]).catch(e => 'ERR ' + e.message));
    out.q1_syncnow = await opt.evaluate(() => Promise.race([chrome.runtime.sendMessage({ type: 'argus-sync-now' }), new Promise(r => setTimeout(() => r('TIMEOUT'), 1500))]).catch(e => 'ERR ' + e.message));
    await opt.click('#wipe'); await wait(600);
    out.q1_wipe_ui = await opt.evaluate(async () => ({ status: document.querySelector('#ioStatus').textContent, marksLeft: Object.keys((await chrome.storage.local.get('marks')).marks || {}).length }));
    await opt.evaluate(() => { document.querySelector('#syncServer').value = 'http://127.0.0.1:9'; });
    out.optErrors = optErrors;

    // ---- content script on intercepted pages ----
    await opt.evaluate(async _UC => {
      await chrome.storage.local.set({ marks: {
        '@marked': { ai: 1, pe: 0, name: 'M', t: 3 }, 'site:example.com': { ai: 1, pe: 1, name: 'example.com', t: 2 },
        'x:nasa': { ai: 0, pe: 1, name: '@nasa', t: 1 }, 'reddit:u/spez': { ai: 1, pe: 0, name: 'spez', t: 1 } },
        sync: { enabled: false }, community: { c: { '@comm': [90, 20, 0, 0] } } });
    }, UC);
    const pages = {
      'https://www.youtube.com/': '<ytd-rich-item-renderer id="card"><a id="thumb" href="/watch?v=1"><img></a><a id="m" href="/@marked">Marked</a></ytd-rich-item-renderer><ytd-rich-item-renderer><a id="u" href="/@unmarked">Un</a><a id="c" href="/@comm">Comm</a></ytd-rich-item-renderer>',
      'https://www.google.com/search?q=x': '<div class="g" id="card"><a href="/url?q=https://www.example.com/page&sa=U"><h3 id="m">Example</h3></a></div><div class="g"><a href="https://other.org/"><h3 id="u">Other</h3></a></div>',
      'https://x.com/home': '<article id="card"><div data-testid="User-Name"><a id="m" href="/nasa">NASA</a></div><a id="u" href="/esa">@esa</a></article>',
      'https://www.reddit.com/': '<shreddit-post id="card"><a id="m" href="/user/spez">u/spez</a><a id="u" href="/r/pics">r/pics</a></shreddit-post><div id="host"></div>',
      'https://example.net/': '<a id="m" href="https://www.youtube.com/@marked">x</a>',
    };
    Object.assign(PAGES, pages);
    out.content = {};
    for (const url of Object.keys(pages)) {
      const page = await browser.newPage();
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      await page.goto(url, { waitUntil: 'load' });
      await wait(1200);
      const res = await page.evaluate(() => ({
        cls: document.documentElement.className, m: document.getElementById('m')?.dataset.argus ?? null, u: document.getElementById('u')?.dataset.argus ?? null,
        c: document.getElementById('c')?.dataset.argus ?? null, card: document.getElementById('card')?.dataset.argusCard ?? null,
        badge: document.getElementById('m') ? getComputedStyle(document.getElementById('m'), '::after').content : null,
      }));
      if (url.includes('youtube')) {
        // right-click the thumbnail, then let the background forward a menu click like contextMenus.onClicked would
        await page.evaluate(() => document.getElementById('thumb').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
        await opt.evaluate(async () => { for (const t of await chrome.tabs.query({})) await chrome.tabs.sendMessage(t.id, { type: 'argus-menu', action: 'pe' }, { frameId: 0 }).catch(() => {}); });
        await wait(700);
        res.afterMenu = await page.evaluate(() => ({ m: document.getElementById('m').dataset.argus, toast: document.getElementById('argus-toast')?.textContent }));
        res.stored = await opt.evaluate(async () => (await chrome.storage.local.get('marks')).marks['@marked']);
        // can the page itself talk to the extension?
        res.pageCanMessage = await page.evaluate(_id => { try { return typeof chrome?.runtime?.sendMessage; } catch (e) { return 'err'; } }, id);
      }
      if (url.includes('reddit')) {
        await page.evaluate(() => { const r = document.getElementById('host').attachShadow({ mode: 'open' }); r.innerHTML = '<a id="s" href="/user/spez">u/spez</a>'; });
        await wait(900);
        res.shadowBadge = await page.evaluate(() => document.getElementById('host').shadowRoot.getElementById('s').dataset.argus ?? null);
      }
      res.errors = errs;
      out.content[url] = res;
      await page.close();
    }
    out.swErrors = swErrors;
    out.swTargets = browser.targets().filter(t => t.type() === 'service_worker').length; out.finalMark = await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'argus-mark', key: 'twitch:abc', changes: { ai: 1 } }));
  } catch (e) { out.fatal = String(e.stack || e); }
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const c = out.content || {};
  const checks = {
    'service worker loads shared.js': out.sw?.argus === 'function',
    'service worker has no errors': out.swErrors?.length === 0,
    'settings page has no errors': out.optErrors?.length === 0,
    'settings page can import': out.q1_import?.ok === true,
    'settings page can delete all marks': out.q1_wipe_ui?.marksLeft === 0,
    'YouTube badge': c['https://www.youtube.com/']?.m === 'ai' && c['https://www.youtube.com/']?.badge === '"AI"',
    'right-click menu marks and updates the badge': c['https://www.youtube.com/']?.afterMenu?.m === 'ai pe',
    'web pages cannot message the extension': c['https://www.youtube.com/']?.pageCanMessage === 'undefined',
    'Google result badge': c['https://www.google.com/search?q=x']?.m === 'ai pe',
    'X badge': c['https://x.com/home']?.m === 'pe',
    'Reddit badge': c['https://www.reddit.com/']?.m === 'ai',
    'unsupported sites are untouched': c['https://example.net/']?.m === null && c['https://example.net/']?.cls === '',
    'no fatal error': !out.fatal,
  };
  let failed = 0;
  for (const [name, ok] of Object.entries(checks)) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++; }
  if (failed) console.log(JSON.stringify(out, null, 1));
  process.exit(failed ? 1 : 0);
})();
