/** Durable one-use SDK seat metadata; no resident room, physics, timer or duration lease. */
import { matchMaker } from '@colyseus/core'
import type { NativeJoinProfile } from './room.ts'

export interface NativeSeat {
  lobbyId: string
  profile: NativeJoinProfile
  protocol: number
}
export class NativeSeats {
  private readonly storage: DurableObjectStorage
  constructor(storage: DurableObjectStorage) {
    this.storage = storage
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS native_seats (id TEXT PRIMARY KEY, account_id TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL)',
    )
  }
  issue(roomId: string, seat: NativeSeat, now = Date.now()) {
    const id = crypto.randomUUID()
    this.expire(now)
    this.storage.sql.exec(
      'INSERT INTO native_seats(id,account_id,expires_at,data) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET id=excluded.id,expires_at=excluded.expires_at,data=excluded.data',
      id,
      seat.profile.accountId,
      now + 30_000,
      JSON.stringify(seat),
    )
    return matchMaker.buildSeatReservation(
      { name: 'frontier', roomId, processId: 'native', clients: 0, maxClients: 32 },
      id,
    )
  }
  consume(
    id: string,
    accountId: string,
    lobbyId: string,
    now = Date.now(),
  ): NativeSeat | undefined {
    const row = this.storage.sql
      .exec<{ data: string }>(
        "DELETE FROM native_seats WHERE id=? AND account_id=? AND json_extract(data,'$.lobbyId')=? AND expires_at>? RETURNING data",
        id,
        accountId,
        lobbyId,
        now,
      )
      .toArray()[0]
    return row ? (JSON.parse(row.data) as NativeSeat) : undefined
  }
  expire(now = Date.now()): void {
    this.storage.sql.exec('DELETE FROM native_seats WHERE expires_at<=?', now)
  }
  nextExpiry(): number | undefined {
    return (
      this.storage.sql
        .exec<{ next: number | null }>('SELECT MIN(expires_at) AS next FROM native_seats')
        .toArray()[0]?.next ?? undefined
    )
  }
}
