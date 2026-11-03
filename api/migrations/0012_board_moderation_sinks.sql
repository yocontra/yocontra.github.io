-- Economy and moderation follow-ups (stream C/B with the audit): the monthly Most Wanted board,
-- the shared money sinks (dye jobs, name changes, "buy the house a round"), and moderation
-- (reports, blocks, the Badlands log, held names).
--
-- 1. The ledger gains three debit kinds: `dye_job`, `name_change` and `house_round`. SQLite can't
--    alter a CHECK, so the ledger is rebuilt exactly as 0011 did: every row copied unchanged with
--    its id, and the AUTOINCREMENT high-water mark carried over. A `batch` index is added so the
--    monthly earnings roll-up (written by ledgerStatements in the same batch) finds its rows.
-- 2. `earnings_monthly` is the Most Wanted board: gross server-booked earnings per account per UTC
--    month. It is backfilled from the existing ledger.
--
-- Deploy order: apply this before the Worker that books the new kinds or writes the roll-up.

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
      'name_change', 'house_round'
    )
  ),
  -- Match id, lobby deposit seq, item id.
  ref TEXT,
  -- e.g. match:<id>#0, ffa:<lobby>:<acct>:<seq>#1, buy:<acct>:<item>#0.
  idem_key TEXT NOT NULL UNIQUE,
  -- Random per ledgerStatements() call; gates the purse update so a replay is a no-op.
  batch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (delta != 0 OR xp != 0)
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

-- The monthly Most Wanted board: gross earnings (credits of the EARNING_KINDS in
-- contract/economy.ts) per account per UTC month ('YYYY-MM'). Written only by ledgerStatements,
-- in the same batch as the ledger rows, so it can never disagree with the ledger.
CREATE TABLE earnings_monthly (
  month TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  earned INTEGER NOT NULL CHECK (earned >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (month, account_id)
);
CREATE INDEX earnings_monthly_rank ON earnings_monthly (month, earned DESC);

INSERT INTO earnings_monthly (month, account_id, earned, updated_at)
SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch'), account_id, SUM(delta), MAX(created_at)
FROM ledger
WHERE delta > 0 AND kind IN (
  'duel_win', 'ghost_win', 'ghost_royalty', 'ffa_deposit', 'ffa_commission', 'ffa_strongbox',
  'gauntlet_clear', 'level_reward'
)
GROUP BY 1, 2;

-- A closed month's top 10, frozen at rollover (names as they were then). The account link is
-- dropped on deletion; the row stays as history.
CREATE TABLE most_wanted_winners (
  month TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
  account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  earned INTEGER NOT NULL,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (month, rank)
);
CREATE INDEX most_wanted_winners_account ON most_wanted_winners (account_id, month);

-- "Buy the house a round": the saloon chalkboard.
CREATE TABLE house_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  -- The ledger idempotency key of the debit, so a replay can't write a second line.
  idem_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX house_rounds_recent ON house_rounds (created_at);

-- Names an account gave up when it changed its name: held for that account for 30 days, so
-- nobody can impersonate it straight away (and the owner can change back).
CREATE TABLE name_holds (
  name_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  released_at INTEGER NOT NULL
);
CREATE INDEX name_holds_account ON name_holds (account_id);

-- Every name change, for moderation and the 30-day cooldown.
CREATE TABLE name_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX name_changes_account ON name_changes (account_id, created_at);

-- Blocks: never matched together (Bounty Hunt queue, ghosts, Frontier call-outs).
CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id)
);
CREATE INDEX blocks_blocked ON blocks (blocked_id);

-- Player reports. One per reporter, target and UTC day.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('name', 'cheating', 'abuse')),
  -- A match id or lobby id the report is about, if any.
  context TEXT,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_id, target_id, day)
);
CREATE INDEX reports_target ON reports (target_id, created_at);

-- Every automatic or manual change to accounts.flags, with its evidence.
CREATE TABLE moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- The bits set (accounts.flags: 1 badlands, 2 banned, 4 reported).
  flags INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('reports', 'timing', 'aimbot', 'ranked', 'admin')),
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX moderation_log_account ON moderation_log (account_id, created_at);

-- "While you were away": the last time the player dismissed the hub's passive-earnings notice.
ALTER TABLE profiles ADD COLUMN away_seen_at INTEGER;

-- A one-row guard for conditional batches: `INSERT INTO batch_guard (ok) VALUES (changes())` right
-- after a guarded UPDATE fails its CHECK (and so the whole batch) unless exactly one row changed.
-- The row is deleted again in the same batch, so the table stays empty.
CREATE TABLE batch_guard (ok INTEGER NOT NULL CHECK (ok = 1));
