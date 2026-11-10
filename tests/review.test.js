// Regression tests for the findings of the November 2026 code review (F-numbers in docs/REVIEW-REPORT.md).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeStorage, youtubePage, loadBackground, wait } = require('./helpers');

const GRID = `<ytd-rich-item-renderer id="c1"><a href="/watch?v=1" id="thumb1"><img></a>
  <a href="/@NileBlue" id="n1">NileBlue</a></ytd-rich-item-renderer>`;

test('F26: one key normalization everywhere (decode, NFC, lowercase, reject invisible chars)', async () => {
  require('../src/shared.js');
  const A = globalThis.Argus;
  assert.equal(A.normalizeKey('@%C3%89cole'), '@école');
  assert.equal(A.normalizeKey('@École'), '@école', 'NFD input becomes NFC');
  assert.equal(A.normalizeKey('@bad​name'), null, 'zero-width space rejected');
  assert.equal(A.normalizeKey('UCabcdefghijklmnopqrstuv'), 'UCabcdefghijklmnopqrstuv');
  assert.equal(A.keyFromHref('/@%C3%89cole/videos'), '@école');
  assert.equal(A.serverBase('https://x.test/api/?q=1#h'), 'https://x.test/api', 'F29: query and hash dropped');
  assert.equal(A.serverBase('http://evil.test'), null);
});

test('F19/F27: IPv6 grouped by /56; override bits in community entries', async () => {
  const { netOf, score } = await import('../server/src/lib.js');
  assert.equal(netOf('2001:db8:1:22aa::1'), netOf('2001:db8:1:22ff:1:2:3:4'));
  assert.notEqual(netOf('2001:db8:1:2300::1'), netOf('2001:db8:1:2200::1'));
  assert.equal(netOf('::ffff:1.2.3.4'), '1.2.3.4');
  const c = { minVotes: 15, minAgree: 70 };
  assert.deepEqual(score({}, { ai: 1, pe: null }, 'X', c).entry, [100, 0, 0, 0, 'X', 1]);
  assert.equal(score({ ai: { up: 20, down: 0, n: 20 } }, { ai: 0 }, 'X', c).entry, null);
});

test('F7: badge and card tag are removed when YouTube reuses a link for a video', async () => {
  const s = fakeStorage({ marks: { '@nileblue': { ai: 1, pe: 0 } } });
  const { $ } = youtubePage(GRID, s);
  await wait(300);
  assert.equal($('n1').dataset.argus, 'ai');
  $('n1').setAttribute('href', '/watch?v=zzz');
  await wait(300);
  assert.equal($('n1').dataset.argus, undefined);
  assert.equal($('c1').dataset.argusCard, undefined);
});

test('F8: one right-click → one action; iframe clicks are ignored', async () => {
  const s = fakeStorage();
  const p = youtubePage(GRID, s);
  await p.menu('n1', 'ai');
  for (const f of p.api.runtime.onMessage.fns) f({ type: 'argus-menu', action: 'pe' }); // no new right-click
  await wait(80);
  assert.equal(s.data.marks['@nileblue'].pe, 0, 'stale target not reused');

  const bg = loadBackground(fakeStorage());
  let sent = 0;
  bg.api.tabs.sendMessage = async () => { sent++; };
  bg.api.contextMenus.onClicked.fns[0]({ menuItemId: 'ai', frameId: 3 }, { id: 1 });
  bg.api.contextMenus.onClicked.fns[0]({ menuItemId: 'ai', frameId: 0 }, { id: 1 });
  assert.equal(sent, 1);
});

