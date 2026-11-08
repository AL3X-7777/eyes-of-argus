-- The Eyes of Argus — D1 (SQLite) schema

-- Anonymous installs (deleted with all their votes by POST /forget). id = first 32 hex chars of sha256(secret); the secret never gets stored.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  reg_net    TEXT              -- salted hash of the network it registered from (caps same-network votes)
);

-- One row per user, channel and flag. Changing a vote overwrites; withdrawing deletes.
CREATE TABLE IF NOT EXISTS votes (
  user_id     TEXT    NOT NULL,
  channel_key TEXT    NOT NULL,                  -- "@handle" (lowercase) or "UC…" channel id
  flag        TEXT    NOT NULL CHECK (flag IN ('ai', 'pe')),
  value       INTEGER NOT NULL CHECK (value IN (-1, 1)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_key, flag)
);
CREATE INDEX IF NOT EXISTS votes_by_channel ON votes (channel_key);

-- Tallies, recalculated by the scheduled job for channels marked dirty.
CREATE TABLE IF NOT EXISTS channels (
  key        TEXT PRIMARY KEY,
  name       TEXT,
  ai_pct     INTEGER NOT NULL DEFAULT 0,
  ai_n       INTEGER NOT NULL DEFAULT 0,
  pe_pct     INTEGER NOT NULL DEFAULT 0,
  pe_n       INTEGER NOT NULL DEFAULT 0,
  dirty      INTEGER NOT NULL DEFAULT 1,
  rev        INTEGER NOT NULL DEFAULT 0,      -- bumped on every vote; a recount only clears dirty if unchanged
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS channels_dirty ON channels (dirty);

-- Your manual decisions. ai/pe: 1 = always show, 0 = never show, NULL = let votes decide.
-- Edit with:  npx wrangler d1 execute argus --remote --command "INSERT OR REPLACE INTO overrides VALUES ('@x', NULL, 0, 'disputed')"
CREATE TABLE IF NOT EXISTS overrides (
  key  TEXT PRIMARY KEY,
  ai   INTEGER,
  pe   INTEGER,
  note TEXT
);

-- Daily counters for rate limits (old days are cleaned up by the scheduled job).
CREATE TABLE IF NOT EXISTS limits (
  bucket TEXT PRIMARY KEY,
  day    INTEGER NOT NULL,
  n      INTEGER NOT NULL
);
