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
    return { active: Object.keys(state?.leases ?? {}).length }
  }
  private consumeDelay(): number {
    const delay = this.delayNextLease
    this.delayNextLease = 0
    return delay
  }
  override async leaseRoom(...args: Parameters<ProductionDirectory['leaseRoom']>) {
    const grant = await super.leaseRoom(...args)
    const delay = args[2] ? 0 : this.consumeDelay()
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    return grant
  }
}
