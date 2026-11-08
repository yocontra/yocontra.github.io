/** Atomic global room leases. Expired/unreported leases retain their reservation conservatively. */
import { CEILINGS } from '../budget.ts'

export class NativeBudgetRefusal extends Error {}

const LEASE_SECONDS = 60
const MAX_MESSAGES = 32 * 20 * LEASE_SECONDS
interface Lease {
  issued: number
  seconds: number
  messages: number
}
interface Ledger {
  day: string
  seconds: number
  messages: number
  leases: Record<string, Lease>
}
export interface LeaseGrant {
  ok: boolean
  observedAt: number
  renewAfterTicks: number
}
export class AdmissionLeases {
  private readonly storage: DurableObjectStorage
  constructor(storage: DurableObjectStorage) {
    this.storage = storage
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS room_leases (id INTEGER PRIMARY KEY, data TEXT NOT NULL)',
    )
  }
  renew(id: string, messages: number, finish = false, now = Date.now()): LeaseGrant {
    return this.storage.transactionSync(() => {
      const day = new Date(now).toISOString().slice(0, 10)
      const saved = this.storage.sql
        .exec<{ data: string }>('SELECT data FROM room_leases WHERE id=1')
        .toArray()[0]
      let state: Ledger = saved
        ? (JSON.parse(saved.data) as Ledger)
        : { day, seconds: 0, messages: 0, leases: {} }
      const previous = state.leases[id]
      if (state.day !== day) {
        state = { day, seconds: 0, messages: 0, leases: {} }
        if (previous) {
          const midnight = Date.parse(`${day}T00:00:00Z`)
          state.seconds = Math.ceil((now - Math.max(midnight, previous.issued)) / 1000)
          state.messages = Math.max(0, messages)
        }
      } else if (previous) {
        state.seconds += Math.max(0, Math.ceil((now - previous.issued) / 1000))
        state.messages += Math.max(0, messages)
        delete state.leases[id]
      }
      let reservedSeconds = 0
      let reservedMessages = 0
      for (const lease of Object.values(state.leases)) {
        reservedSeconds += lease.seconds
        reservedMessages += lease.messages
      }
      const ok =
        finish ||
        (state.seconds + reservedSeconds + LEASE_SECONDS <= CEILINGS.lobby_seconds &&
          state.messages + reservedMessages + MAX_MESSAGES <= CEILINGS.ws_messages)
      if (ok && !finish) {
        state.leases[id] = { issued: now, seconds: LEASE_SECONDS, messages: MAX_MESSAGES }
      }
      this.storage.sql.exec(
        'INSERT INTO room_leases(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        JSON.stringify(state),
      )
      return { ok, observedAt: now, renewAfterTicks: 600 }
    })
  }
}
