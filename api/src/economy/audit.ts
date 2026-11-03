/**
 * The nightly ledger audit. Owned by stream C. For every account it checks that
 * `SUM(ledger.delta) = profiles.purse` and that the newest row's `balance_after` matches too, and
 * logs any mismatch. It never "fixes" a purse: a mismatch is a bug to investigate.
 *
 * Wired by the lead: `scheduled` in `api/src/index.ts` calls `runLedgerAudit(env)`, with a daily
 * cron trigger in `wrangler.jsonc`.
 */
import type { Env } from '../env.ts'

export interface AuditMismatch {
  accountId: string
  purse: number
  ledgerSum: number
  /** `balance_after` of the account's newest ledger row (null if it has none). */
  lastBalance: number | null
}

export interface AuditReport {
  checked: number
  mismatches: AuditMismatch[]
}

const AUDIT_SQL = `SELECT p.account_id AS accountId, p.purse AS purse,
  COALESCE((SELECT SUM(delta) FROM ledger l WHERE l.account_id = p.account_id), 0) AS ledgerSum,
  (SELECT balance_after FROM ledger l WHERE l.account_id = p.account_id ORDER BY id DESC LIMIT 1)
    AS lastBalance
FROM profiles p WHERE p.account_id > ?1 ORDER BY p.account_id LIMIT ?2`

/** Profiles per query; keeps each D1 call small. */
const PAGE = 500

export async function auditLedger(env: Env): Promise<AuditReport> {
  const mismatches: AuditMismatch[] = []
  let checked = 0
  let after = ''
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: keyset pagination is sequential by nature
    const { results } = await env.DB.prepare(AUDIT_SQL).bind(after, PAGE).all<AuditMismatch>()
    for (const row of results) {
      if (row.ledgerSum !== row.purse || (row.lastBalance ?? 0) !== row.purse) {
        mismatches.push(row)
      }
    }
    checked += results.length
    const last = results.at(-1)
    if (!last || results.length < PAGE) {
      break
    }
    after = last.accountId
  }
  return { checked, mismatches }
}

/** The cron entry point. Logs a summary, plus each mismatch as an error. */
export async function runLedgerAudit(env: Env): Promise<AuditReport> {
  const report = await auditLedger(env)
  for (const m of report.mismatches) {
    console.error('ledger audit mismatch', JSON.stringify(m))
  }
  console.warn(
    `ledger audit: ${report.checked} profiles checked, ${report.mismatches.length} mismatches`,
  )
  return report
}
