import { expect, test as it } from 'bun:test'
import type { Entity } from 'playcanvas'
import depot from '../../src/experiments/out-west/content/depot.json' with { type: 'json' }
import streetLife from '../../src/experiments/out-west/content/street-life.json' with {
  type: 'json',
}
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import { NativeAtmosphere } from '../../src/experiments/out-west/duel/native-atmosphere.ts'
import { retry } from '../../src/experiments/out-west/duel/native-progress.ts'
import { simulate } from '../duel-playcanvas/duel-sim.ts'
import { nativeActorFixture } from './native-actor-fixture.ts'

it('a campaign crow fake-out and the duel result share one bounded flight', async () => {
  const f = nativeActorFixture()
  const atmosphere = new NativeAtmosphere(f.game)
  const life = {
    ...streetLife,
    allocation: { crows: 2, folk: 0, horses: 0, hens: 0, dog: false, fakeouts: false },
  }
  try {
    await atmosphere.load(life)
    atmosphere.arrange(life)
    const crow = f.stage.findByName('town-crow-0') as Entity
    const perch = crow.getPosition().clone()
    atmosphere.cue('crow', null)
    for (let i = 0; i < 40; i++) {
      atmosphere.update(0.1, 'cock')
    }
    for (let i = 0; i < 41; i++) {
      atmosphere.update(0.1, 'win')
    }
    expect(crow.enabled).toBe(false)
    expect(crow.getPosition().x - perch.x).toBeCloseTo(27.2)
    const endpoint = crow.getPosition().clone()
    atmosphere.cue('crow', null)
    atmosphere.update(0.1, 'win')
    expect(crow.enabled).toBe(false)
    expect(crow.getPosition()).toEqual(endpoint)
    atmosphere.arrange(life)
    expect(crow.enabled).toBe(true)
    expect(crow.getPosition()).toEqual(perch)
    atmosphere.cue('crow', null)
    atmosphere.update(0.1, 'cock')
    expect(crow.getPosition().x - perch.x).toBeCloseTo(0.34)
  } finally {
    atmosphere.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('takeoff respects missing perches and the next arena resets the authored flock', async () => {
  const f = nativeActorFixture()
  const atmosphere = new NativeAtmosphere(f.game)
  const life = {
    ...streetLife,
    crowPerches: [{ x: 8, y: 3, z: 4 }],
    allocation: { crows: 2, folk: 0, horses: 0, hens: 0, dog: false, fakeouts: false },
  }
  try {
    await atmosphere.load(life)
    atmosphere.arrange(life)
    const perched = f.stage.findByName('town-crow-0') as Entity
    const hidden = f.stage.findByName('town-crow-1') as Entity
    const original = hidden.getPosition().clone()
    expect(perched.enabled).toBe(true)
    expect(hidden.enabled).toBe(false)
    atmosphere.update(0.1, 'win')
    expect(perched.getPosition().x).toBeCloseTo(8.34)
    expect(hidden.enabled).toBe(false)
    expect(hidden.getPosition()).toEqual(original)
    atmosphere.arrange(depot.life)
    expect(perched.enabled).toBe(true)
    expect(hidden.enabled).toBe(true)
    expect(perched.getPosition().x).toBeCloseTo(depot.life.crows.x)
    expect(perched.getPosition().y).toBeCloseTo(depot.life.crows.y)
    expect(perched.getPosition().z).toBeCloseTo(depot.life.crows.z - 1.5)
    atmosphere.update(0.1, 'poster')
    atmosphere.update(0.1, 'lose')
    expect(perched.getPosition().x).toBeCloseTo(depot.life.crows.x + 0.34)
  } finally {
    atmosphere.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('in-place duel retries restore the actual flock before it can take off again', async () => {
  const f = nativeActorFixture()
  const atmosphere = new NativeAtmosphere(f.game)
  const life = {
    ...streetLife,
    allocation: { crows: 1, folk: 0, horses: 0, hens: 1, dog: false, fakeouts: false },
  }
  try {
    await atmosphere.load(life)
    const crow = f.stage.findByName('town-crow-0') as Entity
    const hen = f.stage.findByName('town-hen-0') as Entity
    for (const [level, phase] of [
      [0, 'cock'],
      [OUTLAWS.findIndex((outlaw) => outlaw.gimmick === 'boss'), 'wait'],
    ] as const) {
      atmosphere.arrange(life)
      const perch = crow.getPosition().clone()
      const henOrigin = hen.getPosition().clone()
      const sim = simulate({ level, random: 0.5, bossPhase: 2 })
      try {
        Object.assign(sim.d, {
          atmosphere,
          loadFailed: false,
          arenas: {
            life,
            stampPoster: () => undefined,
            clockFace: () => null,
            seatStanceFill: () => undefined,
          },
        })
        atmosphere.cue('crow', null)
        atmosphere.update(0.1, 'lose')
        expect(crow.getPosition().equals(perch)).toBe(false)
        expect(hen.getPosition().equals(henOrigin)).toBe(false)
        sim.d.enter('lose')
        retry(sim.d)
        expect(sim.d.phase).toBe(phase)
        expect(crow.getPosition()).toEqual(perch)
        expect(hen.getPosition()).toEqual(henOrigin)
        atmosphere.update(0, phase)
        atmosphere.cue('crow', null)
        atmosphere.update(0.1, phase)
        expect(crow.getPosition().x - perch.x).toBeCloseTo(0.34)
        expect(hen.getPosition().x - henOrigin.x).toBeCloseTo(-0.16)
      } finally {
        sim.restore()
      }
    }
  } finally {
    atmosphere.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})
