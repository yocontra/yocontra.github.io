/**
 * The ledger: the only way money or XP moves. Owned by stream C.
 *
 * `ledgerStatements()` returns D1 statements; the caller puts them in its own `env.DB.batch([...])`
 * next to its match or deposit rows, so the whole outcome commits or fails together.
 *
 * Guarantees, per entry `i` (idem key `<idemKey>#<i>`):
 * - **Idempotent.** The ledger row is inserted with `ON CONFLICT (idem_key) DO NOTHING`, and the
 *   purse/XP update is gated on a row with this call's random batch nonce existing. A replay of
 *   the same key inserts nothing and updates nothing: never a double credit, never an error.
 * - **No overdraft.** `balance_after` and `profiles.purse` both CHECK `>= 0`, so a debit the purse
 *   can't cover aborts the whole batch, including the caller's own rows.
 * - **Levels.** XP raises `profiles.level` from `LEVEL_THRESHOLDS` in SQL, and each level gained
 *   pays `$25 × level` as its own `level_reward` row, in the same batch.
 * - **Unknown account.** A missing profile makes `balance_after` NULL, which fails NOT NULL and
 *   aborts the batch, so money can never vanish silently.
 */
import {
  type LedgerKind as ContractLedgerKind,
  LEDGER_KINDS,
} from '../../../src/experiments/out-west/contract/economy.ts'
import { LEVEL_THRESHOLDS } from '../../../src/experiments/out-west/data/progression.ts'
import type { Env } from '../env.ts'

export type LedgerKind = ContractLedgerKind

export interface LedgerEntry {
  accountId: string
  kind: LedgerKind
  /** Whole dollars, as an integer. Credits are positive, debits negative. */
  amount: number
  /** Non-negative integer XP. */
  xp?: number
  /** Free-form reference, e.g. a match id or lobby id. */
  ref?: string
}

const THRESHOLDS_JSON = JSON.stringify(LEVEL_THRESHOLDS)

/** The level reached at `xpExpr`, as SQL. Binds THRESHOLDS_JSON at `?{param}`. */
const newLevelSql = (xpExpr: string, param: number): string =>
  `(SELECT COUNT(*) FROM json_each(?${param}) WHERE value <= ${xpExpr})`

/** $25 × each level gained, from `levelExpr` to `nl`, as SQL. */
const rewardSql = (nl: string, levelExpr: string): string =>
  `MAX(0, 25 * ((${nl} * (${nl} + 1)) / 2 - (${levelExpr} * (${levelExpr} + 1)) / 2))`

const INSERT_ENTRY = `INSERT INTO ledger
  (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
VALUES (?1, ?2, ?3,
  (SELECT CASE WHEN EXISTS (SELECT 1 FROM ledger WHERE idem_key = ?6) THEN 0 ELSE purse + ?2 END
     FROM profiles WHERE account_id = ?1),
  ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (idem_key) DO NOTHING`

const INSERT_LEVEL_REWARD = `WITH p AS (
  SELECT purse, level, ${newLevelSql('xp + ?3', 9)} AS nl FROM profiles WHERE account_id = ?1
), r AS (SELECT purse, ${rewardSql('nl', 'level')} AS reward FROM p)
INSERT INTO ledger (account_id, delta, xp, balance_after, kind, ref, idem_key, batch, created_at)
SELECT ?1, reward, 0, purse + ?2 + reward, 'level_reward', ?4, ?5, ?6, ?7 FROM r
WHERE reward > 0 AND EXISTS (SELECT 1 FROM ledger WHERE idem_key = ?8 AND batch = ?6)`

const NL = newLevelSql('xp + ?3', 7)
const UPDATE_PROFILE = `UPDATE profiles SET
  purse = purse + ?2 + ${rewardSql(NL, 'level')},
  xp = xp + ?3,
  level = MAX(level, ${NL}),
  version = version + 1,
  updated_at = ?4
WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM ledger WHERE idem_key = ?5 AND batch = ?6)`

function validate(entry: LedgerEntry): void {
  if (!(LEDGER_KINDS as readonly string[]).includes(entry.kind)) {
    throw new RangeError(`ledger: unknown kind ${String(entry.kind)}`)
  }
  if (!Number.isSafeInteger(entry.amount)) {
    throw new RangeError(`ledger: amount must be an integer, got ${entry.amount}`)
  }
  const xp = entry.xp ?? 0
  if (!Number.isSafeInteger(xp) || xp < 0) {
    throw new RangeError(`ledger: xp must be a non-negative integer, got ${xp}`)
  }
  if (entry.accountId === '') {
    throw new RangeError('ledger: missing accountId')
  }
}

/**
 * Returns D1 statements that apply the entries atomically. Each entry updates `profiles.purse`
 * (CHECK purse >= 0 makes overdrafts fail the whole batch) plus XP and level, and appends to
 * `ledger` with a UNIQUE idempotency key. Callers include these statements in their own
 * `env.DB.batch([...])` with their match or deposit rows, so the whole outcome commits or fails
 * together. Entries with no money and no XP are skipped. Keep entry order stable across retries.
 */
export function ledgerStatements(
  env: Env,
  idemKey: string,
  entries: readonly LedgerEntry[],
): D1PreparedStatement[] {
  if (idemKey === '') {
    throw new RangeError('ledger: missing idemKey')
  }
  const batch = crypto.randomUUID()
  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  for (const [i, entry] of entries.entries()) {
    validate(entry)
    const xp = entry.xp ?? 0
    if (entry.amount === 0 && xp === 0) {
      continue
    }
    const key = `${idemKey}#${i}`
    const ref = entry.ref ?? null
    statements.push(
      env.DB.prepare(INSERT_ENTRY).bind(
        entry.accountId,
        entry.amount,
        xp,
        entry.kind,
        ref,
        key,
        batch,
        now,
      ),
    )
    if (xp > 0) {
      statements.push(
        env.DB.prepare(INSERT_LEVEL_REWARD).bind(
          entry.accountId,
          entry.amount,
          xp,
          ref,
          `${key}:level`,
          batch,
          now,
          key,
          THRESHOLDS_JSON,
        ),
      )
    }
    statements.push(
      env.DB.prepare(UPDATE_PROFILE).bind(
        entry.accountId,
        entry.amount,
        xp,
        now,
        key,
        batch,
        THRESHOLDS_JSON,
      ),
    )
  }
  return statements
}

const CONSTRAINT = /constraint failed/iu
const CHECK_FAILED = /CHECK constraint failed/iu
const PURSE_COLUMN = /balance_after|purse/iu
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** True when a D1 error is a constraint failure (overdraft, duplicate item, missing profile). */
export function isConstraintError(err: unknown): boolean {
  return CONSTRAINT.test(messageOf(err))
}

/** True when a D1 error is specifically an overdraft (a purse or balance CHECK). */
export function isOverdraft(err: unknown): boolean {
  const message = messageOf(err)
  return CHECK_FAILED.test(message) && PURSE_COLUMN.test(message)
}
