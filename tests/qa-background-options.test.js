// QA: background message handling, import/export, and the settings page (jsdom).
// Tests whose name starts with "BUG Qn" assert the DESIRED behaviour and fail while the bug exists.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { fakeStorage, fakeApi, loadBackground, wait, SRC } = require('./helpers');

const UC = 'UC' + 'b'.repeat(22);
const SYNC = { enabled: true, server: 'https://s.invalid' };

/** Sends a message with an explicit sender; resolves 'NO-ANSWER' if the background ignores it. */
const askAs = (bg, msg, sender) => Promise.race([
  new Promise(resolve => { for (const f of bg.api.runtime.onMessage.fns) f(msg, sender, resolve); }),
  wait(150).then(() => 'NO-ANSWER'),
]);

/** The settings page in jsdom, talking to a real background over the fake API. */
function optionsPage(storage) {
  const bg = loadBackground(storage);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  const dom = new JSDOM(fs.readFileSync(path.join(SRC, 'options.html'), 'utf8'), { url: 'https://ext.invalid/options.html', runScripts: 'outside-only', virtualConsole: vc });
  const w = dom.window;
  const api = fakeApi(storage);
  const sent = [];
  api.runtime.sendMessage = msg => { sent.push(msg); return bg.ask(msg); };
  api.permissions.remove = async () => true;
  w.chrome = api;
  w.confirm = () => true;
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};
  w.Element.prototype.scrollIntoView = () => {};
  for (const f of ['shared.js', 'options.js']) w.eval(fs.readFileSync(path.join(SRC, f), 'utf8'));
  const $ = s => w.document.querySelector(s);
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  return { w, $, fire, bg, sent, errors, api };
}

test('QA import/export round trip keeps prefixed keys, "Not" choices, UC ids and import tags', async () => {
  const marks = {
    '@a': { ai: 1, pe: -1, name: 'A', uc: UC, t: 5 }, 'x:nasa': { ai: 1, pe: 0, name: '@nasa', t: 4 },
    'reddit:u/spez': { ai: -1, pe: 0, name: 'u/spez', t: 3 }, 'reddit:r/pics': { ai: 0, pe: 1, name: 'r/pics', t: 2 },
    'site:example.co.uk': { ai: 1, pe: 1, name: 'example.co.uk', t: 1 }, 'facebook:4': { ai: 1, pe: 0, name: '4', src: 'import', t: 1 },
    'tiktok:a.b_c': { ai: 1, pe: 0, name: 'x', t: 1 }, 'twitch:abc': { pe: 1, ai: 0, name: 'x', t: 1 }, 'instagram:a.b': { pe: -1, ai: 0, name: 'x', t: 1 },
  };
  const a = optionsPage(fakeStorage({ marks }));
  await wait(50);
  const file = JSON.parse(JSON.stringify(a.w.__argusOptions.buildExport()));
  assert.equal(Object.keys(file.mine).length, 9);
  assert.equal(file.channels['reddit:u/spez'], undefined); // "Not" only is not a shared "yes"
  const st = fakeStorage({ sync: SYNC });
  const bg = loadBackground(st);
  assert.equal((await bg.ask({ type: 'argus-import', mode: 'restore', data: file })).count, 9);
  for (const [k, v] of Object.entries(marks)) {
    const got = st.data.marks[k];
    assert.deepEqual([got.ai, got.pe, got.name, got.uc, got.src], [v.ai, v.pe, v.name, v.uc, v.src], k);
  }
  const q = Object.keys(st.data.queue).sort();
  assert.ok(q.includes('reddit:u/spez|ai') && q.includes('site:example.co.uk|pe') && q.includes(`${UC}|ai`));
  assert.equal(q.some(k => k.startsWith('facebook:4')), false); // imported from someone else: never voted
  assert.equal((await bg.ask({ type: 'argus-import', mode: 'restore', data: file })).count, 0); // idempotent
});