test('F13/F12: export is lossless; own backup restores exactly; other lists are not your votes', async () => {
  const s = fakeStorage({ sync: { enabled: true, server: 'https://x.test' } });
  const { ask } = loadBackground(s);
  const mine = { '@a': { ai: -1, pe: 1, name: 'A', uc: 'UCabcdefghijklmnopqrstuv' } };
  assert.equal((await ask({ type: 'argus-import', mode: 'restore', data: { mine } })).count, 1);
  assert.deepEqual([s.data.marks['@a'].ai, s.data.marks['@a'].pe, s.data.marks['@a'].uc], [-1, 1, 'UCabcdefghijklmnopqrstuv']);
  assert.equal(Object.keys(s.data.queue).length, 4, 'own backup votes for handle and UC id');

  const r = await ask({ type: 'argus-import', data: { channels: { '@b': { ai: true }, 'not a key': { ai: true }, '@a': { ai: true } } } });
  assert.equal(r.count, 1, 'invalid key skipped, your "Not" on @a kept');
  assert.equal(s.data.marks['@a'].ai, -1);
  assert.equal(s.data.queue['@b|ai'], undefined, 'shared-list import is not sent as your votes');
});

test('F10: turning sync on queues every mark and replaces old server votes; wipe withdraws', async () => {
  const s = fakeStorage({ marks: { '@a': { ai: 1, pe: -1 }, '@b': { ai: 1, pe: 0, src: 'import' } } });
  const { ask } = loadBackground(s);
  await ask({ type: 'argus-sync-config', enabled: true, server: 'https://x.test/' });
  assert.equal(s.data.sync.server, 'https://x.test');
  assert.ok(s.data.syncReplace, 'replace flag set');
  assert.deepEqual(Object.keys(s.data.queue).sort(), ['@a|ai', '@a|pe']);
  await ask({ type: 'argus-wipe' });
  assert.deepEqual(s.data.marks, {});
  assert.equal(s.data.queue['@a|ai'].v, 0);
});

test('N2/N4: marking an imported channel yourself makes it your vote; backups keep the import tag', async () => {
  const s = fakeStorage();
  const { ask } = loadBackground(s);
  await ask({ type: 'argus-import', data: { channels: { '@x': { ai: true } } } });
  assert.equal(s.data.marks['@x'].src, 'import');
  await ask({ type: 'argus-mark', key: '@x', changes: { pe: 1 } });
  assert.equal(s.data.marks['@x'].src, undefined);
  await ask({ type: 'argus-sync-config', enabled: true, server: 'https://x.test' });
  assert.ok(s.data.queue['@x|pe'], 'now counted as your vote');

  const t = fakeStorage({ sync: { enabled: true, server: 'https://x.test' } });
  const b = loadBackground(t);
  await b.ask({ type: 'argus-import', mode: 'restore', data: { mine: { '@y': { ai: 1, pe: 0, src: 'import' } } } });
  assert.equal(t.data.marks['@y'].src, 'import');
  assert.equal(t.data.queue, undefined, 'imported-list marks in a backup are not voted');
});

test('N3/N6: opting out or moving servers queues deletion, even before registration finished', async () => {
  const s = fakeStorage({ sync: { enabled: true, server: 'https://old.test' }, identity: { secret: 'a'.repeat(64), id: 'x', registeredAt: null } });
  const { ask } = loadBackground(s);
  await ask({ type: 'argus-sync-config', enabled: true, server: 'https://new.test' });
  assert.deepEqual(s.data.pendingForget.map(p => p.server), ['https://old.test']);
  assert.equal(s.data.identity?.secret === 'a'.repeat(64), false, 'new identity for the new server');
});

test('N9: a YouTube tab may only send marks', async () => {
  const s = fakeStorage({ marks: { '@a': { ai: 1, pe: 0 } } });
  const { api } = loadBackground(s);
  const call = (msg, sender) => new Promise(resolve => {
    const r = api.runtime.onMessage.fns[0](msg, sender, resolve);
    if (r !== true) resolve('ignored');
  });
  const tab = { id: api.runtime.id, tab: { id: 1 }, url: 'https://www.youtube.com/' };
  assert.equal(await call({ type: 'argus-wipe' }, tab), 'ignored');
  assert.ok(s.data.marks['@a']);
  assert.equal((await call({ type: 'argus-mark', key: '@b', changes: { ai: 1 } }, tab)).ok, true);
});
