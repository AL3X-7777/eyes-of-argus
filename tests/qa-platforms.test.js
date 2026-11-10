// QA: adversarial tests for src/platforms.js, src/shared.js and src/content.js.
// Tests whose name starts with "BUG Qn" assert the DESIRED behaviour and fail while the bug exists.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeStorage, youtubePage, wait } = require('./helpers');

/** Loads the content scripts on `url` and returns helpers to probe the adapter directly. */
function probe(url, html = '', data = {}) {
  const p = youtubePage(html, fakeStorage(data), url);
  const site = p.window.ArgusPlatforms.forHost(p.window.location.hostname);
  const keyOf = href => {
    const a = p.window.document.createElement('a');
    a.setAttribute('href', href);
    return site.keyOf(a);
  };
  return { ...p, site, keyOf };
}
const table = (keyOf, rows) => { for (const [href, want] of rows) assert.equal(keyOf(href), want, `href ${JSON.stringify(href)}`); };

test('QA X: hostile and odd hrefs never give a wrong account', () => {
  const { keyOf } = probe('https://x.com/home');
  table(keyOf, [
    ['/nasa', 'x:nasa'], ['/NASA', 'x:nasa'], ['/nasa/', 'x:nasa'], ['/nasa?lang=en#top', 'x:nasa'],
    ['https://x.com/nasa', 'x:nasa'], ['HTTPS://X.COM/NASA', 'x:nasa'], ['//twitter.com/nasa', 'x:nasa'],
    ['https://mobile.twitter.com/nasa', 'x:nasa'], ['https://x.com:443/nasa', 'x:nasa'],
    ['//evil.com/nasa', null], ['https://evil.com/nasa', null], ['https://x.com@evil.com/nasa', null],
    ['https://x.com.evil.com/nasa', null], ['https://evilx.com/nasa', null], ['https://x.com./nasa', null],
    ['/\\evil.com/nasa', null], ['javascript:alert(1)//x.com/nasa', null], ['data:text/html,/nasa', null],
    ['nasa', null], ['#', null], ['', null], [' /nasa', null], ['/nasa/status/1', null], ['/home', null],
    ['/i/lists/1', null], ['/Search?q=a', null], ['/%6Easa', null], ['/nasa%00', null], ['/__proto__', 'x:__proto__'], // prefixed, so never a bare property name
    
    ['/constructor', 'x:constructor'], // a legal handle; must be handled as data, never as a property
    ['ftp://x.com/nasa', null], ['https://[::1]/nasa', null], ['https://1.2.3.4/nasa', null],
  ]);
});

test('QA Reddit / TikTok / Instagram / Twitch / Facebook: key extraction edge cases', () => {
  table(probe('https://www.reddit.com/').keyOf, [
    ['/user/Spez', 'reddit:u/spez'], ['/u/spez/', 'reddit:u/spez'], ['/r/AskReddit/', 'reddit:r/askreddit'],
    ['/r/askreddit/comments/abc/title/', null], ['https://old.reddit.com/r/pics', 'reddit:r/pics'],
    ['https://example.com/r/pics', null], ['https://reddit.com.evil.io/r/pics', null], ['/r/a', null],
    ['/user/ab', null], ['/r/pics%2F..', null],
  ]);
  table(probe('https://www.tiktok.com/').keyOf, [
    ['/@Nasa', 'tiktok:nasa'], ['/@nasa/video/123', null], ['https://www.tiktok.com/@nasa?lang=en', 'tiktok:nasa'],
    ['https://evil.com/@nasa', null], ['/@', null], ['/@a', null],
  ]);
  table(probe('https://www.instagram.com/').keyOf, [
    ['/nasa/', 'instagram:nasa'], ['/nasa/reels/', 'instagram:nasa'], ['/p/Cabc/', null], ['/nasa/p/Cabc/', null],
    ['/explore/tags/x/', null], ['/accounts/login/', null], ['https://l.instagram.com/?u=x', null],
  ]);
  table(probe('https://www.twitch.tv/').keyOf, [
    ['/Shroud', 'twitch:shroud'], ['/shroud/videos', 'twitch:shroud'], ['/videos/123', null],
    ['/directory/category/x', null], ['/shroud/clip/abc', null], ['/ab', null],
  ]);
  table(probe('https://www.facebook.com/').keyOf, [
    ['/zuck', 'facebook:zuck'], ['/profile.php?id=4', 'facebook:4'], ['/profile.php?id=4&sk=about', 'facebook:4'],
    ['/profile.php?id=abc', null], ['/profile.php', null], ['/groups/123', null], ['/zuck/posts/1', null],
    ['https://m.facebook.com/zuck', 'facebook:zuck'], ['https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.com', null],
    ['https://facebook.com.evil.com/zuck', null], ['/4', 'facebook:4'],
  ]);
});

test('BUG Q6: "." and ".." are not accounts', () => {
  const A = probe('https://www.instagram.com/').window.Argus;
  for (const k of ['instagram:..', 'instagram:.', 'facebook:..', 'tiktok:..']) assert.equal(A.normalizeKey(k), null, k);
  assert.equal(probe('https://www.instagram.com/').keyOf('/../explore/'), null);
});

