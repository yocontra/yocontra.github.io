-- Stream C: the wallet (profiles), the append-only ledger and the cosmetic inventory.
-- Every money movement is one db.batch of ledger rows plus the purse update (api/src/economy/ledger.ts).
-- Bounty Hunt stats (streak, wins, rating) live in stream B's duel_stats (0005); FFA stats in 0006.
-- accounts(id) comes from stream A's 0003.

CREATE TABLE profiles (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 50),
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  prestige INTEGER NOT NULL DEFAULT 0 CHECK (prestige BETWEEN 0 AND 5),
  -- An overdraft fails the whole batch.
  purse INTEGER NOT NULL DEFAULT 0 CHECK (purse >= 0),
  -- JSON Loadout (data/catalog.ts), validated against inventory on write.
  loadout TEXT NOT NULL,
  -- 17-bit mask of gauntlet outlaws first-cleared while signed in.
  gauntlet_clears INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Append-only. Rows are removed only with the account (cascade).
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  -- Must equal profiles.purse right after this row's batch step.
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'start_grant', 'gauntlet_clear', 'duel_win', 'duel_loss', 'ghost_win', 'ghost_royalty',
      'ffa_kill_mint', 'ffa_deposit', 'ffa_strongbox', 'ffa_commission', 'store_purchase',
      'level_reward', 'admin_adjust'
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
CREATE INDEX ledger_account ON ledger (account_id, id);
CREATE INDEX ledger_account_kind ON ledger (account_id, kind, created_at);

CREATE TABLE inventory (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  dye TEXT,
  source TEXT NOT NULL CHECK (source IN ('starter', 'store', 'reward', 'admin')),
  -- The ledger idem key of the purchase, if bought.
  ref TEXT,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, item_id)
);
