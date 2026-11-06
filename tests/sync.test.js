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
  assert.deepEqual(c['@slop'], [100, 3, 0, 0, 'Slop']);
  assert.equal(c['@split'], undefined, '1 yes / 1 no stays hidden');

  srv.sql("INSERT INTO overrides VALUES ('@slop', 0, NULL, 'test')");
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