test('QA import: hostile files are harmless (prototype keys, wrong types, huge names, bad values)', async () => {
  const st = fakeStorage({ sync: SYNC });
  const bg = loadBackground(st);
  const mine = JSON.parse(`{"__proto__":{"ai":1,"polluted":1},"constructor":{"ai":1},"prototype:x":{"ai":1},
    "@ok":{"ai":2,"pe":"1","name":{"toString":1}},"@fine":{"ai":true,"pe":-1,"name":"${'n'.repeat(500)}","uc":"UC<script>"},
    "site:evil.com/<script>":{"ai":1},"x:<img>":{"ai":1},"@a|ai":{"ai":1},"@nul":null,"@arr":[1,1],"@str":"x",
    "X:NASA":{"ai":1,"name":"\\u202eevil\\u0000"}}`);
  const res = await bg.ask({ type: 'argus-import', mode: 'restore', data: { mine } });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(st.data.marks).sort(), ['@fine', 'x:nasa']);
  assert.equal(st.data.marks['@fine'].name.length, 100);
  assert.equal(st.data.marks['@fine'].uc, undefined);
  assert.equal(st.data.marks['x:nasa'].name, 'evil');
  assert.equal({}.polluted, undefined);
  assert.equal(require('node:vm').runInContext('({}).polluted', bg.ctx), undefined);
  for (const data of [null, 1, 'x', [], {}, { mine: 'x' }, { channels: 5 }, { mine: null, channels: null }]) {
    assert.equal((await bg.ask({ type: 'argus-import', data })).ok, false, JSON.stringify(data));
  }
  assert.equal((await bg.ask({ type: 'argus-import', data: { channels: [] } })).count, 0);
});

test('BUG Q2: importing a file someone else exported must not overwrite your marks or become your votes', async () => {
  // Alice exports (the file always has a `mine` section) and shares it, as the UI suggests.
  const alice = optionsPage(fakeStorage({ marks: { '@target': { ai: 1, pe: 1, name: 'T', t: 1 }, '@yours': { ai: -1, pe: 0, name: 'Y', t: 1 } } }));
  await wait(50);
  const file = JSON.parse(JSON.stringify(alice.w.__argusOptions.buildExport()));
  const st = fakeStorage({ sync: SYNC, marks: { '@yours': { ai: 1, pe: 0, name: 'Y', t: 1 } } });
  const bg = loadBackground(st);
  await bg.ask({ type: 'argus-import', data: file });
  assert.equal(st.data.marks['@yours'].ai, 1, 'your own opinion was replaced by the other person\'s');
  assert.deepEqual(Object.keys(st.data.queue || {}), [], 'the other person\'s opinions were queued as your votes');
});

test('BUG Q1: the settings page opened in a tab (open_in_tab) is still allowed to import, wipe and configure sync', async () => {
  const st = fakeStorage({ marks: { '@a': { ai: 1, pe: 0, t: 1 } } });
  const bg = loadBackground(st);
  bg.api.runtime.id = 'ext-id';
  const optionsTab = { id: 'ext-id', tab: { id: 7 }, url: 'ext://options.html', origin: 'ext://' };
  assert.notEqual(await askAs(bg, { type: 'argus-wipe' }, optionsTab), 'NO-ANSWER');
  assert.deepEqual(st.data.marks, {});
});

test('QA message senders: other extensions and web tabs are refused; odd types do nothing', async () => {
  const st = fakeStorage({ marks: { '@a': { ai: 1, pe: 0, t: 1 } } });
  const bg = loadBackground(st);
  bg.api.runtime.id = 'ext-id';
  const contentTab = { id: 'ext-id', tab: { id: 3 }, url: 'https://www.youtube.com/' };
  for (const type of ['argus-wipe', 'argus-import', 'argus-sync-config', 'argus-sync-now', 'argus-update-list']) {
    assert.equal(await askAs(bg, { type, enabled: true, server: 'https://evil.example', data: { mine: {} } }, contentTab), 'NO-ANSWER', type);
  }
  assert.equal(await askAs(bg, { type: 'argus-wipe' }, { id: 'other-ext' }), 'NO-ANSWER');
  assert.equal(await askAs(bg, { type: 'argus-mark', key: '@a', changes: { ai: 0 } }, { id: 'other-ext', tab: { id: 1 } }), 'NO-ANSWER');
  assert.equal(await askAs(bg, { type: 'argus-wipe' }, undefined), 'NO-ANSWER');
  assert.equal(await askAs(bg, null, { id: 'ext-id' }), 'NO-ANSWER');
  assert.equal(st.data.marks['@a'].ai, 1);
  assert.equal(st.data.sync, undefined);
  // content scripts may mark, but only valid keys and values
  for (const bad of [{ key: 'x:' }, { key: '@a', changes: { ai: 2 } }, { key: '@a', changes: { ai: '1' } }, { key: {} }, { key: '__proto__' }]) {
    assert.equal((await askAs(bg, { type: 'argus-mark', ...bad }, contentTab)).ok, false, JSON.stringify(bad));
  }
  assert.equal((await askAs(bg, { type: 'argus-mark', key: 'SITE:Example.com', name: 'x'.repeat(999), changes: { pe: 1, __proto__: { x: 1 }, zz: 1 } }, contentTab)).ok, true);
  assert.deepEqual(Object.keys(st.data.marks['site:example.com']).sort(), ['ai', 'name', 'pe', 't']);
});

