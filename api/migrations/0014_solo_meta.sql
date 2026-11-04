-- The solo meta-game: per-outlaw medals and challenges, the Daily Outlaw and its board, and the
-- guest purse's one-time migration into an account (meta-game stream).
--
-- 1. The ledger gains four kinds: `medal`, `challenge`, `daily_outlaw` and `guest_migration`.
--    SQLite can't alter a CHECK, so the ledger is rebuilt exactly as 0011/0012 did: every row
--    copied unchanged with its id, the AUTOINCREMENT high-water mark carried over, the indexes
--    recreated.
-- 2. `profiles.solo_xp`: XP earned in single player (it lowers the Outfitter's level gates).
-- 3. `outlaw_marks`: each account's server-judged medal tier and challenge per outlaw.
-- 4. `daily_runs`: one row per Daily Outlaw attempt (the session registry and the board).
-- 5. `guest_migrations`: the audit row for the once-per-account guest purse credit.
--
-- Deploy order: apply this before the Worker that books the new kinds.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE ledger_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  -- Must equal profiles.purse right after this row's batch step.
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'start_grant', 'gauntlet_clear', 'duel_win', 'duel_loss', 'duel_draw', 'duel_froze',
      'ghost_win', 'ghost_royalty', 'ffa_kill_mint', 'ffa_deposit', 'ffa_strongbox',
      'ffa_commission', 'store_purchase', 'level_reward', 'admin_adjust', 'dye_job',
      'name_change', 'house_round', 'medal', 'challenge', 'daily_outlaw', 'guest_migration'
    )
  ),
  ref TEXT,
  idem_key TEXT NOT NULL UNIQUE,
  batch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (delta != 0 OR xp != 0),
  -- A guest migration is a credit, bounded by GUEST_CAP (data/medals.ts).
  CHECK (kind != 'guest_migration' OR (delta BETWEEN 0 AND 750 AND xp <= 2000))
);

INSERT INTO ledger_next (id, account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
SELECT id, account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at
FROM ledger ORDER BY id;

UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'ledger'), 0))
WHERE name = 'ledger_next';

DROP TABLE ledger;
ALTER TABLE ledger_next RENAME TO ledger;
CREATE INDEX ledger_account ON ledger (account_id, id);
CREATE INDEX ledger_account_kind ON ledger (account_id, kind, created_at);
CREATE INDEX ledger_batch ON ledger (batch);

-- XP from single player since the last prestige (reset with it). Never more than xp's lifetime.
ALTER TABLE profiles ADD COLUMN solo_xp INTEGER NOT NULL DEFAULT 0 CHECK (solo_xp >= 0);

-- Each account's medals and challenges, written only from server-judged ranked wins (and the
-- claim route, for hat shots, against a win recorded here within 15 minutes).
CREATE TABLE outlaw_marks (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  outlaw INTEGER NOT NULL CHECK (outlaw BETWEEN 0 AND 16),
  -- 0 none, 1 bronze, 2 silver, 3 gold.
  tier INTEGER NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 3),
  best_ms INTEGER CHECK (best_ms IS NULL OR best_ms > 0),
  challenge INTEGER NOT NULL DEFAULT 0 CHECK (challenge IN (0, 1)),
  -- The last ranked run that won this duel, and when (the hat-shot claim's proof).
  last_run TEXT,
  last_win_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, outlaw)
);

-- One row per Daily Outlaw attempt. Created when the session is issued (outcome NULL), settled by
-- the DailySession. Guests have no account: their attempts count against the client hash.
CREATE TABLE daily_runs (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL CHECK (length(day) = 10),
  account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  name TEXT,
  client_hash TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'coward', 'void')),
  reaction_ms INTEGER CHECK (reaction_ms IS NULL OR reaction_ms > 0),
  flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX daily_runs_board ON daily_runs (day, outcome, reaction_ms);
CREATE INDEX daily_runs_account ON daily_runs (account_id, day);
CREATE INDEX daily_runs_client ON daily_runs (client_hash, day);

-- The guest purse migrated into an account, once (the ledger row carries the money; this is the
-- audit trail of what the device claimed against what was granted).
CREATE TABLE guest_migrations (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  claimed_xp INTEGER NOT NULL CHECK (claimed_xp >= 0),
  claimed_cash INTEGER NOT NULL CHECK (claimed_cash >= 0),
  xp INTEGER NOT NULL CHECK (xp BETWEEN 0 AND 2000),
  cash INTEGER NOT NULL CHECK (cash BETWEEN 0 AND 750),
  claim TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
