// QA: security probes against the sync server (local `wrangler dev`).
// Tests whose name starts with "BUG Qn" assert the DESIRED behaviour and fail while the bug exists.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { fakeStorage, loadBackground, startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(8793); });
after(() => srv?.stop());

const sha = s => createHash('sha256').update(s).digest('hex');
const zeroBits = h => { let b = 0; for (const c of h) { const v = parseInt(c, 16); if (!v) { b += 4; continue; } return b + Math.clz32(v) - 28; } return b; };
const raw = (p, init) => fetch(srv.url + p, init).then(async r => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const post = (p, body, headers = {}) => raw(p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const recount = () => fetch(srv.url + '/cdn-cgi/handler/scheduled');
const snapshot = async () => (await (await fetch(srv.url + '/snapshot.json')).json()).c;
const age = () => srv.sql('UPDATE users SET created_at = 0');

function solve(secret) {
  const id = sha(secret).slice(0, 32);
  let n = 0;
  while (zeroBits(sha(`${id}:${n}`)) < 10) n++;
  return String(n);
}
async function newUser(headers) {
  const secret = randomBytes(32).toString('hex');
  const r = await post('/register', { secret, nonce: solve(secret) }, headers);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return secret;
}

test('QA gate: only extension origins (or none) with a JSON content type may POST; odd methods are refused', async () => {
  const s = await newUser();
  const vote = { secret: s, votes: [{ k: '@gate', f: 'ai', v: 1 }] };
  for (const origin of ['https://evil.example', 'null', 'http://localhost', 'https://chrome-extension.evil.example', 'chrome-extension:evil', 'file://']) {
    assert.equal((await post('/votes', vote, { origin })).status, 403, origin);
    assert.equal((await post('/register', vote, { origin })).status, 403, origin);
    assert.equal((await post('/forget', vote, { origin })).status, 403, origin);
    assert.equal((await post('/admin/rebuild', {}, { origin, authorization: 'Bearer test-admin' })).status, 403, origin);
  }
  for (const origin of ['chrome-extension://abcdefghijklmnop', 'moz-extension://1-2-3']) assert.equal((await post('/votes', vote, { origin })).status, 200, origin);
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
    assert.equal((await post('/votes', vote, { 'content-type': ct })).status, 415, ct);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await raw('/votes', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(vote) })).status, 404, method);
  assert.equal((await raw('/votes')).status, 404);
  const pre = await fetch(srv.url + '/votes', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.doesNotMatch(pre.headers.get('access-control-allow-methods') || '', /POST/);
  assert.doesNotMatch(pre.headers.get('access-control-allow-headers') || '', /content-type/i);
});

test('QA auth: malformed bodies, secrets, nonces and the admin endpoint', async () => {
  for (const body of ['null', '[]', '1', '"x"', '{}', '{"votes":{}}', '{"secret":["a"],"votes":[1]}', '{"secret":{"$ne":1},"votes":[{"k":"@a","f":"ai","v":1}]}']) {
    const r = await post('/votes', body);
    assert.ok([400, 401].includes(r.status), `${body} → ${r.status}`);
    assert.ok([200, 400].includes((await post('/register', body)).status));
    assert.equal((await post('/forget', body)).body?.deleted, false, body);
  }
  assert.equal((await post('/votes', '{bad')).status, 400);
  const secret = randomBytes(32).toString('hex');
  for (const nonce of [null, [], {}, '', 'x'.repeat(33), -1, 1e99, true]) {
    const r = await post('/register', { secret, nonce });
    assert.equal(r.status, 400, JSON.stringify(nonce));
  }
  assert.equal((await post('/register', { secret: secret.toUpperCase(), nonce: solve(secret) })).status, 400);
  assert.equal((await post('/votes', { secret: sha(secret).slice(0, 32), votes: [{ k: '@a', f: 'ai', v: 1 }] })).status, 401); // the public id is not a credential
  for (const authorization of ['', 'Bearer', 'Bearer ', 'Bearer wrong', 'test-admin', 'bearer test-admin', 'Bearer test-admin x', 'Basic dGVzdC1hZG1pbg==']) {
    assert.equal((await raw('/admin/rebuild', { method: 'POST', headers: authorization ? { authorization } : {} })).status, 403, authorization);
  }
  assert.equal((await raw('/admin/rebuild', { headers: { authorization: 'Bearer test-admin' } })).status, 404); // GET
  assert.equal((await raw('/admin/rebuild', { method: 'POST', headers: { authorization: 'Bearer test-admin' } })).status, 200);
});