test('BUG Q3: help/developer subdomains are not profile pages (right-click on empty space)', () => {
  for (const [url, wrong] of [
    ['https://help.x.com/en', 'x:en'], ['https://dev.twitch.tv/docs', 'twitch:docs'],
    ['https://developers.facebook.com/docs', 'facebook:docs'], ['https://about.instagram.com/blog', 'instagram:blog'],
    ['https://business.x.com/advertising', 'x:advertising'],
  ]) {
    const { site } = probe(url);
    assert.equal(site?.pageTarget()?.key ?? null, null, `${url} must not resolve to ${wrong}`);
  }
});

test('QA site keys: ports, userinfo, IDN, IPs, trailing dots, schemes', () => {
  const A = probe('https://www.google.com/search?q=a').window.Argus;
  const rows = [
    ['https://Example.COM/a', 'site:example.com'], ['http://www.example.com:8080/', 'site:example.com'],
    ['https://example.com./', 'site:example.com'], ['https://good.com@evil.com/', 'site:evil.com'],
    ['https://good.com%2F@evil.com/', 'site:evil.com'], ['https://evil.com/https://good.com', 'site:evil.com'],
    ['https://bücher.de/', 'site:xn--bcher-kva.de'], ['https://1.2.3.4/', null], ['https://[::1]/', null],
    ['https://0x7f.1/', null], ['http://localhost/', null], ['javascript:alert(1)', null],
    ['data:text/html,https://good.com', null], ['ftp://example.com/', null], ['//example.com/', null], ['', null],
    ['https://www.www.example.com/', 'site:www.example.com'], ['https://a.b.c.example.co.uk/', 'site:a.b.c.example.co.uk'],
  ];
  for (const [u, want] of rows) assert.equal(A.siteKey(u), want, u);
  for (const bad of ['site:', 'site:com', 'site:-a.com', 'site:a..com', 'site:a.com/x', 'site:a.com:80', 'site:a.c',
    'site:' + 'a'.repeat(64) + '.com', 'site:a.com\n', 'SITE:A.COM ', 'site:a.com|ai', 'nope:a.com', '__proto__:a', 'constructor:a.com']) {
    const got = A.normalizeKey(bad);
    if (bad === 'SITE:A.COM ' || bad === 'site:a.com\n') assert.equal(got, 'site:a.com'); // trimmed else assert.equal(got, null, JSON.stringify(bad));
  }
});

test('QA search engines: redirect links are unwrapped to the real site', () => {
  const g = probe('https://www.google.com/search?q=a');
  table(g.keyOf, [
    ['https://example.com/page', 'site:example.com'], ['/url?q=https://example.org/x&sa=U', 'site:example.org'],
    ['https://www.google.com/url?url=https%3A%2F%2Fexample.net%2F', 'site:example.net'],
    ['/url?q=javascript:alert(1)', null], ['/url?q=/search%3Fq%3Db', null], ['/url', null], ['/search?q=b', null],
    ['https://www.google.com/maps', null], ['javascript:void(0)', null], ['https://good.com@evil.com/', 'site:evil.com'],
    ['/url?q=https://good.com%40evil.com/', 'site:evil.com'],
  ]);
  const b = probe('https://www.bing.com/search?q=a');
  const enc = s => 'a1' + Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  table(b.keyOf, [
    [`https://www.bing.com/ck/a?!&&p=abc&u=${enc('https://example.com/a?b=c')}&ntb=1`, 'site:example.com'],
    [`https://www.bing.com/ck/a?u=${enc('javascript:alert(1)')}`, null], ['https://www.bing.com/ck/a?u=a1%%%', null],
    ['https://www.bing.com/ck/a?u=zz', null], ['https://www.bing.com/aclick?ld=x', null],
  ]);
  const d = probe('https://duckduckgo.com/?q=a');
  table(d.keyOf, [
    ['//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x', 'site:example.com'],
    ['/l/?uddg=javascript%3Aalert(1)', null], ['/l/', null], ['https://duckduckgo.com/y.js?ad_domain=shop.com', null],
  ]);
});

test('BUG Q5: only the real Google host is unwrapped (google.evil.example/url?q=… is evil, not q)', () => {
  const g = probe('https://www.google.com/search?q=a');
  assert.equal(g.keyOf('https://google.evil.example/url?q=https://good.com/'), 'site:google.evil.example');
});

test('QA marks do not leak between platforms; a mark only shows on its own site', async () => {
  const marks = { 'x:nasa': { ai: 1 }, 'instagram:nasa': { pe: 1 }, '@nasa': { ai: 1 }, 'site:nasa.gov': { ai: 1 }, 'twitch:nasa': { ai: 1 } };
  const ig = probe('https://www.instagram.com/', '<article id="c"><a id="a" href="/nasa/">nasa</a><a id="b" href="https://x.com/nasa">x</a></article>', { marks });
  await wait(450);
  assert.equal(ig.$('a').dataset.argus, 'pe');
  assert.equal(ig.$('b').dataset.argus, undefined);
  assert.equal(ig.$('c').dataset.argusCard, 'pe');
  const g = probe('https://www.google.com/search?q=a',
    '<div class="g"><a id="a" href="https://x.com/nasa"><h3 id="h">NASA on X</h3></a></div><div class="g"><a href="https://www.nasa.gov/"><h3 id="h2">NASA</h3></a></div>', { marks });
  await wait(450);
  assert.equal(g.$('h').dataset.argus, 'ai', 'a result for an X profile shows that account\'s mark (Q4)');
  assert.equal(g.$('h2').dataset.argus, 'ai');
});

