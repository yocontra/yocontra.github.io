import { expect, test as it } from 'bun:test'
import { Entity } from 'playcanvas'
import { CameraRig } from '../../src/experiments/out-west/duel/native-camera.ts'
import { titleShot } from '../../src/experiments/out-west/duel/native-framing.ts'
import { settleTurn } from '../../src/experiments/out-west/duel/native-moments.ts'
import { hubShot } from '../../src/experiments/out-west/duel/native-presentation.ts'
import { simulate } from './duel-sim.ts'

it('title crane plays once and holds its street view, with no movement under reduced motion', () => {
  const sim = simulate({ level: 0, random: 0.5 })
  const camera = new Entity('camera')
  const rig = new CameraRig(camera)
  Object.assign(sim.d, { rig })
  try {
    titleShot(sim.d)
    rig.update(0)
    const start = rig.pose()
    rig.update(7)
    expect(rig.pose().pos.y).toBeLessThan(start.pos.y)
    rig.update(7)
    const settled = rig.pose()
    expect(settled.pos.y).toBe(2)
    expect(settled.pos.y).toBeLessThan(start.pos.y)
    rig.update(28)
    expect(rig.pose().pos.equals(settled.pos)).toBe(true)
    expect(rig.pose().look.equals(settled.look)).toBe(true)
    sim.d.c.save.settings.reducedMotion = true
    titleShot(sim.d)
    rig.update(0)
    const stationary = rig.pose()
    rig.update(6.5)
    expect(rig.pose().pos.equals(stationary.pos)).toBe(true)
    rig.update(7.5)
    expect(rig.pose().look.equals(stationary.look)).toBe(true)
  } finally {
    camera.destroy()
    sim.restore()
  }
})

it('a shot completes only its shooter turn before hitstop', () => {
  const sim = simulate({ level: 0, random: 0.5 })
  try {
    const player = sim.d.player
    const enemy = sim.d.enemy
    if (!(player && enemy)) {
      throw new Error('Fixture actors missing')
    }
    let playerYaw = 90
    let enemyYaw = 45
    Object.assign(player, {
      face: (value: number) => {
        playerYaw = value
      },
    })
    Object.assign(enemy, {
      face: (value: number) => {
        enemyYaw = value
      },
    })
    const other = { actor: enemy, from: 0, to: 180, t: 0.2, secs: 0.4 }
    sim.d.m.turns = [{ actor: player, from: 180, to: 0, t: 0.2, secs: 0.4 }, other]
    settleTurn(sim.d, player)
    expect(playerYaw).toBe(0)
    expect(enemyYaw).toBe(45)
    expect(sim.d.m.turns).toEqual([other])
    settleTurn(sim.d, player)
    expect(sim.d.m.turns).toEqual([other])
  } finally {
    sim.restore()
  }
})

it('returning from Outfitter retains the settled native title shot instead of replaying the crane', () => {
  const sim = simulate({ level: 0, random: 0.5 })
  const camera = new Entity('camera')
  const rig = new CameraRig(camera)
  Object.assign(sim.d, {
    rig,
    game: { app: { scene: {} }, camera },
    arenas: { show: () => Promise.resolve(), life: {} },
    atmosphere: { arrange: () => undefined },
  })
  try {
    hubShot(sim.d, 'hub')
    expect(rig.owner).toBe('hub')
    rig.update(20)
    const time = rig.shotTime
    const settled = rig.pose()
    // The source camera can return without a DOM or a store-side projection lens.
    hubShot(sim.d, 'store')
    hubShot(sim.d, 'hub')
    expect(rig.shotTime).toBe(time)
    expect(rig.pose().pos.equals(settled.pos)).toBe(true)
    expect(rig.pose().look.equals(settled.look)).toBe(true)
    // A duel cut can reuse a display label; ownership, rather than that label, controls reuse.
    rig.cut('title', () => settled)
    expect(rig.owner).toBe('duel')
    hubShot(sim.d, 'hub')
    expect(rig.owner).toBe('hub')
    expect(rig.shotTime).toBe(0)
    rig.release()
    expect(rig.owner).toBeNull()
  } finally {
    camera.destroy()
    sim.restore()
  }
})
