-- Bounty Hunt (stream B): matches, Bounty Hunt stats, ghosts and pair diminishing returns.
-- Account-scoped tables cascade on account deletion; `matches` is anonymised instead
-- (see api/src/duel/stats.ts, accountDeletionStatements).

-- A ranked gauntlet run may be attached to a signed-in account (optional; guests stay NULL).
ALTER TABLE sessions ADD COLUMN account_id TEXT;

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('pvp', 'ghost', 'town')),
  -- Seat 0 and seat 1. NULLed when the account is deleted. b_id is NULL for ghost duels.
  a_id TEXT,
  b_id TEXT,
  -- The ghost's owner (ghost duels); NULL for a Town Outlaw or after deletion.
  ghost_of TEXT,
  -- 'a', 'b' or NULL (draw, froze, double dead heat).
  winner TEXT CHECK (winner IS NULL OR winner IN ('a', 'b')),
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'coward', 'forfeit', 'dodge', 'draw', 'froze')),
  a_ms INTEGER,
  b_ms INTEGER,
  a_rtt INTEGER,
  b_rtt INTEGER,
  dead_heats INTEGER NOT NULL DEFAULT 0,
  a_delta INTEGER NOT NULL,
  b_delta INTEGER,
  a_xp INTEGER NOT NULL,
  b_xp INTEGER,
  pair_factor REAL NOT NULL CHECK (pair_factor BETWEEN 0 AND 1),
  -- bit 0 rtt-capped, bit 1 rough trail, bit 2 suspicious timing
  flags INTEGER NOT NULL DEFAULT 0,
  -- 0 for a queue match, 1..5 for rematches in the same room
  rematch INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at)
);
CREATE INDEX matches_a ON matches (a_id, ended_at);
CREATE INDEX matches_b ON matches (b_id, ended_at);

-- Bounty Hunt standing per account (the wallet itself lives in stream C's `profiles`).
CREATE TABLE duel_stats (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  -- Public cowardice tally.
  cowardice INTEGER NOT NULL DEFAULT 0,
  -- Hidden draw rating: median of the last 30 judged reactions (JSON array in `recent`).
  draw_rating INTEGER NOT NULL DEFAULT 260,
  recent TEXT NOT NULL DEFAULT '[]',
  -- JSON array of recent dodge timestamps (3 in 10 minutes → 5-minute cooldown).
  dodges TEXT NOT NULL DEFAULT '[]',
  -- UTC day of the last paid win (first win of the day bonus).
  last_win_day TEXT,
  -- Ghost-duel cash wins today (paid wins stop after 30 a day).
  ghost_wins_day TEXT,
  ghost_wins_today INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- A player's ghost: the decayed nerves plus a poster snapshot. Samples live in ghost_samples.
CREATE TABLE ghost_profiles (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  level INTEGER NOT NULL,
  prestige INTEGER NOT NULL DEFAULT 0,
  draw_rating INTEGER NOT NULL DEFAULT 260,
  loadout TEXT NOT NULL DEFAULT '{}',
  -- Counts halved every 100 duels.
  duels REAL NOT NULL DEFAULT 0,
  froze REAL NOT NULL DEFAULT 0,
  fakes_seen REAL NOT NULL DEFAULT 0,
  fake_cowards REAL NOT NULL DEFAULT 0,
  wait_cowards REAL NOT NULL DEFAULT 0,
  wait_seconds REAL NOT NULL DEFAULT 0,
  -- Number of rows in ghost_samples (capped at 40).
  samples INTEGER NOT NULL DEFAULT 0,
  royalties_day TEXT,
  royalties_today INTEGER NOT NULL DEFAULT 0,
  -- "Let my ghost ride" switched off: never served, and deleted (see setGhostOptOutStatements).
  opt_out INTEGER NOT NULL DEFAULT 0,
  -- Timing statistics look automated: never served.
  flagged INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ghost_profiles_pick ON ghost_profiles (level, draw_rating);

-- Ring buffer (last 40) of judged reactions per player, from PvP, ghost duels and ranked runs.
CREATE TABLE ghost_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  ms INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('pvp', 'ghost', 'ranked')),
  created_at INTEGER NOT NULL
);
CREATE INDEX ghost_samples_account ON ghost_samples (account_id, id);

-- Pair diminishing returns: the pair's recent match times (rolling 24 h), lower id first.
CREATE TABLE pair_stats (
  a_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- JSON array of ended_at timestamps within the last 24 h.
  recent TEXT NOT NULL DEFAULT '[]',
  last_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
