/** Real SQLite account/lobby/expiry and single-use checks without allocating any room. */
import { NativeSeats } from '../src/game/seats.ts'

export function seatsProbe(storage: DurableObjectStorage) {
  const seats = new NativeSeats(storage)
  const now = Date.now()
  const profile = {
    accountId: 'seat-owner',
    name: 'Owner',
    level: 1,
    prestige: 0,
    loadout: [],
    banked: 0,
    tcpRtt: null,
    ledger: false,
  }
  const issue = () => seats.issue('fixture-room', { lobbyId: 'lobby:0', profile, protocol: 2 }, now)
  const first = issue()
  const wrongAccount = seats.consume(first.sessionId, 'intruder', 'lobby:0', now)
  const wrongLobby = seats.consume(first.sessionId, profile.accountId, 'lobby:1', now)
  const accepted = seats.consume(first.sessionId, profile.accountId, 'lobby:0', now)
  const duplicate = seats.consume(first.sessionId, profile.accountId, 'lobby:0', now)
  const stale = issue()
  const latest = issue()
  const replaced = seats.consume(stale.sessionId, profile.accountId, 'lobby:0', now)
  const expired = seats.consume(latest.sessionId, profile.accountId, 'lobby:0', now + 30_000)
  seats.expire(now + 30_000)
  if (
    wrongAccount ||
    wrongLobby ||
    !accepted ||
    duplicate ||
    replaced ||
    expired ||
    seats.nextExpiry() !== undefined
  ) {
    throw new Error('Durable one-use seat binding regression')
  }
  return { accountBound: true, lobbyBound: true, oneUse: true, expired: true, replaced: true }
}