test('QA injection: hostile keys, flags, values and names never reach SQL or the snapshot unescaped', async () => {
  const users = [await newUser(), await newUser()];
  age();
  const evilName = `Robert'); DROP TABLE votes;-- "<img src=x onerror=alert(1)>`;
  const bad = [
    { k: `site:a.com'; DROP TABLE votes;--`, f: 'ai', v: 1 }, { k: `x:a' OR '1'='1`, f: 'ai', v: 1 }, { k: 'reddit:u/a"b', f: 'ai', v: 1 },
    { k: '__proto__', f: 'ai', v: 1 }, { k: 'constructor', f: 'ai', v: 1 }, { k: 'site:a.com', f: '__proto__', v: 1 }, { k: 'site:a.com', f: `ai' --`, v: 1 },
    { k: 'site:a.com', f: 'ai', v: '1' }, { k: 'site:a.com', f: 'ai', v: 1.5 }, { k: 'site:a.com', f: 'ai', v: null }, { k: ['site:a.com'], f: 'ai', v: 1 },
    { k: { toString: 'x' }, f: 'ai', v: 1 }, { k: 'site:' + 'a'.repeat(200) + '.com', f: 'ai', v: 1 }, { k: 'site:1.2.3.4', f: 'ai', v: 1 }, null, 5, 'x', [],
  ];
  assert.equal((await post('/votes', { secret: users[0], votes: bad })).status, 400, 'none of these is a valid vote');
  for (const s of users) {
    const r = await post('/votes', { secret: s, votes: [
      { k: 'SITE:Example.COM', f: 'ai', v: 1, name: evilName }, { k: 'reddit:U/Spez_1', f: 'pe', v: 1, name: { a: 1 } },
      { k: 'reddit:r/Pics', f: 'ai', v: 1, name: 'x'.repeat(5000) }, { k: 'x:NASA', f: 'ai', v: 1 }, { k: 'facebook:4', f: 'ai', v: 1 }, ...bad] });
    assert.deepEqual(r.body, { ok: true, accepted: 5 });
  }
  await recount();
  const c = await snapshot();
  assert.deepEqual(Object.keys(c).sort(), ['facebook:4', 'reddit:r/pics', 'reddit:u/spez_1', 'site:example.com', 'x:nasa']);
  assert.equal(c['site:example.com'][4], ''); // voter-supplied names are never published (Q11)
  assert.equal(c['reddit:r/pics'][4], '');
  assert.deepEqual(c['x:nasa'].slice(0, 4), [100, 2, 0, 0]);
  // the extension accepts exactly these keys from the list, and drops forged ones
  const st = fakeStorage({});
  const bg = loadBackground(st);
  const realFetch = bg.ctx.fetch;
  bg.ctx.fetch = async (u, o) => (String(u).endsWith('/snapshot.json')
    ? new Response(JSON.stringify({ c: { ...c, '__proto__x': [1, 1, 0, 0], 'X:NASA': [100, 9, 0, 0], 'site:evil.com/': [100, 9, 0, 0], '@ok': [100, 2, 0, 0, 'n', 7], '@neg': [-1, 2, 0, 0], '@str': '[1,1,0,0]' } }))
    : realFetch(u, o));
  await bg.ask({ type: 'argus-sync-config', enabled: true, server: srv.url });
  await bg.ask({ type: 'argus-sync-now' });
  assert.deepEqual(Object.keys(st.data.community.c).sort(), Object.keys(c).sort());
  await bg.ask({ type: 'argus-sync-config', enabled: false, withdraw: true });
});

test('QA sizes: batches over 100 votes and bodies over 64 KB are refused', async () => {
  const s = await newUser();
  const many = Array.from({ length: 101 }, (_, i) => ({ k: `@u${i}`, f: 'ai', v: 1 }));
  assert.equal((await post('/votes', { secret: s, votes: many })).status, 400);
  assert.equal((await post('/votes', { secret: s, votes: [{ k: '@big', f: 'ai', v: 1, name: 'x'.repeat(70000) }] })).status, 413);
  const deep = '['.repeat(20000) + ']'.repeat(20000);
  assert.ok([400, 401].includes((await post('/votes', `{"secret":"${s}","votes":${deep}}`)).status));
});

