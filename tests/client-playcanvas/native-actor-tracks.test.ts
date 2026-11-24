import { beforeAll, expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { type AnimTrack, type Asset, type ContainerResource, Entity } from 'playcanvas'
import {
  animateRider,
  beginDynamiteThrow,
  beginRecoil,
} from '../../src/experiments/out-west/client/actor-animation.ts'
import { createRiderPose } from '../../src/experiments/out-west/client/actor-pose.ts'
import { AMBIENT_ASSETS } from '../../src/experiments/out-west/content/ambient.ts'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { WEAPON_REVOLVER, WEAPON_RIFLE } from '../../src/experiments/out-west/contract/town.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { RELOAD_TICKS, TICK_MS } from '../../src/experiments/out-west/ffa/sim/constants.ts'
import { newPlayer } from '../../src/experiments/out-west/ffa/sim/state.ts'
import type { PlayerState } from '../../src/experiments/out-west/runtime/protocol.ts'
import { extractFirstPersonArms } from '../../tools/content/first-person-arms.ts'
import { nativeActorFixture } from './native-actor-fixture.ts'

const FIT = 'outfit.trail-duds'
const PHYSICAL = `/experiments/out-west/3d/native-v2/equipment/${FIT}.glb`
const ARMS = '/fixtures/viewmodels/geometry-only.glb'
const POSE_BONES = /^(?:Root|Hips|Abdomen|Torso|Chest|Head|UpperArm[LR]|LowerArm[LR]|Wrist[LR])$/u
let armsBytes: Uint8Array
beforeAll(async () => {
  armsBytes = (await extractFirstPersonArms(FIT, { geometryOnly: true })).bytes
}, 30_000)

function fixture() {
  return nativeActorFixture(async (url) =>
    url === ARMS ? armsBytes : await readFile(`public${url.split('?')[0]}`),
  )
}

function anim(actor: DuelActor) {
  const component = actor.model.anim
  if (!component?.baseLayer) {
    throw new Error('Actual native animation graph missing')
  }
  return component
}
function resource(asset: Asset): ContainerResource {
  return asset.resource as ContainerResource
}
function track(asset: Asset, name: string): AnimTrack {
  const result = resource(asset).animations.find((entry) => entry.resource?.name === name)?.resource
  if (!result) {
    throw new Error(`Missing authored ${name}`)
  }
  return result as AnimTrack
}

function keyframes(tracks: readonly AnimTrack[]): string {
  return JSON.stringify(
    tracks.map((entry) => ({
      name: entry.name,
      duration: entry.duration,
      inputs: entry.inputs.map((data) => [data.components, Array.from(data.data)]),
      outputs: entry.outputs.map((data) => [data.components, Array.from(data.data)]),
      paths: entry.curves.map((curve) => curve.paths),
    })),
  )
}

it('real clip-free arms reuse physical merged tracks before native graph/index/mask construction', async () => {
  const f = fixture()
  let physical: DuelActor | undefined
  let arms: DuelActor | undefined
  try {
    physical = await DuelActor.create(f.game, PHYSICAL, 'physical')
    const native = await f.game.loadContainer(PHYSICAL)
    const moves = await f.game.loadContainer(ASSETS.moves.url)
    expect(physical.tracks).toHaveLength(88)
    expect(physical.animationTrack('Gun_Shoot')).toBe(track(native, 'Gun_Shoot'))
    expect(physical.animationTrack('Gun_Shoot')).not.toBe(track(moves, 'Gun_Shoot'))
    const before = keyframes(physical.tracks)
    arms = await DuelActor.create(f.game, ARMS, 'arms', {
      enabled: false,
      tracks: physical.tracks,
      humanoid: true,
    })
    expect(resource(await f.game.loadContainer(ARMS)).animations).toHaveLength(0)
    expect(arms.root.enabled).toBe(false)
    expect(arms.tracks).not.toBe(physical.tracks)
    expect(arms.tracks).toHaveLength(88)
    for (const [index, entry] of arms.tracks.entries()) {
      expect(physical.tracks[index]).toBe(entry)
      expect(arms.animationTrack(entry.name)).toBe(entry)
      expect(anim(arms).baseLayer?.states).toContain(entry.name)
    }
    expect(arms.upperBodyMask()).toEqual(physical.upperBodyMask())
    expect(arms.gaitSpeeds).toEqual(physical.gaitSpeeds)
    arms.root.enabled = true
    const body = anim(physical)
    const view = anim(arms)
    const joints = physical.model.findByName('WristR')?.parent
    expect(joints).toBeTruthy()
    const positions = (actor: DuelActor) =>
      actor.model
        .find(() => true)
        .filter((node) => POSE_BONES.test(node.name))
        .map((node) => [node.name, Array.from(node.getLocalTransform().data)] as const)
    // The world actor intentionally tucks the skull over the shoulders. Arms
    // borrow the unchanged source position, since their lens follows Head.
    const sharedPose = (actor: DuelActor) =>
      positions(actor).map(([name, matrix]) => [
        name,
        name === 'Head' ? [...matrix.slice(0, 12), matrix[15]] : matrix,
      ])
    for (const entry of physical.tracks) {
      body.baseLayer?.play(entry.name)
      view.baseLayer?.play(entry.name)
      body.update(0.037)
      view.update(0.037)
      expect(sharedPose(arms)).toEqual(sharedPose(physical))
    }
    physical.play('Walk', 0)
    arms.play('Walk', 0)
    physical.play('Gun_Shoot', 0)
    arms.play('Gun_Shoot', 0)
    body.update(0.05)
    const physicalTime = body.baseLayer?.activeStateCurrentTime
    const frozenPhysicalPose = positions(physical)
    view.update(0.199)
    const shotDuration = arms.animationTrack('Gun_Shoot')?.duration
    if (shotDuration === undefined) {
      throw new Error('Missing real shoot track')
    }
    // Native controller time is in track seconds. Its progress getter re-applies clip speed.
    expect(view.baseLayer?.activeStateCurrentTime).toBeCloseTo(shotDuration * 0.995)
    expect(view.baseLayer?.activeStateCurrentTime).toBeLessThan(shotDuration)
    expect(body.baseLayer?.activeStateCurrentTime).toBe(physicalTime)
    expect(positions(physical)).toEqual(frozenPhysicalPose)
    view.update(0.002)
    expect(view.baseLayer?.activeStateCurrentTime).toBeCloseTo(shotDuration)
    expect(keyframes(physical.tracks)).toBe(before)
    arms.destroy()
    arms = undefined
    physical.play('Walk', 0)
    expect(() => body.update(0.1)).not.toThrow()
    expect(f.textures.size).toBeGreaterThan(0)
  } finally {
    arms?.destroy()
    physical?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('an explicit humanoid builds native shared animation on an empty-clip geometry URL', async () => {
  const f = fixture()
  let actor: DuelActor | undefined
  try {
    actor = await DuelActor.create(f.game, ARMS, 'shared-only humanoid', {
      enabled: true,
      humanoid: true,
    })
    expect(actor.tracks).toHaveLength(78)
    expect(actor.hasAnimation('Idle_Character')).toBe(true)
    expect(actor.hasAnimation('Gun_Shoot')).toBe(true)
    actor.play('Gun_Shoot', 0)
    anim(actor).update(0.201)
    expect(anim(actor).baseLayer?.activeStateCurrentTime).toBeCloseTo(
      actor.animationTrack('Gun_Shoot')?.duration ?? 0,
    )
  } finally {
    actor?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('default native animals retain their source clips and one-second playback rate', async () => {
  const f = fixture()
  let crow: DuelActor | undefined
  try {
    crow = await DuelActor.create(f.game, AMBIENT_ASSETS.crow.url, 'crow')
    expect(crow.tracks).toHaveLength(3)
    expect(f.requests).not.toContain(ASSETS.moves.url)
    crow.play('Gun_Shoot', 0)
    anim(crow).update(0.1)
    expect(anim(crow).baseLayer?.activeStateCurrentTime).toBeCloseTo(0.1)
    expect(anim(crow).baseLayer?.activeStateProgress).toBeLessThan(0.1)
  } finally {
    crow?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('removed stage rejects arms creation without adopting late native resources', async () => {
  const f = fixture()
  try {
    const physical = await DuelActor.create(f.game, PHYSICAL, 'physical')
    const tracks = physical.tracks
    physical.destroy()
    f.stage.remove()
    const result = await DuelActor.create(f.game, ARMS, 'cancelled arms', {
      enabled: false,
      tracks,
      humanoid: true,
    }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(DOMException)
    expect(f.stage.children).toHaveLength(0)
    expect(f.textures.size).toBe(0)
  } finally {
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('paired local carry and disabled socket inspection use native authored mount state', async () => {
  const f = fixture()
  let actor: DuelActor | undefined
  try {
    const physical = await DuelActor.create(f.game, PHYSICAL, 'physical')
    actor = await DuelActor.create(f.game, ARMS, 'disabled presentation', {
      enabled: false,
      tracks: physical.tracks,
      humanoid: true,
    })
    physical.destroy()
    const mount = (hand: 'L' | 'R', weapon?: 'rifle') => {
      const node = new Entity(`mount.${weapon ?? hand}`, f.app)
      const socket = new Entity('socket.muzzle', f.app)
      const wrist = actor?.model.findByName(`Wrist${hand}`)
      if (!(wrist instanceof Entity)) {
        throw new Error('Missing actual authored wrist')
      }
      wrist.addChild(node)
      node.addChild(socket)
      socket.setLocalPosition(0.12, 0.01, 0)
      actor?.weaponMounts.push({ node, drawn: true, hand, ...(weapon ? { weapon } : {}) })
      return { node, socket }
    }
    const right = mount('R')
    const left = mount('L')
    actor.paired = true
    actor.hold('revolver', true)
    expect(actor.animation('Gun_Shoot')).toBe('Gun_Shoot')
    expect(actor.muzzleSocket()).toBeNull()
    expect(actor.muzzleSocket(true)).toBe(right.socket)
    actor.root.enabled = true
    expect(left.node.enabled).toBe(false)
    expect(right.node.enabled).toBe(true)
    actor.pairedDrawn = true
    actor.hold('revolver', true)
    expect(actor.animation('Gun_Shoot')).toBe('Gun_Shoot_Pair')
    expect(left.node.enabled).toBe(true)
    expect(right.node.enabled).toBe(true)
    const pose = actor.muzzle()
    expect(pose?.position.distance(right.socket.getPosition())).toBe(0)
    expect(pose?.direction.length()).toBeCloseTo(1)
    actor.hold('rifle', true)
    actor.root.enabled = false
    // A hidden staged rifle must not silently borrow an inactive revolver landmark.
    expect(actor.muzzleSocket(true)).toBeNull()
    const rifle = mount('R', 'rifle')
    actor.hold('rifle', true)
    expect(actor.muzzleSocket()).toBeNull()
    expect(actor.muzzleSocket(true)).toBe(rifle.socket)
    actor.root.enabled = true
    const detached = actor.detach('gun')
    expect(detached).toBe(rifle.node)
    expect(actor.muzzleSocket(true)).toBeNull()
    actor.restoreAttachments()
    expect(actor.muzzleSocket()).toBe(rifle.socket)
    actor.hold('revolver', true)
    const legacyRight = actor.weaponMounts.find((entry) => entry.node === right.node)
    if (!legacyRight) {
      throw new Error('Missing right mount')
    }
    // Historical runtime mounts can omit hand even though the current descriptor type requires it.
    Reflect.deleteProperty(legacyRight, 'hand')
    expect(actor.detach('gun', 'R')).toBe(right.node)
    actor.restoreAttachments()
  } finally {
    actor?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('native dynamite upper-body timing survives gait and stance changes and clears on death', async () => {
  const f = fixture()
  let actor: DuelActor | undefined
  try {
    actor = await DuelActor.create(f.game, PHYSICAL, 'throwing rider')
    const pose = createRiderPose(f.game, actor)
    const rider = {
      actor,
      clip: '',
      aim: pose.aim,
      weaponLayer: pose.weapon,
      firingUntil: 0,
      throwingUntil: 0,
    }
    const player: PlayerState = {
      id: '0',
      x: 0,
      y: 0.9,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0.7,
      grounded: true,
      crouched: false,
      hp: 100,
      ammo: 6,
      seq: 0,
    }
    beginDynamiteThrow(rider, player)
    pose.root.anim?.update(0.035)
    expect(pose.weapon.activeState).toBe('Throw_Dynamite')
    expect(pose.aim.weight).toBe(0)
    rider.throwingUntil = performance.now() + 10_000
    pose.weapon.activeStateCurrentTime = 0.15
    player.vx = 5.5
    animateRider(rider, player, { first: true, domain: undefined })
    expect(rider.clip).toStartWith('Stride_Run')
    expect(pose.root.anim?.speed).toBe(1)
    pose.root.anim?.update(0.1)
    expect(pose.weapon.activeStateCurrentTime).toBeCloseTo(0.25)
    player.crouched = true
    animateRider(rider, player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Crouch_Throw_Dynamite')
    expect(pose.weapon.activeStateCurrentTime).toBeCloseTo(0.25)
    player.vx = 0
    player.crouched = false
    animateRider(rider, player, { first: false, domain: undefined })
    expect(pose.weapon.activeStateCurrentTime).toBeCloseTo(0.25)
    pose.root.anim?.update(1)
    expect(pose.weapon.activeStateCurrentTime).toBeCloseTo(0.7, 6)
    player.hp = 0
    animateRider(rider, player, { first: true, domain: undefined })
    expect(rider.throwingUntil).toBe(0)
    expect(pose.weapon.weight).toBe(0)
    player.hp = 100
    animateRider(rider, player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Idle_Gun_Pointing')
    expect(pose.weapon.weight).toBe(1)
    player.hp = 0
    beginDynamiteThrow(rider, player)
    expect(rider.throwingUntil).toBe(0)
  } finally {
    actor?.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('native world and arms layers draw after a pickup and enter reload at the remaining ammo time', async () => {
  const f = fixture()
  const actor = await DuelActor.create(f.game, PHYSICAL, 'handling test')
  try {
    const pose = createRiderPose(f.game, actor)
    const rider = { actor, clip: '', aim: pose.aim, weaponLayer: pose.weapon, firingUntil: 0 }
    const domain = newPlayer(0, { accountId: '', name: '', prestige: 0, level: 1, bot: false })
    domain.alive = true
    const body: PlayerState = {
      id: '0',
      x: 0,
      y: 0.9,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      grounded: true,
      hp: 100,
      ammo: 6,
      seq: 0,
    }
    body.vz = -0.94
    animateRider(rider, body, { first: false, domain })
    const lower = anim(actor).baseLayer
    if (!lower) {
      throw new Error('Missing locomotion layer')
    }
    expect(lower.activeState).toBe('Stride_Walk_0')
    lower.activeStateCurrentTime = lower.activeStateDuration * 1.65
    body.vz = 0
    body.vx = 0.94
    animateRider(rider, body, { first: false, domain })
    expect(lower.activeState).toBe('Stride_Walk_6')
    expect(lower.activeStateCurrentTime / lower.activeStateDuration).toBeCloseTo(0.65)
    body.vx = 0
    for (const first of [true, false]) {
      domain.weapon = WEAPON_RIFLE
      body.crouched = false
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Hold_rifle')
      domain.weapon = WEAPON_REVOLVER
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Draw')
      pose.root.anim?.update(0.1)
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Draw')
      pose.root.anim?.update(0.3)
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Idle_Gun_Pointing')

      domain.weapon = WEAPON_RIFLE
      animateRider(rider, body, { first, domain })
      domain.weapon = WEAPON_REVOLVER
      animateRider(rider, body, { first, domain })
      beginRecoil(rider, 'revolver')
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Gun_Shoot')
      pose.root.anim?.update(0.04)
      const recoilTime = pose.weapon.activeStateCurrentTime
      body.crouched = true
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Gun_Shoot')
      expect(pose.weapon.activeStateCurrentTime).toBe(recoilTime)
      rider.firingUntil = 0
      body.crouched = false
      domain.reloadTicks = 15
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Reload')
      expect(pose.weapon.activeStateCurrentTime / pose.weapon.activeStateDuration).toBeCloseTo(
        1 - 15 / RELOAD_TICKS,
      )
      pose.root.anim?.update((4 * TICK_MS) / 1000)
      expect(pose.weapon.activeStateCurrentTime / pose.weapon.activeStateDuration).toBeCloseTo(
        1 - 11 / RELOAD_TICKS,
      )
      domain.reloadTicks = 4
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeStateCurrentTime / pose.weapon.activeStateDuration).toBeCloseTo(
        1 - 4 / RELOAD_TICKS,
      )
      domain.reloadTicks = 11
      body.crouched = true
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Crouch_Reload')
      expect(pose.weapon.activeStateCurrentTime / pose.weapon.activeStateDuration).toBeCloseTo(
        1 - 11 / RELOAD_TICKS,
      )
      pose.root.anim?.update((11 * TICK_MS) / 1000)
      expect(pose.weapon.activeStateCurrentTime / pose.weapon.activeStateDuration).toBeCloseTo(1)
      domain.reloadTicks = 0
      animateRider(rider, body, { first, domain })
      expect(pose.weapon.activeState).toBe('Crouch_Idle_Gun_Pointing')
    }
  } finally {
    actor.destroy()
    expect(await f.destroy()).toEqual({ textures: 0, buffers: 0 })
  }
})

it('each equipped Frontier weapon layer keeps the standing head near the shoulder line', async () => {
  for (const entry of Object.values(EQUIPMENT)) {
    if (!('pair' in entry && entry.url.includes('/outfit.'))) {
      continue
    }
    for (const url of [entry.url, entry.pair.url]) {
      const f = nativeActorFixture()
      try {
        const actor = await DuelActor.create(f.game, url, 'rider')
        const pose = createRiderPose(f.game, actor)
        actor.play('Stride_Run_0', 0)
        pose.weapon.play(actor.animation('Idle_Gun_Pointing'))
        for (let frame = 0; frame < 12; frame++) {
          anim(actor).update(1 / 60)
          pose.root.anim?.update(1 / 60)
        }
        const at = (name: string) => {
          const bone = actor.model.findByName(name)
          if (!bone) {
            throw new Error(`Missing ${name} in ${url}`)
          }
          return bone.getPosition()
        }
        const forward = at('Head').z - (at('UpperArmL').z + at('UpperArmR').z) / 2
        expect(forward, url).toBeLessThan(0.06)
        expect(forward, url).toBeGreaterThan(-0.02)
      } finally {
        await f.destroy()
      }
    }
  }
})
