import { describe, expect, it } from 'bun:test'
import {
  INTRO_MS,
  PACE_MS,
  READY_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  REMATCH_WINDOW_MS,
  type RoomServerMessage,
  STALL_AUTO_WALK_MS,
  TURN_MS,
} from '../../../src/experiments/out-west/contract/duel.ts'
import { FakeClock, seeded } from './fake-clock.ts'
import type { Seat } from './judge-pvp.ts'
import type { AiOpponent } from './opponents.ts'
import { DEAD_HEAT_PAUSE_MS, RoomFlow } from './room-flow.ts'
import type { FinishedDuel } from './room-types.ts'

function room(ai: (() => AiOpponent) | null = null, settleMs = 0) {
  const clock = new FakeClock()
  const inbox: [RoomServerMessage[], RoomServerMessage[]] = [[], []]
  const settled: FinishedDuel[] = []
  const closed: string[] = []
  const requeued: Seat[] = []
  let idleUntil: number | null = null
  const flow = new RoomFlow({
    ai,
    clock,
    rng: seeded(42),
    io: {
      send: (seat, m) => inbox[seat].push(m),
      link: () => ({ median: 40, jitter: 0, tcp: 40 }),
      settle: (d) => {
        settled.push(d)
        // a slow D1 batch: the results go out `settleMs` after the verdict
        return settleMs > 0
          ? new Promise((resolve) => clock.after(settleMs, () => resolve([null, null])))
          : Promise.resolve([null, null])
      },
      idle: (deadline) => {
        idleUntil = deadline
      },
      close: (reason) => closed.push(reason),
      requeue: (seat) => requeued.push(seat),
    },
  })
  const of = (seat: Seat, type: RoomServerMessage['type']) =>
    inbox[seat].filter((m) => m.type === type)
  const seats: Seat[] = ai ? [0] : [0, 1]
  /** Connect, sit through the intro, cock, and walk to the start of the wait. */
  const toWait = () => {
    flow.start(0)
    for (const s of seats) {
      flow.connect(s)
    }
    clock.advance(INTRO_MS)
    for (const s of seats) {
      flow.message(s, { type: 'ready' })
      flow.message(s, { type: 'hold', down: true })
    }
    clock.advance(PACE_MS * 10 + TURN_MS)
    expect(flow.beat).toBe('wait')
  }
  /** Run the wait until the call reaches both humans. */
  const toCall = () => {
    for (let i = 0; i < 600 && of(0, 'call').length < flow.draw; i++) {
      clock.advance(10)
    }
    expect(flow.beat).toBe('called')
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return {
    clock,
    flow,
    inbox,
    of,
    settled,
    closed,
    requeued,
    toWait,
    toCall,
    flush,
    idle: () => idleUntil,
  }
}

describe('room flow: two humans', () => {
  it('walks the full beat sheet to a clean win', async () => {
    const r = room()
    r.toWait()
    const paces = r.of(0, 'pace')
    expect(paces.length).toBeGreaterThanOrEqual(5)
    expect(paces.length).toBeLessThanOrEqual(9)
    r.toCall()
    r.clock.advance(250)
    r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: 210 })
    r.clock.advance(10)
    r.flow.message(1, { type: 'shot', draw: r.flow.draw, localMs: 225 })
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'win', winner: 0, reactions: [210, 225] })
    expect(r.of(1, 'result')[0]).toMatchObject({ outcome: 'win', winner: 0, settled: true })
    expect(r.flow.beat).toBe('result')
    expect(r.idle()).not.toBeNull()
  })

  it('the walk stops while either player lets go, then auto-walks after 10 s', () => {
    const r = room()
    r.flow.start(0)
    r.flow.connect(0)
    r.flow.connect(1)
    r.clock.advance(INTRO_MS)
    r.flow.message(0, { type: 'ready' })
    r.flow.message(1, { type: 'ready' })
    r.flow.message(0, { type: 'hold', down: true })
    r.clock.advance(PACE_MS * 4)
    expect(r.of(0, 'pace')).toHaveLength(0)
    r.clock.advance(STALL_AUTO_WALK_MS)
    expect(r.of(0, 'heckle')).toHaveLength(1)
    expect(r.of(0, 'pace').some((m) => m.type === 'pace' && m.auto)).toBe(true)
  })

  it('a press before the call is cowardice', async () => {
    const r = room()
    r.toWait()
    r.flow.message(1, { type: 'shot', draw: r.flow.draw, localMs: null })
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'coward', culprit: 1, winner: 0 })
  })

  it('a dead heat goes to sudden death; two in a row is a draw', async () => {
    const r = room()
    r.toWait()
    for (let heat = 0; heat < 2; heat++) {
      r.toCall()
      r.clock.advance(250)
      r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: 210 })
      r.flow.message(1, { type: 'shot', draw: r.flow.draw, localMs: 212 })
      if (heat === 0) {
        expect(r.of(0, 'deadHeat')).toHaveLength(1)
        r.clock.advance(DEAD_HEAT_PAUSE_MS)
        expect(r.of(0, 'suddenDeath')).toHaveLength(1)
      }
    }
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'draw', deadHeats: 2, winner: null })
  })

  it('neither firing is a freeze', async () => {
    const r = room()
    r.toWait()
    r.toCall()
    r.clock.advance(2000)
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'froze' })
  })

  it('a drop before the call gets 5 s, then forfeits', async () => {
    const r = room()
    r.toWait()
    r.flow.disconnect(1)
    expect(r.of(0, 'presence').at(-1)).toMatchObject({ seat: 1, connected: false })
    r.clock.advance(RECONNECT_GRACE_MS + 1)
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'forfeit', culprit: 1, winner: 0 })
  })

  it('a reconnect within the grace re-rolls the wait', () => {
    const r = room()
    r.toWait()
    const draw = r.flow.draw
    r.flow.disconnect(1)
    r.clock.advance(2000)
    r.flow.connect(1)
    expect(r.of(1, 'sync').at(-1)).toMatchObject({ type: 'sync' })
    r.clock.advance(TURN_MS)
    expect(r.flow.draw).toBe(draw + 1)
    expect(r.flow.beat).toBe('wait')
  })

  it('a drop after the call has no grace: the shot that came in wins', async () => {
    const r = room()
    r.toWait()
    r.toCall()
    r.flow.disconnect(1)
    r.clock.advance(250)
    r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: 220 })
    r.clock.advance(400)
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'win', winner: 0 })
  })

  it('not cocking within 10 s is a dodge, and the other is requeued', async () => {
    const r = room()
    r.flow.start(0)
    r.flow.connect(0)
    r.flow.connect(1)
    r.clock.advance(INTRO_MS)
    r.flow.message(0, { type: 'ready' })
    r.clock.advance(READY_TIMEOUT_MS)
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'dodge', culprit: 1 })
    expect(r.requeued).toEqual([0])
    expect(r.closed).toEqual(['opponent-left'])
  })

  it('fleeing during the walk is a forfeit', async () => {
    const r = room()
    r.flow.start(0)
    r.flow.connect(0)
    r.flow.connect(1)
    r.clock.advance(INTRO_MS)
    r.flow.message(0, { type: 'ready' })
    r.flow.message(1, { type: 'ready' })
    r.flow.message(0, { type: 'flee' })
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'forfeit', culprit: 0 })
  })

  it('a rematch needs both votes, skips the intro, and stops after 5', async () => {
    const r = room()
    r.toWait()
    r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: null })
    await r.flush()
    r.flow.message(0, { type: 'rematch' })
    expect(r.flow.beat).toBe('result')
    r.flow.message(1, { type: 'rematch' })
    expect(r.flow.rematch).toBe(1)
    expect(r.flow.beat).toBe('cock')
  })

  it('the rematch window is 20 s from when the results go out, not from the verdict', async () => {
    expect(REMATCH_WINDOW_MS).toBe(20_000)
    const r = room(null, 1500)
    r.toWait()
    r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: null })
    const verdictAt = r.clock.now()
    r.clock.advance(1500)
    await r.flush()
    const sentAt = verdictAt + 1500
    expect(r.of(0, 'result')).toHaveLength(1)
    const votes = r.of(1, 'rematch').at(-1)
    expect(votes?.type === 'rematch' && votes.deadline).toBe(sentAt + REMATCH_WINDOW_MS)
    // the room hibernates until then: its alarm is the deadline
    expect(r.idle()).toBe(sentAt + REMATCH_WINDOW_MS)
    // a vote 15 s after the results (a 4 s kill cam plus a slow click) still lands
    r.clock.advance(15_000)
    r.flow.message(0, { type: 'rematch' })
    r.flow.message(1, { type: 'rematch' })
    expect(r.flow.rematch).toBe(1)
  })

  it('the rematch window expiring closes the room', async () => {
    const r = room()
    r.toWait()
    r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: null })
    await r.flush()
    r.flow.rematchExpired()
    expect(r.closed).toEqual(['done'])
  })
})

describe('room flow: against a ghost', () => {
  const ghost = (): AiOpponent => ({
    kind: 'ghost',
    flinches: () => false,
    hazardPerSecond: 0,
    draw: () => [300],
  })
  it('walks alone (the ghost always holds) and the ghost shoots at its time', async () => {
    const r = room(ghost)
    r.toWait()
    r.toCall()
    r.clock.advance(500)
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'win', winner: 1, reactions: [null, 300] })
  })
  it('a faster human wins', async () => {
    const r = room(ghost)
    r.toWait()
    r.toCall()
    r.clock.advance(240)
    r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: 200 })
    await r.flush()
    expect(r.settled[0]).toMatchObject({ outcome: 'win', winner: 0 })
  })
  it('a rematch with a ghost needs only the human', async () => {
    const r = room(ghost)
    r.toWait()
    r.flow.message(0, { type: 'shot', draw: r.flow.draw, localMs: null })
    await r.flush()
    r.flow.message(0, { type: 'rematch' })
    expect(r.flow.rematch).toBe(1)
  })
})
