// Behaviour of the YouTube content script: badges, right-click resolution, marks and votes.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeStorage, youtubePage, wait } = require('./helpers');

const GRID = `
  <ytd-rich-item-renderer id="c1">
    <a href="/watch?v=1" id="thumb1"><img></a>
    <a href="/@NileBlue" id="av1"><img></a>
    <a href="/@NileBlue" id="n1">NileBlue</a>
  </ytd-rich-item-renderer>
  <ytd-rich-item-renderer id="c2">
    <a href="/watch?v=2" id="thumb2"><img></a>
    <a href="/channel/UCabcdefghijklmnopqrstuv" id="n2">Other</a>
  </ytd-rich-item-renderer>
  <ytd-compact-video-renderer id="c3"><a href="/watch?v=3" id="t3">video</a><span>No link</span></ytd-compact-video-renderer>
  <a href="https://example.com/@NileBlue" id="foreign">elsewhere</a>`;

test('marked channel gets a badge on its name, not its avatar, and its card is tagged', async () => {
  const s = fakeStorage({ marks: { '@nileblue': { ai: 1, pe: 0, name: 'NileBlue' } } });
  const { $ } = youtubePage(GRID, s);
  await wait(300);
  assert.equal($('n1').dataset.argus, 'ai');
  assert.equal($('av1').dataset.argus, undefined);
  assert.equal($('c1').dataset.argusCard, 'ai');
  assert.equal($('n2').dataset.argus, undefined);
  assert.equal($('foreign').dataset.argus, undefined, 'links to other sites are ignored');
});

test('old boolean marks from v0.1 still display', async () => {
  const s = fakeStorage({ marks: { '@nileblue': { ai: true, pe: true, name: 'NileBlue' } } });
  const { $ } = youtubePage(GRID, s);
  await wait(300);
  assert.equal($('n1').dataset.argus, 'ai pe');
});

test('right-clicking a thumbnail marks the channel of that card', async () => {
  const s = fakeStorage();
  const { $, menu } = youtubePage(GRID, s);
  await menu('thumb2', 'pe');
  assert.deepEqual({ ai: s.data.marks.UCabcdefghijklmnopqrstuv.ai, pe: s.data.marks.UCabcdefghijklmnopqrstuv.pe }, { ai: 0, pe: 1 });
  await wait(300);
  assert.equal($('n2').dataset.argus, 'pe');
});

test('marks combine, "Not" and "Clear" work, and clearing removes the entry', async () => {
  const s = fakeStorage();
  const { $, menu } = youtubePage(GRID, s);
  await menu('n1', 'ai');
  await menu('n1', 'pe');
  await wait(300);
  assert.equal($('n1').dataset.argus, 'ai pe');
  await menu('n1', 'notai');
  assert.equal(s.data.marks['@nileblue'].ai, -1);
  await wait(300);
  assert.equal($('n1').dataset.argus, 'pe');
  await menu('n1', 'clear');
  assert.equal(s.data.marks['@nileblue'], undefined);
  await wait(300);
  assert.equal($('n1').dataset.argus, undefined);
  assert.equal($('c1').dataset.argusCard, undefined);
});

test('a card without a channel link is not guessed', async () => {
  const s = fakeStorage();
  const { menu, window } = youtubePage(GRID, s);
  await menu('t3', 'ai');
  assert.equal(s.data.marks, undefined);
  assert.match(window.document.getElementById('argus-toast').textContent, /Nothing to mark here/);
});

test('reused anchors (YouTube changes href in place) are re-evaluated', async () => {
  const s = fakeStorage({ marks: { '@nileblue': { ai: 1, pe: 0 } } });
  const { $ } = youtubePage(GRID, s);
  await wait(300);
  $('n2').setAttribute('href', '/@NileBlue');
  await wait(300);
  assert.equal($('n2').dataset.argus, 'ai');
  $('n1').setAttribute('href', '/@someoneelse');
  await wait(300);
  assert.equal($('n1').dataset.argus, undefined);
});

test('community marks show with a vote tooltip; your "Not" overrides them', async () => {
  const s = fakeStorage({
    sync: { enabled: true, server: 'https://x.test' },
    community: { c: { '@nileblue': [90, 12, 0, 0, 'NileBlue'], UCabcdefghijklmnopqrstuv: [0, 0, 80, 5, 'Other'] } },
    marks: { UCabcdefghijklmnopqrstuv: { ai: 0, pe: -1 } },
  });
  const { $ } = youtubePage(GRID, s);
  await wait(300);
  assert.equal($('n1').dataset.argus, 'ai');
  assert.match($('n1').title, /AI 90% of 12 votes/);
  assert.equal($('n2').dataset.argus, undefined);
});

test('community marks are ignored while sync is off', async () => {
  const s = fakeStorage({ community: { c: { '@nileblue': [90, 12, 0, 0, 'NileBlue'] } } });
  const { $ } = youtubePage(GRID, s);
  await wait(300);
  assert.equal($('n1').dataset.argus, undefined);
});

test('shared list marks show and local marks win', async () => {
  const s = fakeStorage({
    sharedList: { channels: { '@nileblue': { ai: true, pe: true } } },
    marks: { '@nileblue': { ai: -1, pe: 0 } },
  });
  const { $ } = youtubePage(GRID, s);
  await wait(300);
  assert.equal($('n1').dataset.argus, 'pe');
});

test('with sync on, changes are queued as votes; without, nothing is queued', async () => {
  const off = fakeStorage();
  const a = youtubePage(GRID, off);
  await a.menu('n1', 'ai');
  assert.equal(off.data.queue, undefined);

  const on = fakeStorage({ sync: { enabled: true, server: 'https://x.test' } });
  const b = youtubePage(GRID, on);
  await wait(50);
  await b.menu('n1', 'ai');
  await b.menu('n1', 'clear');
  assert.deepEqual(Object.keys(on.data.queue), ['@nileblue|ai']);
  assert.equal(on.data.queue['@nileblue|ai'].v, 0, 'latest vote wins (withdrawn)');
});

test('on a channel page, the canonical UC id is remembered and voted too', async () => {
  const s = fakeStorage({ sync: { enabled: true, server: 'https://x.test' } });
  const p = youtubePage('<div id="body">channel page</div>', s, 'https://www.youtube.com/@NileBlue');
  const link = p.window.document.createElement('link');
  link.rel = 'canonical'; link.href = 'https://www.youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz';
  p.window.document.head.append(link);
  await wait(50);
  await p.menu('body', 'ai');
  assert.equal(s.data.marks['@nileblue'].uc, 'UCzzzzzzzzzzzzzzzzzzzzzz');
  assert.deepEqual(Object.keys(s.data.queue).sort(), ['@nileblue|ai', 'UCzzzzzzzzzzzzzzzzzzzzzz|ai']);
});

test('settings toggle the page classes', async () => {
  const s = fakeStorage({ settings: { badges: false, tint: true, dim: true } });
  const { window } = youtubePage(GRID, s);
  await wait(100);
  const cl = window.document.documentElement.classList;
  assert.equal(cl.contains('argus-badges'), false);
  assert.equal(cl.contains('argus-dim'), true);
  await s.local.set({ settings: { badges: true, tint: false, dim: false } });
  assert.equal(cl.contains('argus-badges'), true);
  assert.equal(cl.contains('argus-tint'), false);
});
