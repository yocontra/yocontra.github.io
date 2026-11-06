import { describe, expect, it } from 'bun:test'
import {
  ANIM_DEAD,
  ANIM_DUEL,
  ANIM_HOP,
  ANIM_IDLE,
  ANIM_ROLL,
  ANIM_RUN,
  ANIM_SLIDE,
  ANIM_VAULT,
  CHANNEL_NONE,
  EF_ALIVE,
  EF_HOLSTERED,
  EF_PROTECTED,
  SELF_ALIVE,
  SELF_HOLSTERED,
  SELF_IN_SHOWDOWN,
} from '../src/experiments/out-west/contract/town.ts'
import {
  dodgeAnim,
  jumpAnim,
  ownAnim,
  ownFlags,
  verticalAnim,
} from '../src/experiments/out-west/ffa/client/game-anim.ts'
import { makeMoveState } from '../src/experiments/out-west/ffa/sim/types.ts'

describe('frontier animation helpers', () => {
  it('picks a hop or a vault only while a jump is under way', () => {
    expect(jumpAnim(0, 0)).toBe(0)
    expect(jumpAnim(1, 0)).toBe(ANIM_HOP)
    expect(jumpAnim(1, 2)).toBe(ANIM_VAULT)
  })

  it('reads a climb as a vault and a fall as a hop', () => {
    const m = makeMoveState(0, 0)
    expect(verticalAnim(m)).toBe(0)
    m.climbTicks = 1
    expect(verticalAnim(m)).toBe(ANIM_VAULT)
    m.climbTicks = 0
    m.fallTicks = 1
    expect(verticalAnim(m)).toBe(ANIM_HOP)
  })

  it('reads a roll before a slide', () => {
    const m = makeMoveState(0, 0)
    expect(dodgeAnim(m)).toBe(0)
    m.slideTicks = 1
    expect(dodgeAnim(m)).toBe(ANIM_SLIDE)
    m.rollTicks = 1
    expect(dodgeAnim(m)).toBe(ANIM_ROLL)
  })

  it('gives death and the showdown priority over the move', () => {
    expect(ownAnim(0, 0, true, false, CHANNEL_NONE, 0)).toBe(ANIM_DEAD)
    expect(ownAnim(SELF_ALIVE | SELF_IN_SHOWDOWN, 0, true, false, CHANNEL_NONE, 0)).toBe(ANIM_DUEL)
    expect(ownAnim(SELF_ALIVE, ANIM_ROLL, true, false, CHANNEL_NONE, 0)).toBe(ANIM_ROLL)
    expect(ownAnim(SELF_ALIVE, 0, true, false, CHANNEL_NONE, 0)).toBe(ANIM_RUN)
    expect(ownAnim(SELF_ALIVE, 0, false, false, CHANNEL_NONE, 0)).toBe(ANIM_IDLE)
  })

  it('translates the self flags for the crowd', () => {
    expect(ownFlags(0, false)).toBe(0)
    expect(ownFlags(SELF_ALIVE, false)).toBe(EF_ALIVE)
    expect(ownFlags(SELF_ALIVE, true)).toBe(EF_ALIVE | EF_PROTECTED)
    expect(ownFlags(SELF_ALIVE | SELF_HOLSTERED, false)).toBe(EF_ALIVE | EF_HOLSTERED)
  })
})
