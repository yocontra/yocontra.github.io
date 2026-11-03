-- Stream F: Frontier FFA. Money itself moves only through the ledger (0004); these tables are the
-- audit trail and stats around it. Rows cascade with the profile (and so with the account).

-- One row per lobby visit. XP, kills and deaths are flushed every 60 s and on leave.
CREATE TABLE ffa_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES profiles (account_id) ON DELETE CASCADE,
  lobby_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  deaths INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  dead_eye_kills INTEGER NOT NULL DEFAULT 0,
  showdown_wins INTEGER NOT NULL DEFAULT 0,
  -- Dollars banked this visit (deposit + commission).
  banked INTEGER NOT NULL DEFAULT 0 CHECK (banked >= 0),
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  shots INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  -- bit 0 aimbot heuristic, bit 1 input flooding (§3.7). Flags are reviewed, never auto-banned.
  flags INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ffa_sessions_account ON ffa_sessions (account_id, joined_at);

-- Every deposit, written in the same batch as its ledger rows. The idempotency key is the
-- ledger's (ffa:<lobby>:<session>:<seq>), so a retried flush can't double-bank.
CREATE TABLE ffa_deposits (
  idem_key TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES profiles (account_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  lobby_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  commission INTEGER NOT NULL DEFAULT 0 CHECK (commission >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX ffa_deposits_account ON ffa_deposits (account_id, created_at);

-- Per lobby per UTC day: occupancy and the money printed and burned (economy audit, §5).
CREATE TABLE ffa_lobby_stats (
  lobby_id TEXT NOT NULL,
  day TEXT NOT NULL,
  occupied_seconds INTEGER NOT NULL DEFAULT 0,
  peak_humans INTEGER NOT NULL DEFAULT 0,
  messages_in INTEGER NOT NULL DEFAULT 0,
  minted INTEGER NOT NULL DEFAULT 0,
  burned INTEGER NOT NULL DEFAULT 0,
  deposited INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lobby_id, day)
);
