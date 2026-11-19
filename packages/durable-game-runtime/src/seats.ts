/** Durable one-use SDK seat metadata; no resident room, physics, timer or duration lease. */
import { matchMaker } from '@colyseus/core'
import type { DurableSqlStorage } from './sqlite.ts'

interface SeatOwner {
  lobbyId: string
  profile: { accountId: string }
}

type RoomListing = Omit<Parameters<typeof matchMaker.buildSeatReservation>[0], 'roomId'>

export class DurableSeats<Seat extends SeatOwner> {
  private readonly storage: DurableSqlStorage
  private readonly ttlMs: number
  private readonly room: RoomListing

  constructor(storage: DurableSqlStorage, room: RoomListing, ttlMs = 30_000) {
    if (!(Number.isSafeInteger(ttlMs) && ttlMs > 0)) {
      throw new RangeError('Seat TTL must be a positive integer in milliseconds')
    }
    this.storage = storage
    this.ttlMs = ttlMs
    this.room = { ...room }
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS native_seats (id TEXT PRIMARY KEY, account_id TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL)',
    )
  }
  issue(roomId: string, seat: Seat, now = Date.now()) {
    const id = crypto.randomUUID()
    this.expire(now)
    this.storage.sql.exec(
      'INSERT INTO native_seats(id,account_id,expires_at,data) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET id=excluded.id,expires_at=excluded.expires_at,data=excluded.data',
      id,
      seat.profile.accountId,
      now + this.ttlMs,
      JSON.stringify(seat),
    )
    return matchMaker.buildSeatReservation({ ...this.room, roomId }, id)
  }
  consume(id: string, accountId: string, lobbyId: string, now = Date.now()): Seat | undefined {
    const row = this.storage.sql
      .exec<{ data: string }>(
        "DELETE FROM native_seats WHERE id=? AND account_id=? AND json_extract(data,'$.lobbyId')=? AND expires_at>? RETURNING data",
        id,
        accountId,
        lobbyId,
        now,
      )
      .toArray()[0]
    return row ? (JSON.parse(row.data) as Seat) : undefined
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