test('BUG Q13: the 64 KB body limit counts bytes, also without a Content-Length header', async () => {
  const s = await newUser();
  const text = JSON.stringify({ secret: s, votes: [{ k: '@big', f: 'ai', v: 1, name: '€'.repeat(60000) }] }); // 60k chars, ~180 KB
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  const r = await fetch(srv.url + '/votes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal(r.status, 413);
});

test('QA vote stuffing: installs of one network count at most twice per channel; a new install has no weight', async () => {
  const users = [];
  for (let i = 0; i < 6; i++) users.push(await newUser());
  age();
  const young = await newUser();
  for (const s of [...users, young]) await post('/votes', { secret: s, votes: [{ k: 'site:stuffed.example', f: 'ai', v: 1 }, { k: 'site:stuffed.example', f: 'ai', v: 1 }] });
  await post('/votes', { secret: young, votes: [{ k: 'site:young-only.example', f: 'pe', v: 1 }] });
  await recount();
  const c = await snapshot();
  assert.deepEqual(c['site:stuffed.example'].slice(0, 4), [100, 2, 0, 0]);
  assert.equal(c['site:young-only.example'], undefined);
  // a "not" vote from the same network cannot be multiplied either
  for (const s of users.slice(2)) await post('/votes', { secret: s, votes: [{ k: 'site:stuffed.example', f: 'ai', v: -1 }] });
  await recount();
  assert.deepEqual((await snapshot())['site:stuffed.example'].slice(0, 4), [100, 2, 0, 0]);
});

test('QA forget / replace: need the secret, remove everything, and old credentials stop working', async () => {
  const a = await newUser(), b = await newUser();
  age();
  for (const s of [a, b]) await post('/votes', { secret: s, votes: [{ k: 'tiktok:keep.me', f: 'ai', v: 1 }, { k: 'twitch:gone', f: 'pe', v: 1 }] });
  await recount();
  assert.ok((await snapshot())['twitch:gone']);
  assert.equal((await post('/forget', { secret: randomBytes(32).toString('hex') })).body.deleted, false);
  assert.equal((await post('/forget', { secret: sha(a).slice(0, 32) })).body.deleted, false);
  assert.equal((await post('/votes', { secret: a, replace: 'true', votes: [] })).status, 400);
  assert.equal((await post('/votes', { secret: a, replace: true, votes: [{ k: 'tiktok:keep.me', f: 'ai', v: 1 }] })).status, 200);
  await recount();
  let c = await snapshot();
  assert.equal(c['twitch:gone'], undefined);
  assert.ok(c['tiktok:keep.me']);
  assert.equal((await post('/forget', { secret: b })).body.deleted, true);
  assert.equal((await post('/votes', { secret: b, votes: [{ k: 'tiktok:keep.me', f: 'ai', v: 1 }] })).status, 401);
  await recount();
  c = await snapshot();
  assert.equal(c['tiktok:keep.me'], undefined);
});

test('BUG Q11: an install with no weight cannot choose the public name of a channel', async () => {
  const troll = await newUser(); // brand new: zero weight
  await post('/votes', { secret: troll, votes: [{ k: 'site:victim.example', f: 'ai', v: -1, name: 'SCAM - visit evil.example' }] });
  const honest = [await newUser(), await newUser()];
  srv.sql(`UPDATE users SET created_at = 0 WHERE id != '${sha(troll).slice(0, 32)}'`);
  for (const s of honest) await post('/votes', { secret: s, votes: [{ k: 'site:victim.example', f: 'ai', v: 1, name: 'victim.example' }] });
  await recount();
  assert.equal((await snapshot())['site:victim.example'][4], '', 'voter-supplied names are never published');
});

test('QA rate limit: the per-install daily limit holds across batches, replace and re-registration', async () => {
  const s = await newUser();
  const batch = n => Array.from({ length: 100 }, (_, i) => ({ k: `@rl${n}x${i}`, f: 'ai', v: 1 }));
  for (let n = 0; n < 10; n++) assert.equal((await post('/votes', { secret: s, votes: batch(n) })).status, 200, `batch ${n}`);
  assert.equal((await post('/votes', { secret: s, votes: batch(10) })).status, 429);
  assert.equal((await post('/votes', { secret: s, replace: true, votes: [] })).status, 429);
  assert.equal((await post('/votes', { secret: s, votes: [{ k: '@one', f: 'ai', v: 0 }] })).status, 429);
  // forget + register again with the same secret and the same (replayed) nonce: still limited
  assert.equal((await post('/forget', { secret: s })).body.deleted, true);
  assert.equal((await post('/register', { secret: s, nonce: solve(s) })).status, 200);
  assert.equal((await post('/votes', { secret: s, votes: [{ k: '@one', f: 'ai', v: 1 }] })).status, 429);
});
