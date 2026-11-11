// Other platforms and search results: key extraction, badges and right-click resolution.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeStorage, youtubePage: page, loadBackground, wait } = require('./helpers');

test('Google: a result is marked by its website; the badge sits on the title', async () => {
  const html = `<div id="search">
    <div class="MjjYud" id="r1"><a href="https://www.example.com/article?x=1" id="a1"><h3 id="h1">Example title</h3><cite>example.com</cite></a><span id="snip1">snippet</span></div>
    <div class="MjjYud" id="r2"><a href="/url?q=https://blog.other.org/post&sa=U" id="a2"><h3 id="h2">Other</h3></a></div>
    <div class="MjjYud" id="r3"><a href="https://www.google.com/search?q=more" id="a3"><h3 id="h3">More results</h3></a></div>
    <a href="https://example.com/" id="plain">sitelink without title</a></div>`;
  const s = fakeStorage({ marks: { 'site:other.org': { ai: 1, pe: 0 } } });
  const p = page(html, s, 'https://www.google.com/search?q=test');
  await p.menu('snip1', 'ai'); // right-click the snippet: the card's result
  assert.equal(s.data.marks['site:example.com'].ai, 1);
  assert.equal(s.data.marks['site:example.com'].name, 'example.com');
  await p.menu('h2', 'pe');
  assert.equal(s.data.marks['site:blog.other.org'].pe, 1, 'redirect link unwrapped; subdomain kept');
  await wait(300);
  assert.equal(p.$('h1').dataset.argus, 'ai');
  assert.equal(p.$('r1').dataset.argusCard, 'ai');
  assert.equal(p.$('h2').dataset.argus, 'pe');
  assert.equal(p.$('plain').dataset.argus, undefined);
  await p.menu('h3', 'ai');
  assert.equal(s.data.marks['site:google.com'], undefined, 'links back to the search engine are not results');
});

test('Google: a result for a channel or profile uses that account\'s mark, never the whole platform', async () => {
  const s = fakeStorage({ marks: { '@nileblue': { ai: 1, pe: 0 }, 'site:youtube.com': { ai: 0, pe: 1 }, 'site:example.com': { ai: 1, pe: 0 } } });
  const g = page('<div class="g"><a href="https://www.youtube.com/@NileBlue" id="a"><h3 id="h">NileBlue</h3></a></div>', s, 'https://www.google.de/search?q=x');
  await wait(300);
  assert.equal(g.$('h').dataset.argus, 'ai', 'the channel mark shows, not a mark for all of YouTube');
  const y = page('<ytd-rich-item-renderer><a href="/@NileBlue" id="n">NileBlue</a><a href="https://example.com/" id="e">example</a></ytd-rich-item-renderer>', s);
  await wait(300);
  assert.equal(y.$('n').dataset.argus, 'ai');
  assert.equal(y.$('e').dataset.argus, undefined, 'website marks stay on search pages');
});

test('X: author links are badged, reserved paths ignored, profile page fallback', async () => {
  const html = `<article id="t1"><div data-testid="User-Name"><a href="/SomeUser" id="n1">Some User</a><a href="/SomeUser" id="n2">@SomeUser</a>
      <a href="/SomeUser/status/123" id="time">2h</a></div><div id="text">hello <a href="/Mentioned" id="m">@Mentioned</a></div></article>
    <a href="/home" id="home">Home</a><div id="empty">x</div>`;
  const s = fakeStorage({ marks: { 'x:someuser': { ai: 1, pe: 0 } } });
  const p = page(html, s, 'https://x.com/ProfileOwner');
  await wait(300);
  assert.equal(p.$('n2').dataset.argus, 'ai');
  assert.equal(p.$('time').dataset.argus, undefined);
  assert.equal(p.$('t1').dataset.argusCard, 'ai');
  await p.menu('text', 'pe'); // anywhere in the post → its author
  assert.equal(s.data.marks['x:someuser'].pe, 1);
  await p.menu('m', 'ai'); // a mention can be marked directly
  assert.equal(s.data.marks['x:mentioned'].ai, 1);
  await p.menu('home', 'ai');
  assert.equal(s.data.marks['x:home'], undefined);
  await p.menu('empty', 'ai'); // empty spot on a profile page → that profile
  assert.equal(s.data.marks['x:profileowner'].ai, 1);
});