test('BUG Q10: message types that are Object.prototype members are ignored', async () => {
  const bg = loadBackground(fakeStorage({}));
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(await askAs(bg, { type }, {}), 'NO-ANSWER', type);
  }
});

test('QA sync config: only https (or local http) servers; queue holds every own mark under its prefixed key', async () => {
  const st = fakeStorage({ marks: { 'site:a.com': { ai: 1, pe: -1, name: 'a.com', t: 1 }, 'x:b': { ai: 0, pe: 1, name: 'b', src: 'import', t: 1 } } });
  const bg = loadBackground(st);
  bg.ctx.fetch = async () => { throw new TypeError('offline'); };
  for (const server of ['http://evil.example', 'javascript:alert(1)', 'ftp://a.b', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', '', null, 'file:///etc/passwd', '//a.b']) {
    assert.equal((await bg.ask({ type: 'argus-sync-config', enabled: true, server })).ok, false, String(server));
  }
  assert.equal(st.data.sync, undefined);
  assert.equal((await bg.ask({ type: 'argus-sync-config', enabled: true, server: ' https://user:pw@S.Example/base/?q=1#h ' })).ok, true);
  assert.equal(st.data.sync.server, 'https://s.example/base'); // credentials, query and hash dropped
  assert.deepEqual(Object.keys(st.data.queue).sort(), ['site:a.com|ai', 'site:a.com|pe']);
  await wait(50);
  assert.equal((await bg.ask({ type: 'argus-sync-config', enabled: false, withdraw: true })).ok, true);
  assert.deepEqual(st.data.queue, {});
});

test('QA options page: renders prefixed keys as inert text with correct links; search, selects and delete work', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const st = fakeStorage({ marks: {
    '@a': { ai: 1, pe: 0, name: evil, t: 9 }, 'x:nasa': { ai: 1, pe: -1, name: '@nasa', t: 8 }, 'reddit:u/spez': { ai: 0, pe: 1, t: 7 },
    'reddit:r/pics': { ai: 1, pe: 0, t: 6 }, 'site:example.com': { ai: 1, pe: 1, t: 5 }, 'facebook:4': { ai: 1, pe: 0, t: 4 },
    'facebook:zuck': { ai: 1, pe: 0, t: 3 }, 'tiktok:nasa': { ai: 1, pe: 0, t: 2 }, [UC]: { ai: true, t: 1 }, '@gone': { ai: 0, pe: 0 },
  } });
  const p = optionsPage(st);
  await wait(60);
  assert.deepEqual(p.errors, []);
  const rows = [...p.w.document.querySelectorAll('#marks tbody tr')];
  assert.equal(rows.length, 9);
  assert.equal(p.$('#count').textContent, '9');
  assert.equal(p.$('#empty').hidden, true);
  assert.equal(p.w.document.querySelector('#marks img'), null);
  assert.equal(rows[0].querySelector('a').textContent, evil);
  const links = Object.fromEntries(rows.map(r => [r.querySelector('.k').textContent, r.querySelector('a').href]));
  assert.deepEqual(links, {
    'YouTube · @a': 'https://www.youtube.com/@a', 'X · x:nasa': 'https://x.com/nasa',
    'Reddit · reddit:u/spez': 'https://www.reddit.com/user/spez', 'Reddit · reddit:r/pics': 'https://www.reddit.com/r/pics',
    'Website · site:example.com': 'https://example.com/', 'Facebook · facebook:4': 'https://www.facebook.com/profile.php?id=4',
    'Facebook · facebook:zuck': 'https://www.facebook.com/zuck', 'TikTok · tiktok:nasa': 'https://www.tiktok.com/@nasa',
    [`YouTube · ${UC}`]: `https://www.youtube.com/channel/${UC}`,
  });
  for (const r of rows) assert.equal(r.querySelector('a').rel, 'noreferrer');
  assert.equal(rows[1].querySelector('select.pe').value, '-1');

  p.$('#search').value = 'REDDIT'; p.fire(p.$('#search'), 'input');
  assert.equal(p.w.document.querySelectorAll('#marks tbody tr').length, 2);
  p.$('#search').value = ''; p.fire(p.$('#search'), 'input');

  const sel = p.w.document.querySelectorAll('#marks tbody tr')[1].querySelector('select.ai');
  sel.value = '-1'; p.fire(sel, 'change');
  await wait(60);
  assert.equal(st.data.marks['x:nasa'].ai, -1);
  assert.equal(st.data.marks['x:nasa'].name, '@nasa');
  [...p.w.document.querySelectorAll('#marks tbody tr')].find(r => r.textContent.includes('site:example.com')).querySelector('button.x').click();
  await wait(60);
  assert.equal(st.data.marks['site:example.com'], undefined);
  assert.equal(p.w.document.querySelectorAll('#marks tbody tr').length, 8);
});

