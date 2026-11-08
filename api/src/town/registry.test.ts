import { describe, expect, test as it } from 'bun:test'
import {
  assign,
  collect,
  emptyRegistry,
  GC_EMPTY_MS,
  HOME_LOBBY,
  POPULATION_TTL_MS,
  poolOf,
  RESERVE_MS,
  report,
} from './registry.ts'

const opts = (accountId: string, now = 0) => ({ accountId, now, budgetOpen: true, maxLobbies: 4 })

function fill(reg: ReturnType<typeof emptyRegistry>, lobbyId: string, humans: number, now = 0) {
  report(reg, { lobbyId, humans, arrived: [], departed: [], now })
}

describe('lobby directory', () => {
  it('reclaims stale positive populations after owner restart, while healthy lease heartbeats retain capacity', () => {
    const reg = emptyRegistry(0)
    for (let i = 0; i < 4; i++) {
      fill(reg, `lobby:${i}`, 32)
    }
    collect(reg, POPULATION_TTL_MS - 1)
    expect(assign(reg, opts('full', POPULATION_TTL_MS - 1))).toEqual({
      ok: false,
      reason: 'all_full',
    })
    for (let i = 0; i < 4; i++) {
      fill(reg, `lobby:${i}`, 32, 60_000)
    }
    collect(reg, POPULATION_TTL_MS + 1)
    expect(assign(reg, opts('healthy', POPULATION_TTL_MS + 1))).toEqual({
      ok: false,
      reason: 'all_full',
    })
    collect(reg, 60_000 + POPULATION_TTL_MS + 1)
    expect(assign(reg, opts('recovered', 60_000 + POPULATION_TTL_MS + 1))).toMatchObject({
      ok: true,
      lobbyId: HOME_LOBBY,
    })
  })
  it('lobby:0 always exists and takes the first player', () => {
    const reg = emptyRegistry(0)
    expect(assign(reg, opts('a'))).toEqual({ ok: true, lobbyId: HOME_LOBBY, players: 1 })
  })

  it('fills the fullest lobby below 28, then rolls over', () => {
    const reg = emptyRegistry(0)
    fill(reg, HOME_LOBBY, 27)
    expect(assign(reg, opts('a'))).toMatchObject({ lobbyId: HOME_LOBBY })
    // Now 27 + 1 held = 28: the next player rolls over to lobby:1.
    expect(assign(reg, opts('b'))).toMatchObject({ lobbyId: 'lobby:1' })
    fill(reg, 'lobby:1', 10)
    fill(reg, HOME_LOBBY, 20)
    expect(assign(reg, opts('c'))).toMatchObject({ lobbyId: HOME_LOBBY })
  })

  it('when every lobby has 28+, any lobby below 32; then refuses at MAX_LOBBIES', () => {
    const reg = emptyRegistry(0)
    for (let i = 0; i < 4; i++) {
      const id = i === 0 ? HOME_LOBBY : `lobby:${i}`
      fill(reg, id, 30)
    }
    expect(assign(reg, opts('a'))).toMatchObject({ ok: true })
    for (const id of Object.keys(reg.lobbies)) {
      fill(reg, id, 32)
    }
    expect(assign(reg, opts('z'))).toEqual({ ok: false, reason: 'all_full' })
  })

  it('refuses new players when the budget is spent, but lets a leaver rejoin', () => {
    const reg = emptyRegistry(0)
    report(reg, { lobbyId: HOME_LOBBY, humans: 3, arrived: [], departed: ['x'], now: 0 })
    expect(assign(reg, { ...opts('new'), budgetOpen: false })).toEqual({
      ok: false,
      reason: 'over_budget',
    })
    expect(assign(reg, { ...opts('x', 1000), budgetOpen: false })).toMatchObject({
      ok: true,
      lobbyId: HOME_LOBBY,
    })
  })

  it('a leaver gets their lobby back within 60 s, not after', () => {
    const reg = emptyRegistry(0)
    fill(reg, HOME_LOBBY, 28)
    assign(reg, opts('b'))
    report(reg, { lobbyId: 'lobby:1', humans: 1, arrived: ['b'], departed: [], now: 1 })
    report(reg, { lobbyId: 'lobby:1', humans: 0, arrived: [], departed: ['b'], now: 2 })
    expect(assign(reg, opts('b', 10_000))).toMatchObject({ lobbyId: 'lobby:1' })
    report(reg, { lobbyId: 'lobby:1', humans: 0, arrived: [], departed: ['b'], now: 20_000 })
    fill(reg, HOME_LOBBY, 5, 20_000)
    expect(assign(reg, opts('b', 20_000 + RESERVE_MS + 1))).toMatchObject({ lobbyId: HOME_LOBBY })
  })

  it('small extra lobbies drain while another has room; lobby:0 never drains', () => {
    const reg = emptyRegistry(0)
    reg.lobbies['lobby:1'] = {
      id: 'lobby:1',
      count: 0,
      state: 'open',
      lastBeat: 0,
      emptySince: 0,
      reserved: {},
    }
    fill(reg, 'lobby:1', 3)
    fill(reg, HOME_LOBBY, 2)
    expect(reg.lobbies).toMatchObject({
      'lobby:1': { state: 'draining' },
      [HOME_LOBBY]: { state: 'open' },
    })
    expect(assign(reg, opts('n'))).toMatchObject({ lobbyId: HOME_LOBBY })
  })

  it('forgets empty extra lobbies after 2 minutes, never lobby:0', () => {
    const reg = emptyRegistry(0)
    fill(reg, HOME_LOBBY, 28)
    assign(reg, opts('a'))
    assign(reg, opts('b'))
    fill(reg, 'lobby:1', 0, 1000)
    fill(reg, HOME_LOBBY, 0, 1000)
    expect(collect(reg, 1000 + GC_EMPTY_MS + 1)).toEqual(['lobby:1'])
    expect(Object.keys(reg.lobbies)).toEqual([HOME_LOBBY])
  })

  it('the Badlands: flagged accounts get their own lobby, honest ones never do', () => {
    const reg = emptyRegistry(0)
    const bad = assign(reg, { ...opts('cheat'), pool: 'badlands' as const })
    expect(bad).toMatchObject({ ok: true, lobbyId: 'lobby:500' })
    expect(poolOf('lobby:500')).toBe('badlands')
    expect(poolOf(HOME_LOBBY)).toBe('main')
    // A second flagged account joins the same Badlands lobby.
    expect(assign(reg, { ...opts('cheat2'), pool: 'badlands' as const })).toMatchObject({
      lobbyId: 'lobby:500',
    })
    // Honest players never land there, even when asking for it by id.
    expect(assign(reg, { ...opts('honest'), preferred: 'lobby:500' })).toMatchObject({
      lobbyId: HOME_LOBBY,
    })
    // The Badlands lobby never drains, and its slot rejoin stays in the pool.
    fill(reg, 'lobby:500', 1)
    expect(reg.lobbies).toMatchObject({ 'lobby:500': { state: 'open' } })
    report(reg, { lobbyId: 'lobby:500', humans: 0, arrived: [], departed: ['cheat'], now: 5 })
    expect(assign(reg, { ...opts('cheat', 10), pool: 'badlands' as const })).toMatchObject({
      lobbyId: 'lobby:500',
    })
  })

  it('the Badlands counts toward the lobby cap', () => {
    const reg = emptyRegistry(0)
    const max = { maxLobbies: 1 }
    expect(assign(reg, { ...opts('cheat'), ...max, pool: 'badlands' as const })).toEqual({
      ok: false,
      reason: 'all_full',
    })
  })
})
