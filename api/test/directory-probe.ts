/** Fixture-only delayed delivery of a real atomic lease grant. */
import { LobbyDirectory as ProductionDirectory } from '../src/town/directory.ts'

export class LobbyDirectory extends ProductionDirectory {
  private delayNextLease = 0
  testDelayLease(milliseconds: number) {
    this.delayNextLease = Math.max(0, Math.min(5000, milliseconds))
  }
  testLeases() {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM room_leases WHERE id=1')
      .toArray()[0]
    const state = row ? (JSON.parse(row.data) as { leases: Record<string, unknown> }) : undefined
    return { active: Object.keys(state?.leases ?? {}).length, history: this.leaseHistory() }
  }
  /** Every lease decision, durable because idle directories are evicted between renewals. */
  private leaseHistory() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS test_lease_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, finish INTEGER NOT NULL, ok INTEGER NOT NULL, at INTEGER NOT NULL)',
    )
    return this.ctx.storage.sql
      .exec<{ id: string; finish: number; ok: number; at: number }>(
        'SELECT id,finish,ok,at FROM test_lease_history ORDER BY seq',
      )
      .toArray()
      .map((entry) => ({ ...entry, finish: entry.finish === 1, ok: entry.ok === 1 }))
  }
  private consumeDelay(): number {
    const delay = this.delayNextLease
    this.delayNextLease = 0
    return delay
  }
  override async leaseRoom(...args: Parameters<ProductionDirectory['leaseRoom']>) {
    const grant = await super.leaseRoom(...args)
    this.leaseHistory()
    this.ctx.storage.sql.exec(
      'INSERT INTO test_lease_history(id,finish,ok,at) VALUES(?,?,?,?)',
      args[0],
      args[2] ? 1 : 0,
      grant.ok ? 1 : 0,
      grant.observedAt,
    )
    const delay = args[2] ? 0 : this.consumeDelay()
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    return grant
  }
}