test('Reddit: users and subreddits are separate keys; cards are not guessed', async () => {
  const html = `<shreddit-post id="post"><a href="/r/AskReddit/" id="sub">r/AskReddit</a><a href="/user/Some_One/" id="u">u/Some_One</a>
    <a href="/r/AskReddit/comments/abc/title/" id="title">A post</a><p id="body">text</p></shreddit-post>`;
  const s = fakeStorage();
  const p = page(html, s, 'https://www.reddit.com/');
  await p.menu('u', 'ai');
  await p.menu('sub', 'pe');
  await p.menu('body', 'ai');
  await p.menu('title', 'ai');
  assert.deepEqual(Object.keys(s.data.marks).sort(), ['reddit:r/askreddit', 'reddit:u/some_one']);
  await wait(300);
  assert.equal(p.$('u').dataset.argus, 'ai');
  assert.equal(p.$('sub').dataset.argus, 'pe');
  assert.equal(p.$('title').dataset.argus, undefined);
});

test('Instagram, TikTok, Twitch, Facebook, Bing and DuckDuckGo extract the right keys', async () => {
  const cases = [
    ['https://www.instagram.com/', '<a href="/some.user/" id="a">some.user</a><a href="/explore/" id="b">Explore</a><a href="/p/Cxyz/" id="c">post</a>', 'instagram:some.user'],
    ['https://www.tiktok.com/foryou', '<a href="/@Some.User" id="a">Some.User</a><a href="/@some.user/video/1" id="b">v</a><a href="/tag/x" id="c">t</a>', 'tiktok:some.user'],
    ['https://www.twitch.tv/', '<a href="/SomeStreamer" id="a">SomeStreamer</a><a href="/directory" id="b">Browse</a><a href="/somestreamer/clip/abc" id="c">clip</a>', 'twitch:somestreamer'],
    ['https://www.facebook.com/', '<a href="https://www.facebook.com/profile.php?id=10001234&ref=x" id="a">Someone</a><a href="/marketplace/" id="b">Marketplace</a><a href="https://l.facebook.com/l.php?u=x" id="c">out</a>', 'facebook:10001234'],
    ['https://www.bing.com/search?q=x', '<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly93d3cuZXhhbXBsZS5jb20vcGFnZQ&ntb=1" id="a">Example</a></h2></li></ol><a href="/images" id="b">Images</a><a href="https://www.bing.com/ck/a?u=zz" id="c">bad</a>', 'site:example.com'],
    ['https://duckduckgo.com/?q=x', '<article><a data-testid="result-title-a" href="https://example.com/x" id="a">Example</a></article><a href="/settings" id="b">Settings</a><a href="javascript:void(0)" id="c">js</a>', 'site:example.com'],
  ];
  for (const [url, html, expected] of cases) {
    const s = fakeStorage();
    const p = page(html, s, url);
    await p.menu('b', 'ai');
    await p.menu('c', 'ai');
    assert.equal(s.data.marks, undefined, `${url}: non-account links are ignored`);
    await p.menu('a', 'ai');
    assert.deepEqual(Object.keys(s.data.marks), [expected], url);
    await wait(300);
    assert.equal(p.$('a').dataset.argus, 'ai', url);
  }
});

