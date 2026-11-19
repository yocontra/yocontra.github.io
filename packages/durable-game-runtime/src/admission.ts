/** Atomic global room leases. Expired/unreported leases retain their reservation conservatively. */
import type { TransactionalDurableSqlStorage } from './sqlite.ts'

export interface AdmissionLimits {
  dailyActiveSeconds: number
  dailyWebSocketMessages: number
  leaseSeconds: number
  maxMessagesPerSecond: number
  renewAfterTicks: number
}
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
  private readonly storage: TransactionalDurableSqlStorage
  private readonly limits: AdmissionLimits
  private readonly reservedMessages: number

  constructor(storage: TransactionalDurableSqlStorage, limits: AdmissionLimits) {
    const reservedMessages = limits.leaseSeconds * limits.maxMessagesPerSecond
    if (
      !Number.isSafeInteger(reservedMessages) ||
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)
    ) {
      throw new RangeError('Admission limits must be positive safe integers')
    }
    this.storage = storage
    this.limits = { ...limits }
    this.reservedMessages = reservedMessages
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS room_leases (id INTEGER PRIMARY KEY, data TEXT NOT NULL)',
    )
  }
  /** Capacity preflight consumes no room seconds; actual socket joins still acquire atomically. */
  available(now = Date.now()): LeaseGrant {
    const day = new Date(now).toISOString().slice(0, 10)
    const saved = this.storage.sql
      .exec<{ data: string }>('SELECT data FROM room_leases WHERE id=1')
      .toArray()[0]
    const state: Ledger | undefined = saved ? (JSON.parse(saved.data) as Ledger) : undefined
    const current = state?.day === day ? state : undefined
    const leases = Object.values(current?.leases ?? {})
    return {
      ok:
        (current?.seconds ?? 0) +
          leases.reduce((sum, lease) => sum + lease.seconds, 0) +
          this.limits.leaseSeconds <=
          this.limits.dailyActiveSeconds &&
        (current?.messages ?? 0) +
          leases.reduce((sum, lease) => sum + lease.messages, 0) +
          this.reservedMessages <=
          this.limits.dailyWebSocketMessages,
      observedAt: now,
      renewAfterTicks: this.limits.renewAfterTicks,
    }
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
      const previous = Object.hasOwn(state.leases, id) ? state.leases[id] : undefined
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
        (state.seconds + reservedSeconds + this.limits.leaseSeconds <=
          this.limits.dailyActiveSeconds &&
          state.messages + reservedMessages + this.reservedMessages <=
            this.limits.dailyWebSocketMessages)
      if (ok && !finish) {
        state.leases = {
          ...state.leases,
          [id]: { issued: now, seconds: this.limits.leaseSeconds, messages: this.reservedMessages },
        }
      }
      this.storage.sql.exec(
        'INSERT INTO room_leases(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        JSON.stringify(state),
      )
      return { ok, observedAt: now, renewAfterTicks: this.limits.renewAfterTicks }
    })
  }
}
