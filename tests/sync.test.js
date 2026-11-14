// Sync server + background sync, end to end against a local `wrangler dev`.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { fakeStorage, loadBackground, startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(8790); });
after(() => srv?.stop());

const sha = s => createHash('sha256').update(s).digest('hex');
const zeroBits = h => { let b = 0; for (const c of h) { const v = parseInt(c, 16); if (!v) { b += 4; continue; } return b + Math.clz32(v) - 28; } return b; };
const post = (p, body, headers = {}) =>
  fetch(srv.url + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const recount = () => fetch(srv.url + '/cdn-cgi/handler/scheduled');
const snapshot = async () => (await (await fetch(srv.url + '/snapshot.json')).json()).c;

async function newUser() {
  const secret = randomBytes(32).toString('hex');
  const id = sha(secret).slice(0, 32);
  let n = 0;
  while (zeroBits(sha(`${id}:${n}`)) < 10) n++;
  const r = await post('/register', { secret, nonce: String(n) });
  assert.equal(r.status, 200);
  return secret;
}

test('registration requires a valid proof of work', async () => {
  assert.equal((await post('/register', { secret: 'a'.repeat(64), nonce: 'x' })).status, 400);
  assert.equal((await post('/register', { secret: 'nothex', nonce: '1' })).status, 400);
});

test('unknown users cannot vote; invalid votes are dropped', async () => {
  assert.equal((await post('/votes', { secret: 'b'.repeat(64), votes: [{ k: '@x', f: 'ai', v: 1 }] })).status, 401);
  const s = await newUser();
  const r = await post('/votes', { secret: s, votes: [{ k: 'bad key', f: 'ai', v: 1 }, { k: '@ok', f: 'zz', v: 1 }, { k: '@ok', f: 'ai', v: 5 }] });
  assert.equal(r.status, 400);
});

test('votes are counted with weights, thresholds and overrides', async () => {
  const users = [await newUser(), await newUser(), await newUser()];
  for (const s of users) {
    await post('/votes', { secret: s, votes: [{ k: '@Slop', f: 'ai', v: 1, name: 'Slop' }, { k: '@split', f: 'ai', v: 1 }] });
  }
  await recount();
  assert.deepEqual(await snapshot(), {}, 'brand-new users count 1/4 and do not reach the threshold');

  srv.sql('UPDATE users SET created_at = 0');
  await post('/votes', { secret: users[0], votes: [{ k: '@split', f: 'ai', v: -1 }] });
  await post('/votes', { secret: users[1], votes: [{ k: '@split', f: 'ai', v: 0 }] });
  const r = await post('/admin/rebuild', {}, { authorization: 'Bearer test-admin' });
  assert.equal(r.status, 200);
  const c = await snapshot();
  assert.deepEqual(c['@slop'], [100, 2, 0, 0, ''], 'N10: 3 votes from one network, 2 count; Q11: names are not published');
  assert.equal(c['@split'], undefined, '1 yes / 1 no stays hidden');

  srv.sql("INSERT INTO overrides VALUES ('@slop', 'ai', 0, 'test')");
  await post('/admin/rebuild', {}, { authorization: 'Bearer test-admin' });
  assert.equal((await snapshot())['@slop'], undefined, 'override hides it');
  srv.sql('DELETE FROM overrides');
});

test('admin endpoint needs the token; snapshot supports ETag', async () => {
  assert.equal((await post('/admin/rebuild', {})).status, 403);
  const r = await fetch(srv.url + '/snapshot.json');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(srv.url + '/snapshot.json', { headers: { 'if-none-match': etag } })).status, 304);
});