test('any other website (badges everywhere): outbound links are keyed by where they point', async () => {
  const s = fakeStorage({ marks: { 'site:example.com': { ai: 1, pe: 1 }, 'x:nasa': { ai: 1, pe: 0 }, 'site:blog.example': { pe: 1, ai: 0 } } });
  const p = page(`<a href="https://www.example.com/page" id="a">Example</a><a href="https://x.com/NASA" id="b">NASA</a>
    <a href="/about" id="own">About us</a><a href="https://blog.example/other" id="own2">Home</a>
    <a href="https://t.co/abc" id="short">short link</a><a href="https://fresh.example/x" id="new">Fresh</a><p id="empty">text</p>`, s, 'https://blog.example/post');
  await wait(300);
  assert.equal(p.$('a').dataset.argus, 'ai pe');
  assert.equal(p.$('b').dataset.argus, 'ai');
  assert.equal(p.$('own').dataset.argus, undefined);
  assert.equal(p.$('own2').dataset.argus, undefined, 'a marked site does not badge its own links');
  await p.menu('new', 'pe');
  assert.equal(s.data.marks['site:fresh.example'].pe, 1);
  await p.menu('short', 'ai');
  assert.equal(s.data.marks['site:t.co'], undefined, 'link shorteners are not websites');
  await p.menu('empty', 'ai'); // empty spot → the site you are on
  assert.equal(s.data.marks['site:blog.example'].ai, 1);
});

test('built-in sites: a link that leaves the site can be marked by where it points', async () => {
  const s = fakeStorage();
  const p = page(`<ytd-rich-item-renderer><a href="/@Chan" id="n">Chan</a><a href="https://shop.example/merch" id="out">Merch</a>
    <a href="https://www.instagram.com/some.user/" id="ig">Instagram</a></ytd-rich-item-renderer>`, s);
  await p.menu('out', 'pe');
  await p.menu('ig', 'ai');
  assert.deepEqual(Object.keys(s.data.marks).sort(), ['instagram:some.user', 'site:shop.example']);
});

test('pages without the content script: the background marks from the link or page address', async () => {
  const s = fakeStorage();
  const bg = loadBackground(s);
  bg.api.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist'); };
  const click = bg.api.contextMenus.onClicked.fns[0];
  click({ menuItemId: 'ai', frameId: 0, linkUrl: 'https://www.news.example/story', pageUrl: 'https://forum.example/t/1' }, { id: 1 });
  click({ menuItemId: 'pe', frameId: 0, pageUrl: 'https://forum.example/t/1' }, { id: 1 });
  click({ menuItemId: 'ai', frameId: 0, linkUrl: 'https://www.youtube.com/@Some_Channel/videos', pageUrl: 'https://forum.example/' }, { id: 1 });
  click({ menuItemId: 'ai', frameId: 0, linkUrl: 'https://www.youtube.com/watch?v=abc' }, { id: 1 });
  click({ menuItemId: 'ai', frameId: 2, pageUrl: 'https://ads.example/frame' }, { id: 1 });
  click({ menuItemId: 'ai', frameId: 0, linkUrl: 'javascript:alert(1)' }, { id: 1 });
  await wait(150);
  assert.deepEqual(Object.keys(s.data.marks).sort(), ['@some_channel', 'site:forum.example', 'site:news.example']);
  assert.equal(s.data.marks['site:forum.example'].pe, 1);
});

test('"badges on every website" registers and unregisters the content script', async () => {
  const s = fakeStorage();
  const bg = loadBackground(s);
  assert.equal((await bg.ask({ type: 'argus-everywhere', on: true })).ok, true);
  assert.equal(bg.api.scripting.registered.length, 1);
  assert.equal(bg.api.scripting.registered[0].matches.join(), 'https://*/*');
  assert.equal(s.data.everywhere, true);
  await bg.ask({ type: 'argus-everywhere', on: false });
  assert.equal(bg.api.scripting.registered.length, 0);
  assert.equal(s.data.everywhere, false);
  bg.api.permissions.contains = async () => false;
  assert.equal((await bg.ask({ type: 'argus-everywhere', on: true })).ok, false, 'refused without the permission');
});
