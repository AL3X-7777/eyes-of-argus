-- Eyes of Argus — D1 (SQLite) schema, version 2.
-- A database created by an older version is upgraded automatically by the Worker
-- (see server/src/schema.js); this file is for new databases.

-- Anonymous installs (deleted with all their votes by POST /forget).
-- id = first 32 hex chars of sha256(secret); the secret never gets stored.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  reg_net    TEXT              -- salted hash of the network it registered from (caps same-network votes)
);

-- One row per user, channel and category. Changing a vote overwrites; withdrawing deletes.
CREATE TABLE IF NOT EXISTS votes (
  user_id     TEXT    NOT NULL,
  channel_key TEXT    NOT NULL,                  -- "@handle", "UC…", "x:handle", "site:example.com", …
  flag        TEXT    NOT NULL,                  -- category id: 'ai', 'pe' or one added in the dashboard
  value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_key, flag)
);
CREATE INDEX IF NOT EXISTS votes_by_channel ON votes (channel_key);

-- One row per channel/account/site that has votes or a moderator override. Recalculated
-- by the scheduled job for rows marked dirty; the published list is built from these rows.
CREATE TABLE IF NOT EXISTS channels (
  key        TEXT PRIMARY KEY,
  name       TEXT,                            -- first name a voter sent; shown in the dashboard only
  entry      TEXT,                            -- published AI/PE entry as JSON, NULL = neither shown
  extra      TEXT,                            -- published entry for other categories as JSON, NULL = none shown
  tally      TEXT,                            -- {"<category>": [yes, no, shown]} for the dashboard
  votes      INTEGER NOT NULL DEFAULT 0,      -- number of votes, for sorting in the dashboard
  shown      INTEGER NOT NULL DEFAULT 0,      -- 1 when entry or extra is set
  dirty      INTEGER NOT NULL DEFAULT 1,
  recheck_at INTEGER NOT NULL DEFAULT 0,      -- when a vote from a still-new install starts to count (0 = none)
  rev        INTEGER NOT NULL DEFAULT 0,      -- bumped on every vote; a recount only clears dirty if unchanged
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS channels_dirty ON channels (dirty) WHERE dirty = 1;
CREATE INDEX IF NOT EXISTS channels_recheck ON channels (recheck_at) WHERE recheck_at > 0;
CREATE INDEX IF NOT EXISTS channels_shown ON channels (key) WHERE shown = 1;

-- Moderator decisions from the dashboard. value: 1 = always show, 0 = never show.
CREATE TABLE IF NOT EXISTS overrides (
  key   TEXT NOT NULL,
  flag  TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (0, 1)),
  note  TEXT,
  PRIMARY KEY (key, flag)
);

-- Categories added in the dashboard ('ai' and 'pe' are built in and not stored here).
CREATE TABLE IF NOT EXISTS categories (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL,      -- badge text
  title TEXT NOT NULL,      -- completes "Mark as …"
  color TEXT NOT NULL,      -- "#rrggbb"
  pos   INTEGER NOT NULL DEFAULT 0
);

-- Vote rules changed in the dashboard (minVotes, notFactor, warmupDays, maxPerNet).
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Daily counters for rate limits (old days are cleaned up by the scheduled job).
CREATE TABLE IF NOT EXISTS limits (
  bucket TEXT PRIMARY KEY,
  day    INTEGER NOT NULL,
  n      INTEGER NOT NULL
);

-- Small flags. 'stale' = 1 while the published list in KV is older than the channel rows;
-- 'schema' = version of this layout.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', 2);