test('QA options page: display toggles, export, import (file), wipe, shared-list and server validation', async () => {
  const st = fakeStorage({ marks: { 'x:nasa': { ai: 1, pe: 0, name: '@nasa', t: 1 } }, settings: { dim: true } });
  const p = optionsPage(st);
  await wait(60);
  const box = n => p.$(`[data-setting="${n}"]`);
  assert.deepEqual([box('badges').checked, box('tint').checked, box('dim').checked], [true, true, true]);
  box('badges').checked = false; p.fire(box('badges'), 'change');
  await wait(30);
  assert.deepEqual(st.data.settings, { badges: false, tint: true, dim: true });

  p.$('#export').click();
  assert.match(p.$('#ioStatus').textContent, /Exported 1 /);

  const give = async text => {
    Object.defineProperty(p.$('#importFile'), 'files', { configurable: true, value: [{ text: async () => text }] });
    p.fire(p.$('#importFile'), 'change');
    await wait(80);
    return p.$('#ioStatus').textContent;
  };
  assert.match(await give('{not json'), /isn't valid JSON/);
  assert.match(await give('{"hello":1}'), /not an Eyes of Argus file/);
  assert.match(await give('[]'), /not an Eyes of Argus file/);
  assert.match(await give('null'), /not an Eyes of Argus file/);
  assert.match(await give(JSON.stringify({ channels: { 'site:Example.org': { ai: true, name: '<b>x</b>' }, 'bad key': { ai: true }, '__proto__': { ai: true } } })), /Imported 1 /);
  assert.equal(st.data.marks['site:example.org'].src, 'import');
  assert.equal(p.w.document.querySelector('#marks b'), null);
  assert.equal(p.w.document.querySelectorAll('#marks tbody tr').length, 2);

  for (const [url, re] of [['http://a.example/l.json', /must start with https/], ['notaurl', /valid URL/], ['javascript:alert(1)', /must start with https/]]) {
    p.$('#listUrl').value = url; p.$('#saveList').click();
    await wait(30);
    assert.match(p.$('#listStatus').textContent, re, url);
    assert.equal(st.data.listUrl, undefined);
  }
  p.$('#syncServer').value = 'http://evil.example'; p.$('#syncEnabled').checked = true; p.fire(p.$('#syncEnabled'), 'change');
  await wait(30);
  assert.equal(p.$('#syncEnabled').checked, false);
  assert.equal(st.data.sync, undefined);

  p.$('#wipe').click();
  await wait(60);
  assert.deepEqual(st.data.marks, {});
  assert.equal(p.$('#empty').hidden, false);
  assert.deepEqual(p.errors, []);
});

test('QA shared list download: only valid "yes" entries are kept, names cleaned', async () => {
  const st = fakeStorage({ listUrl: 'https://l.invalid/a.json' });
  const bg = loadBackground(st);
  bg.ctx.fetch = async () => ({ ok: true, json: async () => JSON.parse(`{"mine":{"@m":{"ai":1}},"channels":{"__proto__":{"ai":1},
    "site:A.com":{"ai":1,"name":"<script>"},"x:nasa":{"ai":-1,"pe":0},"reddit:u/ab":{"ai":1},"@ok":{"pe":true,"name":5}}}`) });
  const res = await bg.ask({ type: 'argus-update-list' });
  assert.equal(res.count, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(st.data.sharedList.channels)), { 'site:a.com': { ai: true, pe: false, name: '<script>' }, '@ok': { ai: false, pe: true, name: '@ok' } });
});
