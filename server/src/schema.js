/**
 * @file Database layout checks and the automatic upgrade from version 1 (v0.5) to
 * version 2 (extendable categories, dashboard rules). Runs inside the Worker, so
 * deploying the new code is all an existing server needs.
 */
import { A, cleanRules } from './lib.js';

/** Statements that turn a version 1 database into version 2 (one transaction). */
const UPGRADE_V2 = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)',
  // votes: same data, without the old "flag must be ai or pe" check
  `CREATE TABLE votes_v2 (user_id TEXT NOT NULL, channel_key TEXT NOT NULL, flag TEXT NOT NULL,
     value INTEGER NOT NULL CHECK (value IN (-1, 1)), updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, channel_key, flag))`,
  'INSERT INTO votes_v2 SELECT user_id, channel_key, flag, value, updated_at FROM votes',
  'DROP TABLE votes',
  'ALTER TABLE votes_v2 RENAME TO votes',
  'CREATE INDEX IF NOT EXISTS votes_by_channel ON votes (channel_key)',
  // overrides: one row per category instead of one column per category
  `CREATE TABLE overrides_v2 (key TEXT NOT NULL, flag TEXT NOT NULL, value INTEGER NOT NULL CHECK (value IN (0, 1)),
     note TEXT, PRIMARY KEY (key, flag))`,
  "INSERT INTO overrides_v2 SELECT key, 'ai', ai, note FROM overrides WHERE ai IN (0, 1)",
  "INSERT INTO overrides_v2 SELECT key, 'pe', pe, note FROM overrides WHERE pe IN (0, 1)",
  'DROP TABLE overrides',
  'ALTER TABLE overrides_v2 RENAME TO overrides',
  // channels only holds results calculated from the votes: rebuild it and recount everything
  'DROP TABLE channels',
  `CREATE TABLE channels (key TEXT PRIMARY KEY, name TEXT, entry TEXT, extra TEXT, tally TEXT,
     votes INTEGER NOT NULL DEFAULT 0, shown INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1,
     recheck_at INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX channels_dirty ON channels (dirty) WHERE dirty = 1',
  'CREATE INDEX channels_recheck ON channels (recheck_at) WHERE recheck_at > 0',
  'CREATE INDEX channels_shown ON channels (key) WHERE shown = 1',
  'INSERT OR IGNORE INTO channels (key, dirty, rev) SELECT DISTINCT channel_key, 1, 1 FROM votes',
  'INSERT OR IGNORE INTO channels (key, dirty, rev) SELECT DISTINCT key, 1, 1 FROM overrides',
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, label TEXT NOT NULL, title TEXT NOT NULL,
     color TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0)`,
  'CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  "INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', 2)",
  "INSERT OR REPLACE INTO meta (k, v) VALUES ('stale', 1)",
];

let checked = false;

/**
 * Makes sure the database has the current layout, upgrading an older one in place.
 * Costs one small query the first time each Worker instance handles a request.
 * @param {Object} env
 */
export async function ensureSchema(env) {
  if (checked) return;
  let version = 0;
  try {
    version = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'schema'").first())?.v || 1;
  } catch { version = 1; } // no meta table yet: a version 1 database
  if (version < 2) await env.DB.batch(UPGRADE_V2.map(sql => env.DB.prepare(sql)));
  checked = true;
}

let cache = null;

/**
 * The vote rules and the category list (cached for 30 seconds per Worker instance).
 * @param {Object} env
 * @param {boolean} [fresh] skip the cache (after a change in the dashboard)
 * @returns {Promise<{rules: Object, cats: Array<Object>, ids: string[], extra: Array<Object>}>}
 *   `cats` = built-in plus added categories, `ids` = their ids, `extra` = only the added ones
 */
export async function loadState(env, fresh) {
  if (!fresh && cache && Date.now() - cache.at < 30000) return cache.state;
  const [settings, categories] = await env.DB.batch([
    env.DB.prepare('SELECT k, v FROM settings'),
    env.DB.prepare('SELECT id, label, title, color FROM categories ORDER BY pos, id'),
  ]);
  const cats = A.normalizeCategories(categories.results);
  const state = {
    rules: cleanRules(Object.fromEntries(settings.results.map(r => [r.k, r.v]))),
    cats,
    ids: cats.map(c => c.id),
    extra: cats.slice(A.DEFAULT_CATEGORIES.length),
  };
  cache = { at: Date.now(), state };
  return state;
}
