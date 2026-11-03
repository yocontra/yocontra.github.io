import { describe, expect, test as it } from 'bun:test'
import {
  BTN_FIRE,
  BTN_INTERACT,
  BTN_LEAVE,
  KILL_FARMED,
  NONE,
} from '../../../src/experiments/out-west/contract/town.ts'
import { ffaKillMint } from '../../../src/experiments/out-west/data/progression.ts'
import {
  BAG_EXCLUSIVE_TICKS,
  BAG_EXPIRE_TICKS,
  BANK_CHANNEL_TICKS,
  LEAVE_CHANNEL_TICKS,
  LINGER_TICKS,
  MOST_WANTED_REFRESH_TICKS,
  STAGE_CHANNEL_TICKS,
  STRONGBOX_CHANNEL_TICKS,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import type { SimEvent } from '../../../src/experiments/out-west/ffa/sim/types.ts'
import { disconnectPlayer } from '../../../src/experiments/out-west/ffa/sim/world.ts'
import { aimAt, place, run, runCollect, testWorld } from './test-helpers.ts'

type Kill = Extract<SimEvent, { type: 'kill' }>
const spam = (aim: number) => (t: number) => ({ aim, buttons: t % 2 === 0 ? BTN_FIRE : 0 })
const hold = (buttons: number) => () => ({ buttons })

/** A kills B with revolver shots; returns the kill event. */
function killB(carried: number, victimLevel = 10) {
  const w = testWorld()
  const a = place(w, 20, 64)
  const b = place(w, 30, 64, { carried, level: victimLevel })
  run(w, 1)
  const kills = runCollect(w, 40, { [a.id]: spam(aimAt(a, b)) }, 'kill') as Kill[]
  return { w, a, b, kill: kills[0] }
}

describe('kill bounty and death drop', () => {
  it("mints 25% of the victim's bounty into the killer's carried cash, with kill XP", () => {
    const { a, kill } = killB(0)
    expect(kill?.bounty).toBe(ffaKillMint(10))
    expect(a.carried).toBe(ffaKillMint(10))
    expect(a.stats.xp).toBe(30)
  })

  it('70% of carried drops as a bag, 30% is burned; the killer gets 2 s of exclusivity', () => {
    const { w, a, b } = killB(1000)
    expect(b.carried).toBe(0)
    expect(w.bags.length).toBe(1)
    expect(w.bags[0]?.amount).toBe(700)
    expect(w.burned).toBe(300)
    expect(w.bags[0]?.exclusiveFor).toBe(a.id)
    expect(w.bags[0]?.exclusiveUntil).toBeLessThanOrEqual(w.tick + BAG_EXCLUSIVE_TICKS)
  })

  it('a vulture waits out the exclusivity; the killer picks it up instantly', () => {
    const { w, a } = killB(1000)
    const bag = w.bags[0]
    const vulture = place(w, bag?.x ?? 0, bag?.z ?? 0)
    run(w, 1)
    expect(vulture.carried).toBe(0)
    run(w, BAG_EXCLUSIVE_TICKS)
    expect(vulture.carried).toBe(700)
    // The victim carried $1000, so they were Most Wanted: +50%.
    expect(a.carried).toBe(ffaKillMint(10, 0, true))
  })

  it('unclaimed bags burn after 45 s', () => {
    const { w } = killB(1000)
    w.players.forEach((p) => {
      if (p) {
        p.x = 130
        p.z = 130
      }
    })
    run(w, BAG_EXPIRE_TICKS + 1)
    expect(w.bags.length).toBe(0)
    expect(w.burned).toBe(1000)
  })

  it('the 4th kill of the same victim within 10 minutes pays nothing', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    const b = place(w, 30, 64)
    run(w, 1)
    const flags: number[] = []
    for (let i = 0; i < 4; i++) {
      b.x = 30
      b.z = 64
      b.spawnTick = -10_000
      b.protectUntil = 0
      const kills = runCollect(w, 70, { [a.id]: spam(aimAt(a, b)) }, 'kill') as Kill[]
      flags.push(kills[0]?.flags ?? -1)
      run(w, 61)
      a.ammo = 6
    }
    expect(flags.slice(0, 3).every((f) => (f & KILL_FARMED) === 0)).toBe(true)
    expect((flags[3] ?? 0) & KILL_FARMED).toBeTruthy()
    expect(a.carried).toBe(ffaKillMint(10) * 3)
  })

  it('bots mint nothing and pay no XP', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    const bot = place(w, 30, 64, { bot: true })
    run(w, 1)
    runCollect(w, 40, { [a.id]: spam(aimAt(a, bot)) }, 'kill')
    expect(bot.alive).toBe(false)
    expect(a.carried).toBe(0)
    expect(a.stats.xp).toBe(0)
  })
})

