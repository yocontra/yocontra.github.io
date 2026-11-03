import { describe, expect, it } from 'bun:test'
import type { GhostCandidate } from './ghost.ts'
import {
  canPair,
  ghostButton,
  pickGhost,
  planTick,
  type QueueEntry,
  sameNetwork,
  windowFor,
} from './queue.ts'

const NOW = 1_000_000

const entry = (id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  accountId: id,
  joinedAt: NOW,
  priority: false,
  effectiveLevel: 10,
  rating: 250,
  net: { ip: `ip-${id}`, prefix: `pre-${id}` },
  ghostsOnly: false,
  wantsGhost: false,
  lastOpponents: [],
  recentGhosts: [],
  ...over,
})

describe('windows', () => {
  it('widen over time', () => {
    expect(windowFor(0)).toEqual({ level: 1, rating: 25 })
    expect(windowFor(4000)).toEqual({ level: 3, rating: 50 })
    expect(windowFor(8000)).toEqual({ level: 6, rating: null })
    expect(windowFor(12_000)).toEqual({ level: 12, rating: null })
    expect(ghostButton(7999)).toBe(false)
    expect(ghostButton(8000)).toBe(true)
  })
})

describe('canPair', () => {
  it('pairs close players at once', () => {
    expect(canPair(entry('a'), entry('b', { rating: 270 }), NOW)).toBe(true)
  })
  it('respects both windows', () => {
    const far = entry('b', { effectiveLevel: 14 })
    expect(canPair(entry('a'), far, NOW)).toBe(false)
    // After 8 s both windows are ±6.
    const later = NOW + 8000
    expect(canPair(entry('a'), far, later)).toBe(true)
    // A newcomer is protected by their own tight window.
    expect(canPair(entry('a'), { ...far, joinedAt: later }, later)).toBe(false)
  })
  it('never pairs the same network', () => {
    expect(sameNetwork({ ip: 'x', prefix: 'p' }, { ip: 'y', prefix: 'p' })).toBe(true)
    expect(canPair(entry('a'), entry('b', { net: { ip: 'ip-a', prefix: 'z' } }), NOW)).toBe(false)
    expect(sameNetwork(null, { ip: 'x', prefix: 'p' })).toBe(false)
  })
  it('never pairs rough connections or the same account', () => {
    expect(canPair(entry('a'), entry('b', { ghostsOnly: true }), NOW)).toBe(false)
    expect(canPair(entry('a'), entry('a'), NOW)).toBe(false)
  })
  it('no third match in a row for the same pair', () => {
    const a = entry('a', { lastOpponents: ['b', 'b'] })
    expect(canPair(a, entry('b'), NOW)).toBe(false)
    expect(canPair(entry('a', { lastOpponents: ['b', 'c'] }), entry('b'), NOW)).toBe(true)
  })
})

describe('planTick', () => {
  it('oldest first, best score', () => {
    const actions = planTick(
      [
        entry('new', { joinedAt: NOW }),
        entry('old', { joinedAt: NOW - 3000, rating: 240 }),
        entry('close', { joinedAt: NOW - 1000, rating: 241 }),
      ],
      NOW,
    )
    expect(actions).toEqual([{ kind: 'pair', a: 'old', b: 'close' }])
  })
  it('ghost at 18 s or on request', () => {
    const actions = planTick(
      [
        entry('waited', { joinedAt: NOW - 18_000 }),
        entry('asked', { wantsGhost: true, effectiveLevel: 40 }),
      ],
      NOW,
    )
    expect(actions).toEqual([
      { kind: 'ghost', a: 'waited' },
      { kind: 'ghost', a: 'asked' },
    ])
  })
  it('a dodged player goes first', () => {
    const actions = planTick(
      [
        entry('x', { joinedAt: NOW - 3000 }),
        entry('y', { joinedAt: NOW - 2000 }),
        entry('front', { priority: true }),
      ],
      NOW,
    )
    expect(actions[0]).toMatchObject({ a: 'front' })
  })
})

describe('pickGhost', () => {
  const ghost = (id: string, over: Partial<GhostCandidate> = {}): GhostCandidate => ({
    accountId: id,
    name: id,
    level: 10,
    prestige: 0,
    drawRating: 250,
    loadout: null,
    ...over,
  })
  const net = () => null
  it('within ±3 levels and ±40 ms', () => {
    const ghosts = [ghost('far', { level: 20 }), ghost('slow', { drawRating: 300 }), ghost('ok')]
    expect(pickGhost(entry('me'), ghosts, net)?.accountId).toBe('ok')
  })
  it('not you, not your network, not a recent ghost', () => {
    const me = entry('me', { recentGhosts: ['recent'] })
    const ghosts = [ghost('me'), ghost('recent'), ghost('neighbour')]
    const netOf = (id: string) => (id === 'neighbour' ? { ip: 'q', prefix: 'pre-me' } : null)
    expect(pickGhost(me, ghosts, netOf)).toBeNull()
  })
  it('prestige counts toward the effective level', () => {
    expect(
      pickGhost(entry('me', { effectiveLevel: 20 }), [ghost('p', { prestige: 1 })], net)?.accountId,
    ).toBe('p')
  })
})
