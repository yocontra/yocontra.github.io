/** Real native graph clock and world-space toe-contact checks; no custom animation sampler. */
import type { AnimComponentLayer, ContainerResource, Entity } from 'playcanvas'
import { animateRider } from '../../src/experiments/out-west/client/actor-animation.ts'
import { createRiderPose } from '../../src/experiments/out-west/client/actor-pose.ts'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { ASSETS, DYNAMIC_ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import type { PlayerState } from '../../src/experiments/out-west/runtime/protocol.ts'
import { RECOIL_SECONDS } from '../../src/experiments/out-west/scene/native-animation-timing.ts'
import { nativeCivilianWeapons } from './civilian-weapons.ts'

interface ToeFrame {
  at: number
  toes: { x: number; y: number; z: number }[]
}
const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
function toeSlip(frames: ToeFrame[], speed: number) {
  const minimum = [0, 1].map((foot) => Math.min(...frames.map((frame) => frame.toes[foot]?.y ?? 0)))
  const velocities: number[] = []
  for (let index = 1; index < frames.length; index++) {
    const before = frames[index - 1]
    const after = frames[index]
    if (!(before && after)) {
      continue
    }
    for (const foot of [0, 1]) {
      const a = before.toes[foot]
      const b = after.toes[foot]
      if (!(a && b)) {
        continue
      }
      const velocity = (b.z - a.z) / (after.at - before.at)
      // Keep the low, rearward-moving stance portion, never the airborne forward swing.
      if (Math.max(a.y, b.y) < (minimum[foot] ?? 0) + 0.035 && velocity + speed > speed * 0.5) {
        velocities.push(velocity)
      }
    }
  }
  return {
    contacts: velocities.length,
    median: median(velocities),
    medianAbsolute: median(velocities.map(Math.abs)),
  }
}
function body(speed: number, crouched: boolean): PlayerState {
  return {
    id: 'timing',
    x: 0,
    y: 0.9,
    z: 0,
    vx: 0,
    vy: 0,
    vz: -speed,
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouched,
    hp: 100,
    ammo: 6,
    seq: 0,
  }
}
function current(layer: AnimComponentLayer | null | undefined): AnimComponentLayer {
  if (!layer) {
    throw new Error('Missing native animation layer')
  }
  return layer
}

export async function nativeCharacterTiming() {
  document.body.replaceChildren()
  document.body.style.cssText = 'margin:0;height:100vh'
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const game = await GameApplication.create({ canvas, viewport: document.body, pixelRatio: 1 })
  game.app.timeScale = 0
  game.app.autoRender = false
  let actor: DuelActor | undefined
  try {
    actor = await DuelActor.create(game, ASSETS['outlaw-0'].url, 'timing')
    actor.face(180)
    actor.hold('revolver', true)
    const pose = createRiderPose(game, actor)
    const rider = { actor, clip: '', aim: pose.aim, weaponLayer: pose.weapon, firingUntil: 0 }
    const toes = ['ToeTipL', 'ToeTipR'].map((name) => {
      const node = actor?.model.findByName(name)
      if (!node) {
        throw new Error(`Missing native ${name}`)
      }
      return node
    })
    const step = (dt: number) => game.app.systems.fire('animationUpdate', dt)
    const gaits: {
      fps: number
      speed: number
      clip: string
      rate: number
      nativeTime: number
      wallSeconds: number
      slip: ReturnType<typeof toeSlip>
    }[] = []
    for (const fps of [30, 60, 100]) {
      for (const speed of [1, 5.5, 7.6, 2.9]) {
        const player = body(speed, speed === 2.9)
        rider.clip = ''
        animateRider(rider, player, { first: false, domain: undefined })
        step(0.15)
        const layer = current(actor.model.anim?.baseLayer)
        layer.activeStateCurrentTime = 0
        actor.place(0, 0, 0)
        step(0)
        const before = layer.activeStateCurrentTime
        const frames: ToeFrame[] = []
        for (let frame = 0; frame <= fps * 1.5; frame++) {
          actor.place(0, 0, (-speed * frame) / fps)
          frames.push({
            at: frame / fps,
            toes: toes.map((toe) => {
              const position = toe.getPosition()
              return { x: position.x, y: position.y, z: position.z }
            }),
          })
          if (frame < fps * 1.5) {
            animateRider(rider, player, { first: false, domain: undefined })
            step(1 / fps)
          }
        }
        gaits.push({
          fps,
          speed,
          clip: layer.activeState,
          rate: actor.model.anim?.speed ?? 0,
          nativeTime: layer.activeStateCurrentTime - before,
          wallSeconds: 1.5,
          slip: toeSlip(frames, speed),
        })
      }
    }
    const resource = (await game.loadContainer(ASSETS['outlaw-0'].url))
      .resource as ContainerResource
    const mechanisms = new Map(
      resource.animations.map((asset) => {
        const track = asset.resource as import('playcanvas').AnimTrack
        return [track.name, track.duration]
      }),
    )
    const shots: {
      fps: number
      weapon: string
      clip: string
      seconds: number
      nativeTime: number
      duration: number
      mechanisms: { clip: string | undefined; nativeTime: number; duration: number }[]
    }[] = []
    for (const fps of [30, 60, 100]) {
      for (const weapon of ['revolver', 'rifle', 'shotgun'] as const) {
        actor.hold(weapon, true)
        rider.firingUntil = Number.POSITIVE_INFINITY
        animateRider(rider, body(0, false), { first: false, domain: undefined })
        const clip = actor.shotClip()
        pose.weapon.play(clip)
        pose.root.anim?.update(0)
        actor.fireWeapon()
        for (let frame = 0; frame < Math.round(fps * RECOIL_SECONDS); frame++) {
          step(1 / fps)
        }
        const duration = actor.animationTrack(clip)?.duration ?? 0
        shots.push({
          fps,
          weapon,
          clip,
          seconds: RECOIL_SECONDS,
          nativeTime: pose.weapon.activeStateCurrentTime,
          duration,
          mechanisms:
            weapon === 'revolver'
              ? actor.weaponMounts
                  .filter((mount) => mount.drawn)
                  .map((mount) => {
                    const layer = (mount.node as Entity).anim?.baseLayer
                    return {
                      clip: layer?.activeState,
                      nativeTime: layer?.activeStateCurrentTime ?? 0,
                      duration: mechanisms.get(layer?.activeState ?? '') ?? 0,
                    }
                  })
              : [],
        })
      }
    }
    actor.destroy()
    actor = undefined
    shots.push(...(await pairedRecoil(game, step)))
    const cues = await nativeCues(game, step)
    const civilian = await nativeCivilianWeapons(game)
    return { gaits, shots, cues, civilian }
  } finally {
    actor?.destroy()
    game.destroy()
  }
}

async function nativeCues(game: GameApplication, step: (dt: number) => void) {
  const cues: { name: string; duration: number; nativeTime: number }[] = []
  for (const name of ['coin', 'card', 'tumbleweed'] as const) {
    const cue = await DuelActor.create(game, DYNAMIC_ASSETS[name].url, name)
    try {
      const track = cue.animationTrack('Gun_Shoot')
      if (!track) {
        throw new Error(`Missing native cue ${name}`)
      }
      cue.play('Gun_Shoot', 0)
      step(0.1)
      cues.push({
        name,
        duration: track.duration,
        nativeTime: current(cue.model.anim?.baseLayer).activeStateCurrentTime,
      })
    } finally {
      cue.destroy()
    }
  }
  return cues
}

async function pairedRecoil(game: GameApplication, step: (dt: number) => void) {
  const actor = await DuelActor.create(game, ASSETS['outlaw-5'].url, 'paired-timing')
  try {
    if (!actor.paired) {
      throw new Error('Paired native recoil fixture must own both actual mounted revolvers')
    }
    const resource = (await game.loadContainer(ASSETS['outlaw-5'].url))
      .resource as ContainerResource
    const durations = new Map(
      resource.animations.map((asset) => {
        const track = asset.resource as import('playcanvas').AnimTrack
        return [track.name, track.duration]
      }),
    )
    return [30, 60, 100].map((fps) => {
      actor.play('Idle_Gun_Pointing', 0)
      actor.shoot()
      for (let frame = 0; frame < Math.round(fps * RECOIL_SECONDS); frame++) {
        step(1 / fps)
      }
      const clip = actor.shotClip()
      return {
        fps,
        weapon: 'paired-duel',
        clip,
        seconds: RECOIL_SECONDS,
        nativeTime: current(actor.model.anim?.baseLayer).activeStateCurrentTime,
        duration: actor.animationTrack(clip)?.duration ?? 0,
        mechanisms: actor.weaponMounts
          .filter((mount) => mount.drawn)
          .map((mount) => {
            const layer = (mount.node as Entity).anim?.baseLayer
            return {
              clip: layer?.activeState,
              nativeTime: layer?.activeStateCurrentTime ?? 0,
              duration: durations.get(layer?.activeState ?? '') ?? 0,
            }
          }),
      }
    })
  } finally {
    actor.destroy()
  }
}