describe('banking', () => {
  it('a 2 s channel at a bank window deposits the whole carry, with commission over $500', () => {
    const w = testWorld()
    const p = place(w, 64.5, 81.5, { carried: 1000 })
    run(w, BANK_CHANNEL_TICKS + 1, { [p.id]: hold(BTN_INTERACT) })
    expect(p.carried).toBe(0)
    expect(w.deposits).toEqual([
      {
        playerId: p.id,
        accountId: p.accountId,
        seq: 1,
        amount: 1000,
        commission: 100,
        xp: 100,
        bot: false,
      },
    ])
  })

  it('moving or taking damage cancels the channel', () => {
    const w = testWorld()
    const p = place(w, 64.5, 81.5, { carried: 200 })
    run(w, 10, { [p.id]: hold(BTN_INTERACT) })
    run(w, 1, { [p.id]: () => ({ buttons: BTN_INTERACT, moveX: 127 }) })
    expect(p.channel).toBeNull()
    run(w, BANK_CHANNEL_TICKS + 2)
    expect(p.carried).toBe(200)
    const shooter = place(w, 64.5, 76)
    p.x = 64.5
    p.z = 81.5
    run(w, 1, { [p.id]: () => ({ buttons: 0 }) })
    run(w, 5, { [p.id]: hold(BTN_INTERACT) })
    expect(p.channel).not.toBeNull()
    run(w, 1, {
      [shooter.id]: () => ({ aim: aimAt(shooter, p), buttons: BTN_FIRE }),
      [p.id]: hold(BTN_INTERACT),
    })
    expect(p.channel).toBeNull()
  })

  it('the Stage Line office takes 4 s', () => {
    const w = testWorld()
    const p = place(w, 13, 84, { carried: 100 })
    run(w, BANK_CHANNEL_TICKS + 1, { [p.id]: hold(BTN_INTERACT) })
    expect(p.carried).toBe(100)
    run(w, STAGE_CHANNEL_TICKS - BANK_CHANNEL_TICKS, { [p.id]: hold(BTN_INTERACT) })
    expect(p.carried).toBe(0)
    expect(w.deposits[0]?.amount).toBe(100)
  })

  it('nothing to bank outside a zone', () => {
    const w = testWorld()
    const p = place(w, 30, 64, { carried: 100 })
    run(w, BANK_CHANNEL_TICKS + 1, { [p.id]: hold(BTN_INTERACT) })
    expect(p.carried).toBe(100)
  })
})

describe('leaving, lingering, Most Wanted and strongboxes', () => {
  it('leave town inside the bank banks the carry; outside it drops', () => {
    const w = testWorld()
    const inBank = place(w, 72, 80, { carried: 400 })
    const outside = place(w, 30, 64, { carried: 400 })
    run(w, LEAVE_CHANNEL_TICKS + 1, { [inBank.id]: hold(BTN_LEAVE), [outside.id]: hold(BTN_LEAVE) })
    expect(inBank.gone && outside.gone).toBe(true)
    expect(w.deposits.map((d) => d.amount)).toEqual([400])
    expect(w.bags.map((b) => b.amount)).toEqual([280])
  })

  it('a disconnected avatar lingers 10 s, then 70% of its carry drops', () => {
    const w = testWorld()
    const p = place(w, 30, 64, { carried: 500 })
    disconnectPlayer(w, p)
    run(w, LINGER_TICKS - 1, { [p.id]: () => ({ moveX: 127 }) })
    expect(p.x).toBe(30)
    expect(p.gone).toBe(false)
    run(w, 2)
    expect(p.gone).toBe(true)
    expect(w.bags[0]?.amount).toBe(350)
  })

  it('Most Wanted: the richest carrier with at least $300', () => {
    const w = testWorld()
    place(w, 30, 64, { carried: 299 })
    const rich = place(w, 40, 64, { carried: 900 })
    place(w, 50, 64, { carried: 600 })
    run(w, MOST_WANTED_REFRESH_TICKS + 1)
    expect(w.mostWanted).toBe(rich.id)
    rich.carried = 0
    run(w, MOST_WANTED_REFRESH_TICKS)
    expect(w.mostWanted).not.toBe(rich.id)
  })

  it('killing the Most Wanted pays +50%', () => {
    const w = testWorld()
    const a = place(w, 20, 64)
    const b = place(w, 30, 64, { carried: 500 })
    run(w, MOST_WANTED_REFRESH_TICKS + 1)
    expect(w.mostWanted).toBe(b.id)
    const kills = runCollect(w, 40, { [a.id]: spam(aimAt(a, b)) }, 'kill') as Kill[]
    expect(kills[0]?.bounty).toBe(ffaKillMint(10, 0, true))
  })

  it('a strongbox spawns, opens after a 3 s channel into carried cash, and the next is scheduled', () => {
    const w = testWorld()
    w.nextStrongboxTick = 1
    const p = place(w, 30, 64)
    run(w, 2)
    expect(w.strongbox).not.toBeNull()
    const spot = w.layout.strongboxes[w.strongbox?.spot ?? 0]
    p.x = spot?.x ?? 0
    p.z = spot?.z ?? 0
    const value = w.strongbox?.value ?? 0
    expect(value).toBe(420)
    run(w, STRONGBOX_CHANNEL_TICKS + 1, { [p.id]: hold(BTN_INTERACT) })
    expect(w.strongbox).toBeNull()
    expect(p.carried).toBe(value)
    expect(p.stats.xp).toBe(50)
    expect(w.nextStrongboxTick).toBeGreaterThan(w.tick)
    expect(NONE).toBe(255)
  })
})