test('background: registers, sends queued votes, downloads the list, keeps votes while offline', async () => {
  const storage = fakeStorage({
    sync: { enabled: true, server: srv.url },
    queue: { '@bg|ai': { k: '@bg', f: 'ai', v: 1, name: 'BG', t: 1 } },
  });
  const { ask } = loadBackground(storage);
  const ok = await ask({ type: 'argus-sync-now' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.sent, 1);
  assert.deepEqual(storage.data.queue, {});
  assert.ok(storage.data.identity.id);
  assert.ok(storage.data.community);

  await storage.local.set({ sync: { enabled: true, server: 'http://127.0.0.1:9' }, queue: { '@bg|pe': { k: '@bg', f: 'pe', v: 1, t: 2 } } });
  const off = await ask({ type: 'argus-sync-now' });
  assert.equal(off.ok, false);
  assert.deepEqual(Object.keys(storage.data.queue), ['@bg|pe'], 'vote stays queued offline');

  await storage.local.set({ sync: { enabled: true, server: srv.url } });
  const back = await ask({ type: 'argus-sync-now' });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.deepEqual(storage.data.queue, {});
});

// ----- regression tests for the review findings -----

test('F2: web pages and non-JSON bodies are refused; big bodies too', async () => {
  const s = await newUser();
  const body = { secret: s, votes: [{ k: '@x', f: 'ai', v: 1 }] };
  assert.equal((await post('/votes', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/votes', body, { origin: 'moz-extension://abc' })).status, 200);
  const plain = await fetch(srv.url + '/votes', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  assert.equal(plain.status, 415);
  assert.equal((await post('/votes', { secret: s, votes: [], pad: 'x'.repeat(70000) })).status, 413);
});

test('F3: more channels than one chunk are all recounted; replace and forget work', async () => {
  const a = await newUser(), b = await newUser();
  const keys = Array.from({ length: 150 }, (_, i) => `@bulk${i}`);
  for (const s of [a, b]) {
    for (let i = 0; i < keys.length; i += 100) {
      assert.equal((await post('/votes', { secret: s, votes: keys.slice(i, i + 100).map(k => ({ k, f: 'pe', v: 1 })) })).status, 200);
    }
  }
  srv.sql('UPDATE users SET created_at = 0');
  await recount();
  let c = await snapshot();
  assert.equal(keys.filter(k => c[k]).length, 150);

  await post('/votes', { secret: a, replace: true, votes: [] }); // a now has no votes
  await post('/forget', { secret: b });
  await recount();
  c = await snapshot();
  assert.equal(keys.filter(k => c[k]).length, 0);
  assert.equal((await post('/votes', { secret: b, votes: [{ k: '@x', f: 'ai', v: 1 }] })).status, 401, 'forgotten install is gone');
});

test('F5: a rejected vote batch is dropped and the community list still downloads', async () => {
  const storage = fakeStorage({ sync: { enabled: true, server: srv.url }, queue: { 'bad|ai': { k: 'bad', f: 'ai', v: 1, t: 1 } } });
  const { ask } = loadBackground(storage);
  const r = await ask({ type: 'argus-sync-now' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(storage.data.queue, {});
  assert.ok(storage.data.communityMeta);
});

test('N1: votes from new installs are counted once their warm-up ends, without new votes', async () => {
  const a = await newUser(), b = await newUser();
  for (const s of [a, b]) await post('/votes', { secret: s, votes: [{ k: '@warmup', f: 'ai', v: 1 }] });
  await recount();
  assert.equal((await snapshot())['@warmup'], undefined, 'still warming up');
  await recount();
  assert.equal((await snapshot())['@warmup'], undefined, 'not rechecked early');
  srv.sql('UPDATE users SET created_at = 0; UPDATE channels SET recheck_at = 1 WHERE recheck_at > 0'); // time passes
  await recount();
  assert.deepEqual((await snapshot())['@warmup'], [100, 2, 0, 0, '']);
});

test('admin dashboard: page is served safely; API needs the token; hide, auto and delete votes work', async () => {
  const pageRes = await fetch(srv.url + '/admin');
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(pageRes.headers.get('x-frame-options'), 'DENY');
  const admin = { authorization: 'Bearer test-admin' };
  assert.equal((await fetch(srv.url + '/admin/api/channels')).status, 403);
  assert.equal((await post('/admin/api/override', { key: '@x', set: { ai: 0 } }, { authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await post('/admin/api/override', { key: '@x', set: { ai: 0 } }, { ...admin, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/admin/api/override', { key: 'not a key', set: { ai: 0 } }, admin)).status, 400);
  assert.equal((await post('/admin/api/override', { key: '@x', set: { nope: 0 } }, admin)).status, 400);

  const a = await newUser(), b = await newUser();
  srv.sql('UPDATE users SET created_at = 0');
  for (const s of [a, b]) await post('/votes', { secret: s, votes: [{ k: 'site:moderated.example', f: 'ai', v: 1 }] });
  await recount();
  assert.ok((await snapshot())['site:moderated.example']);
  const listed = await (await fetch(srv.url + '/admin/api/channels?q=moderated&shown=1', { headers: admin })).json();
  assert.equal(listed.channels[0].key, 'site:moderated.example');
  assert.equal(listed.channels[0].flags.ai.shown, true);
  assert.equal(listed.channels[0].flags.ai.yes, 2);

  assert.equal((await post('/admin/api/override', { key: 'site:moderated.example', set: { ai: 0 } }, admin)).status, 200);
  assert.equal((await snapshot())['site:moderated.example'], undefined, 'hidden immediately');
  await post('/admin/api/override', { key: 'site:moderated.example', set: { ai: null } }, admin);
  assert.ok((await snapshot())['site:moderated.example'], '"Auto" lets the votes decide again');
  await post('/admin/api/purge', { key: 'site:moderated.example' }, admin);
  assert.equal((await snapshot())['site:moderated.example'], undefined, 'votes deleted');
});

test('vote rules: one vote marks by default; "not" votes need more than twice the yes votes; rules are editable', async () => {
  const admin = { authorization: 'Bearer test-admin' };
  const before = (await (await fetch(srv.url + '/admin/api/state', { headers: admin })).json()).rules;
  assert.equal((await post('/admin/api/rules', { minVotes: 1, notFactor: 2, warmupDays: 0, maxPerNet: 100 }, admin)).status, 200);
  try {
    const u = [];
    for (let i = 0; i < 7; i++) u.push(await newUser());
    const vote = (s, v) => post('/votes', { secret: s, votes: [{ k: 'site:rules.example', f: 'ai', v }] });
    const shown = async () => { await recount(); return !!(await snapshot())['site:rules.example']; };

    await vote(u[0], 1);
    assert.equal(await shown(), true, 'a single vote marks');
    await vote(u[1], 1);
    for (const s of u.slice(2, 6)) await vote(s, -1); // 2 yes, 4 not
    assert.equal(await shown(), true, '4 "not" votes are not enough against 2 yes votes');
    await vote(u[6], -1); // 2 yes, 5 not
    assert.equal(await shown(), false, '5 "not" votes remove a mark with 2 yes votes');

    assert.equal((await post('/admin/api/rules', { minVotes: 0, notFactor: 'x' }, admin)).status, 200);
    const now = (await (await fetch(srv.url + '/admin/api/state', { headers: admin })).json()).rules;
    assert.deepEqual([now.minVotes, now.notFactor], [1, 2], 'out-of-range values fall back to the defaults');
    assert.equal((await post('/admin/api/rules', { minVotes: 3 })).status, 403);
  } finally {
    await post('/admin/api/rules', before, admin);
  }
});

test('categories: added in the dashboard, voted on, published separately, removed with their votes', async () => {
  const admin = { authorization: 'Bearer test-admin' };
  const s = await newUser(), s2 = await newUser();
  srv.sql('UPDATE users SET created_at = 0');
  const vote = sec => post('/votes', { secret: sec, votes: [{ k: 'site:cats.example', f: 'sponsored', v: 1 }] });
  assert.equal((await vote(s)).status, 400, 'unknown categories are refused');
  for (const bad of [{ id: 'ai', label: 'X', color: '#000000' }, { id: 'notgood', label: 'X', color: '#000000' }, { id: 'ok', label: 'X', color: 'red' }, { id: 'name', label: 'X', color: '#000000' }]) {
    assert.equal((await post('/admin/api/category', bad, admin)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post('/admin/api/category', { id: 'Sponsored', label: 'AD', title: 'sponsored content', color: '#16A34A' }, admin)).status, 200);
  for (const sec of [s, s2]) assert.equal((await vote(sec)).status, 200);
  await recount();
  const full = await (await fetch(srv.url + '/snapshot.json')).json();
  assert.deepEqual(full.cats, [{ id: 'sponsored', label: 'AD', title: 'sponsored content', color: '#16a34a' }]);
  assert.deepEqual(full.x['site:cats.example'], { sponsored: [100, 2] });
  assert.equal(full.c['site:cats.example'], undefined, 'older extensions only see AI/PE entries');

  assert.equal((await post('/admin/api/category/delete', { id: 'ai' }, admin)).status, 400);
  assert.equal((await post('/admin/api/category/delete', { id: 'sponsored' }, admin)).status, 200);
  const after = await (await fetch(srv.url + '/snapshot.json')).json();
  assert.deepEqual(after.cats, []);
  assert.equal(after.x['site:cats.example'], undefined);
  assert.equal((await vote(s)).status, 400);
});
