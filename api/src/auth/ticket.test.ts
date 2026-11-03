import { describe, expect, it } from 'bun:test'
import { TICKET_TTL_MS } from '../../../src/experiments/out-west/contract/auth.ts'
import { deleteAccount } from './accounts.ts'
import { fakeEnv, seedAccount } from './d1-fake.ts'
import { AccountGoneError, issueTicket, redeemTicket } from './ticket.ts'

const player = { accountId: 'acct-ticket-0000000001', name: 'Calamity' }

function setup() {
  const env = fakeEnv()
  seedAccount(env, player.accountId, player.name)
  return env
}

describe('WebSocket tickets', () => {
  it('redeems exactly once', async () => {
    const env = setup()
    const ticket = await issueTicket(env, player, 'duel')
    expect(await redeemTicket(env, ticket, 'duel')).toEqual(player)
    expect(await redeemTicket(env, ticket, 'duel')).toBeNull()
  })

  it('refuses the wrong purpose without burning the ticket', async () => {
    const env = setup()
    const ticket = await issueTicket(env, player, 'town')
    expect(await redeemTicket(env, ticket, 'duel')).toBeNull()
    expect(await redeemTicket(env, ticket, 'town')).toEqual(player)
  })

  it('expires after 30 seconds', async () => {
    const env = setup()
    const now = Date.now()
    const ticket = await issueTicket(env, player, 'duel', now)
    expect(await redeemTicket(env, ticket, 'duel', now + TICKET_TTL_MS)).toBeNull()
    const fresh = await issueTicket(env, player, 'duel', now)
    expect(await redeemTicket(env, fresh, 'duel', now + TICKET_TTL_MS - 1)).toEqual(player)
  })

  it('rejects unknown and malformed tickets', async () => {
    const env = setup()
    expect(await redeemTicket(env, 'A'.repeat(32), 'duel')).toBeNull()
    expect(await redeemTicket(env, "'; DROP TABLE accounts; --", 'duel')).toBeNull()
    expect(await redeemTicket(env, '', 'duel')).toBeNull()
  })

  it('stores only the hash', async () => {
    const env = setup()
    const ticket = await issueTicket(env, player, 'duel')
    const rows = env.sqlite.prepare('SELECT ticket_hash FROM ws_tickets').all() as {
      ticket_hash: string
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ticket_hash).not.toBe(ticket)
  })

  it('can’t be issued for a deleted account, and outstanding ones die with it', async () => {
    const env = setup()
    const ticket = await issueTicket(env, player, 'duel')
    await deleteAccount(env, player.accountId)
    expect(await redeemTicket(env, ticket, 'duel')).toBeNull()
    await expect(issueTicket(env, player, 'duel')).rejects.toBeInstanceOf(AccountGoneError)
  })
})
