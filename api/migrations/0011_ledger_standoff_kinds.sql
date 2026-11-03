-- Stream B (with C's ledger): XP-only ledger kinds for a Bounty Hunt standoff with no winner.
-- `duel_draw` is a dead heat that was never broken, `duel_froze` is both players freezing. Until now
-- both were booked as `duel_win` with $0, so the hub ledger called them "Bounty Hunt win".
--
-- SQLite can't alter a CHECK constraint, so the ledger is rebuilt: same columns, same constraints
-- plus the two kinds, same indexes. Every row is copied with its id, amounts, balances, keys and
-- timestamps unchanged (so the audit and every idempotency key still hold). The only data change is
-- the kind of the old standoff rows, found exactly: a $0 `duel_win` whose ref is a match that ended
-- 'draw' or 'froze'. In such a match every seat's entry is the standoff entry (no streak, daily or
-- bounty rows exist for it). No table references `ledger`, so the drop and rename are safe.
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
      'ffa_commission', 'store_purchase', 'level_reward', 'admin_adjust'
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
SELECT l.id, l.account_id, l.delta, l.xp, l.balance_after,
  CASE
    WHEN l.kind = 'duel_win' AND l.delta = 0 AND m.outcome = 'froze' THEN 'duel_froze'
    WHEN l.kind = 'duel_win' AND l.delta = 0 AND m.outcome = 'draw' THEN 'duel_draw'
    ELSE l.kind
  END,
  l.ref, l.idem_key, l.batch, l.created_at
FROM ledger l LEFT JOIN matches m ON m.id = l.ref
ORDER BY l.id;

-- AUTOINCREMENT never reuses an id, even one whose row was deleted with its account. The copy only
-- advanced the new table's sequence to the highest surviving id, so carry the old high-water mark.
UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'ledger'), 0))
WHERE name = 'ledger_next';

DROP TABLE ledger;
ALTER TABLE ledger_next RENAME TO ledger;
CREATE INDEX ledger_account ON ledger (account_id, id);
CREATE INDEX ledger_account_kind ON ledger (account_id, kind, created_at);