test('BUG Q7: a mark with a UC id on a non-YouTube key must not badge or vote a YouTube channel', async () => {
  const UC = 'UC' + 'a'.repeat(22);
  const st = fakeStorage({ sync: { enabled: true, server: 'https://s.invalid' } });
  const p = youtubePage(`<a id="a" href="/channel/${UC}">Victim</a>`, st);
  const res = await p.bg.ask({ type: 'argus-import', mode: 'restore', data: { mine: { 'x:nasa': { ai: 1, uc: UC } } } });
  assert.equal(res.ok, true);
  await wait(450);
  assert.equal(st.data.marks['x:nasa'].uc, undefined);
  assert.equal(p.$('a').dataset.argus, undefined);
  assert.equal(Object.keys(st.data.queue).some(k => k.startsWith(UC)), false);
});

test('QA content: hostile names and community data are inert text; cleanup removes every attribute', async () => {
  const evil = '<img src=x onerror=alert(1)>"\'';
  const st = fakeStorage({
    marks: { '@a': { ai: 1, name: evil } },
    sync: { enabled: true, server: 'https://s.invalid' },
    community: { c: { '@b': [90, 20, 0, 0, evil, 3], '__proto__': [90, 20, 0, 0], '@c': ['90', 20, 0, 0] } },
  });
  const p = youtubePage('<ytd-video-renderer id="c"><a id="a" href="/@a">A</a></ytd-video-renderer><a id="b" href="/@b">B</a><a id="c2" href="/@c">C</a>', st);
  await wait(450);
  assert.equal(p.$('a').dataset.argus, 'ai');
  assert.equal(p.$('b').dataset.argus, 'ai');
  assert.match(p.$('b').title, /set by list maintainer/);
  assert.equal(p.window.document.querySelector('img'), null);
  assert.equal({}.polluted, undefined);
  await p.menu('a', 'ai');
  assert.equal(p.window.document.querySelector('#argus-toast img'), null);
  await st.local.set({ marks: {}, sync: { enabled: false } });
  await wait(450);
  assert.equal(p.window.document.querySelectorAll('[data-argus],[data-argus-card],[data-argus-title]').length, 0);
  assert.equal(p.$('b').hasAttribute('title'), false);
});

test('BUG Q9: the page\'s own title attribute survives a community badge', async () => {
  const st = fakeStorage({ sync: { enabled: true, server: 'https://s.invalid' }, community: { c: { '@b': [90, 20, 0, 0] } } });
  const p = youtubePage('<a id="b" href="/@b" title="Original tooltip">B</a>', st);
  await wait(450);
  await st.local.set({ sync: { enabled: false } });
  await wait(450);
  assert.equal(p.$('b').getAttribute('title'), 'Original tooltip');
});

test('BUG Q8: right-click inside a shadow root (new Reddit web components) resolves the link', async () => {
  const st = fakeStorage({});
  const p = youtubePage('<shreddit-post id="p"></shreddit-post>', st, 'https://www.reddit.com/');
  const root = p.$('p').attachShadow({ mode: 'open' });
  root.innerHTML = '<a href="/user/spez">spez</a>';
  root.querySelector('a').dispatchEvent(new p.window.MouseEvent('contextmenu', { bubbles: true, composed: true }));
  for (const f of p.api.runtime.onMessage.fns) f({ type: 'argus-menu', action: 'ai' });
  await wait(100);
  assert.equal(st.data.marks?.['reddit:u/spez']?.ai, 1);
});

test('QA right-click: stale targets, unknown actions and links to other hosts', async () => {
  const st = fakeStorage({});
  const p = youtubePage('<article id="c"><div data-testid="User-Name"><a id="a" href="/nasa">NASA</a></div><a id="o" href="https://t.co/x">link</a><a id="m" href="/esa">@esa</a></article><p id="out">x</p>', st, 'https://x.com/someone/status/1');
  for (const f of p.api.runtime.onMessage.fns) f({ type: 'argus-menu', action: 'ai' }); // no right-click before
  await wait(60);
  assert.deepEqual(st.data.marks ?? {}, {});
  await p.menu('a', '__proto__');
  await p.menu('a', 'constructor');
  assert.deepEqual(st.data.marks ?? {}, {});
  await p.menu('o', 'ai'); // outside link inside a post → the post's author
  assert.deepEqual(Object.keys(st.data.marks), ['x:nasa']);
  await p.menu('m', 'pe'); // an @mention link marks the mentioned account
  assert.equal(st.data.marks['x:esa'].pe, 1);
  await p.menu('out', 'pe'); // empty space → the account in the address
  assert.equal(st.data.marks['x:someone'].pe, 1);
});
