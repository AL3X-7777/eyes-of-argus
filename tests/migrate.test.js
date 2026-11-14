// A database created by v0.5 (schema version 1) is upgraded in place by the new Worker.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer(8795, { schema: '../tests/fixtures/schema-v1.sql', rules: null, prepare: sql => {
    sql("INSERT INTO users (id, created_at, reg_net) VALUES ('u1', 0, 'n1'), ('u2', 0, 'n2')");
    sql("INSERT INTO votes VALUES ('u1', '@old', 'ai', 1, 1), ('u2', '@old', 'ai', 1, 1), ('u1', '@hidden', 'pe', 1, 1), ('u1', 'site:forced.example', 'ai', -1, 1)");
    sql("INSERT INTO channels (key, name, ai_pct, ai_n, dirty) VALUES ('@old', 'Old', 100, 2, 0)");
    sql("INSERT INTO overrides VALUES ('@hidden', NULL, 0, 'dispute'), ('site:forced.example', 1, NULL, 'manual')");
  } });
});
after(() => srv?.stop());

test('v1 database: votes and overrides survive the upgrade and new categories work afterwards', async () => {
  const admin = { authorization: 'Bearer test-admin', 'content-type': 'application/json' };
  const state = await (await fetch(srv.url + '/admin/api/state', { headers: admin })).json();
  assert.deepEqual(state.rules, { minVotes: 1, notFactor: 2, warmupDays: 0, maxPerNet: 2 });
  await fetch(srv.url + '/cdn-cgi/handler/scheduled');
  const snap = await (await fetch(srv.url + '/snapshot.json')).json();
  assert.deepEqual(snap.c['@old'], [100, 2, 0, 0, '']);
  assert.equal(snap.c['@hidden'], undefined, 'the "never show" override was kept');
  assert.deepEqual(snap.c['site:forced.example'], [100, 1, 0, 0, '', 1], 'the "always show" override was kept');
  const r = await fetch(srv.url + '/admin/api/category', { method: 'POST', headers: admin, body: JSON.stringify({ id: 'spam', label: 'SPAM', title: 'spam', color: '#dc2626' }) });
  assert.equal(r.status, 200, 'the old "ai or pe only" restriction is gone');
});
