import { expect, test as it } from 'bun:test'
import { Entity } from 'playcanvas'
import { animateRider } from '../../src/experiments/out-west/client/actor-animation.ts'
import { createRiderPose } from '../../src/experiments/out-west/client/actor-pose.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { newPlayer } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { equippedActor } from '../../src/experiments/out-west/scene/native-equipment.ts'
import { firstPersonFixture, flush } from './first-person-fixture.ts'

it('finishes the native shot endpoint when the wall deadline precedes the animation clock by 0.1ms', async () => {
  const f = firstPersonFixture()
  try {
    const url = 'fixture://viewmodels/outfit.trail-duds.glb'
    const load = equippedActor(
      f.game,
      DEFAULT_LOADOUT,
      {},
      { viewmodel: { url, tracks: f.request.world.tracks } },
    )
    f.requests[0]?.finish()
    await flush()
    const actor = await load
    const pose = createRiderPose(f.game, actor)
    actor.root.enabled = true
    const rider = {
      actor,
      clip: '',
      aim: pose.aim,
      weaponLayer: pose.weapon,
      firingUntil: performance.now() - 1,
    }
    pose.weapon.play('Gun_Shoot')
    pose.weapon.activeStateCurrentTime = pose.weapon.activeStateDuration * 0.9995
    animateRider(rider, f.request.player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Gun_Shoot')
    f.app.systems.fire('animationUpdate', 0.001)
    expect(pose.weapon.activeStateCurrentTime).toBe(pose.weapon.activeStateDuration)
    animateRider(rider, f.request.player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Idle_Gun_Pointing')
    // A new life cancels an old shot even if its paused native clock had not finished.
    pose.weapon.transition('Gun_Shoot', 0)
    rider.firingUntil = 0
    animateRider(rider, f.request.player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Idle_Gun_Pointing')
    actor.destroy()
  } finally {
    f.dispose()
  }
})

it('a real first-person shot can restart through interrupted life transitions without stale blend clips', async () => {
  const f = firstPersonFixture()
  const domain = newPlayer(0, {
    accountId: 'self',
    name: 'Rider',
    level: 1,
    prestige: 0,
    bot: false,
  })
  domain.alive = true
  domain.spawnTick = 1
  const request = { ...f.request, domain }
  try {
    const loading = f.model.prepare(request)
    await f.finish()
    await loading
    f.model.update(request)
    f.model.present(f.camera, 1 / 60)
    for (let life = 2; life <= 4; life++) {
      f.model.fire('self', false)
      f.app.systems.fire('animationUpdate', 0.01)
      domain.spawnTick = life
      expect(() => f.model.update(request)).not.toThrow()
      expect(f.model.ready).toBe(true)
    }
  } finally {
    f.dispose()
  }
})

it('returning after a canceled first-person view cannot resume a stale paused shot', async () => {
  const f = firstPersonFixture()
  try {
    const loading = f.model.prepare(f.request)
    await f.finish()
    await loading
    f.model.update(f.request)
    f.model.present(f.camera, 1 / 60)
    const actor = f.actors()[0]
    if (!actor) {
      throw new Error('Missing prepared actor')
    }
    const restPosition = actor.getLocalPosition().clone()
    const restRotation = actor.getLocalRotation().clone()
    f.model.fire('self', false)
    f.model.update(undefined)
    // Native arms are disabled while third-person is active; their clock does not advance.
    await new Promise<void>((resolve) => setTimeout(resolve, 230))
    f.model.update(f.request)
    f.model.present(f.camera, 1 / 60)
    const upper = f.actors()[0]?.findByName('upper-body-pose')
    expect(upper instanceof Entity && upper.anim?.baseLayer?.activeState).toBe('Idle_Gun_Pointing')
    expect(actor.getLocalPosition().clone().sub(restPosition).length()).toBeLessThan(1e-6)
    expect(actor.getLocalRotation().equals(restRotation)).toBe(true)
    const drawn = actor.findByName('mount.WristR.drawn')
    expect(drawn instanceof Entity && drawn.anim?.baseLayer?.activeState).toBe('Weapon_Idle_R')
  } finally {
    f.dispose()
  }
})
