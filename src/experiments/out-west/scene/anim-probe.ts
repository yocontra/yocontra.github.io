/**
 * The animation audit's probe (tools/anim-audit.ts): dev and perf-harness builds only
 * (`PUBLIC_OW_PERF_HARNESS=1`, never set for the deploy), so production tree-shakes all of it.
 *
 * Every actor registers his bones twice as he is built: in his rest pose (the bind pose a lost
 * clip would leave him in, a T-pose) and in his idle at t = 0. `globalThis.__owAnim.actors()` then
 * reports, for every live actor, the clips and procedural layers posing him and how far his key
 * bones are from each reference, so a state that silently falls back to idle (or to bind) fails.
 * `__owAnim.stage` is filled in by the duel's lineup (duel/anim-stage.ts) to force states.
 */
import {
  type AnimationAction,
  type AnimationMixer,
  type Bone,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import { boneKey } from './fit.ts'

export const PROBE: boolean = import.meta.env.DEV || import.meta.env.PUBLIC_OW_PERF_HARNESS === '1'

/** What the probe reads off an actor (scene/actor.ts), structurally. */
export interface Probed {
  readonly label: string
  readonly disposed: boolean
  readonly root: Object3D
  readonly meshes: readonly { visible: boolean }[]
  poseWeight: () => number
  readonly drawing: { readonly state: string } | null
  readonly gestures: { readonly weight: number; readonly current: string | null }
  readonly sway: number
  readonly shake: number
  readonly twitch: number
  readonly layer: unknown
  readonly longHeld: { readonly obj: { readonly visible: boolean } } | null
  readonly longKick: number
}

/**
 * The clips posing him and their weights: every action on his mixer, his named clips and any
 * layer built from a sub-clip (Frontier's arm and reload layers), read off three's action list.
 */
function clipsOf(mixer: AnimationMixer): { name: string; w: number }[] {
  const out: { name: string; w: number }[] = []
  const list = (Reflect.get(mixer, '_actions') as AnimationAction[] | undefined) ?? []
  for (const a of list) {
    const w = a.enabled && a.isScheduled() ? a.getEffectiveWeight() : 0
    if (w > 0.01) {
      const name = a.getClip().name.split('|').pop() ?? '?'
      out.push({ name, w: Math.round(w * 100) / 100 })
    }
  }
  return out
}

/** The procedural layers posing him this frame. */
function layersOf(a: Probed): string[] {
  const out: string[] = []
  const d = a.drawing?.state
  if (d && d !== 'off') {
    out.push(`draw:${d}`)
  }
  if (a.gestures.weight > 0.01) {
    out.push(`gesture:${a.gestures.current ?? 'held'}`)
  }
  const flags: [string, boolean][] = [
    ['sway', a.sway > 0],
    ['shake', a.shake > 0],
    ['twitch', a.twitch > 0.001],
    ['layer', a.layer !== null],
  ]
  for (const [name, on] of flags) {
    if (on) {
      out.push(name)
    }
  }
  if (a.longHeld?.obj.visible) {
    out.push(`long:${a.longKick > 0.01 ? 'kick' : 'aim'}`)
  }
  return out
}

/** The bones a pose is judged on: spine, head, arms, legs. */
const KEY = [
  'Hips',
  'Abdomen',
  'Torso',
  'Chest',
  'Neck',
  'Head',
  'UpperArmL',
  'UpperArmR',
  'LowerArmL',
  'LowerArmR',
  'WristL',
  'WristR',
  'UpperLegL',
  'UpperLegR',
  'LowerLegL',
  'LowerLegR',
  'FootL',
  'FootR',
] as const

interface Entry {
  readonly ref: WeakRef<Probed>
  readonly mixer: AnimationMixer
  readonly bones: (Bone | null)[]
  readonly rest: Quaternion[]
  idle: Quaternion[]
  /** Hips height above his root in his idle (m). */
  idleHips: number
}

const entries: Entry[] = []
const byOwner = new WeakMap<object, Entry>()

const DEG = 180 / Math.PI
const angle = (a: Quaternion, b: Quaternion): number =>
  2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * DEG

/** His rest pose (before any clip), as he is built. */
export function probeRest(
  owner: Probed,
  bones: ReadonlyMap<string, Bone>,
  mixer: AnimationMixer,
): void {
  const list = KEY.map((k) => bones.get(boneKey(k)) ?? null)
  const e: Entry = {
    ref: new WeakRef(owner),
    mixer,
    bones: list,
    rest: list.map((b) => (b ? b.quaternion.clone() : new Quaternion())),
    idle: [],
    idleHips: 0,
  }
  entries.push(e)
  byOwner.set(owner, e)
  install()
}

/** His idle at t = 0, right after the first mixer pass. */
export function probeIdle(owner: Probed): void {
  const e = byOwner.get(owner)
  if (!e) {
    return
  }
  e.idle = e.bones.map((b) => (b ? b.quaternion.clone() : new Quaternion()))
  e.idleHips = hipsHeight(e, owner)
}

const hv = new Vector3()
const rv = new Vector3()
/** Hips above the root, world metres (from the last world-matrix update). */
function hipsHeight(e: Entry, a: Probed): number {
  const hips = e.bones[0]
  if (!hips) {
    return 0
  }
  hips.updateWorldMatrix(true, false)
  return hips.getWorldPosition(hv).y - a.root.getWorldPosition(rv).y
}

export interface Measure {
  i: number
  label: string
  shown: boolean
  clips: { name: string; w: number }[]
  layers: string[]
  poseWeight: number
  /** Mean key-bone angle from the rest (bind) pose, degrees. */
  bind: number
  /** Largest key-bone angle from his idle at t = 0, degrees, and which bone. */
  idle: number
  idleBone: string
  /** Hips height change from idle (m; negative = lower). */
  hipsDy: number
  /** Which scene he's drawn in (the top ancestor's name, else its id): the world, a lens. */
  scene: string
  /** Root yaw (rad) and world position. */
  yaw: number
  pos: [number, number, number]
  /** The key bones' quaternions (x, y, z, w each), for motion between samples. */
  q: number[]
}

function shown(root: Object3D): boolean {
  let o: Object3D | null = root
  while (o) {
    if (!o.visible) {
      return false
    }
    if ((o as Object3D & { isScene?: boolean }).isScene) {
      return true
    }
    o = o.parent
  }
  return false
}

function sceneOf(root: Object3D): string {
  let o: Object3D = root
  while (o.parent) {
    o = o.parent
  }
  return o.name || o.uuid.slice(0, 8)
}

function measure(e: Entry, i: number): Measure | null {
  const a = e.ref.deref()
  if (!a || a.disposed) {
    return null
  }
  let bind = 0
  let n = 0
  let idle = 0
  let idleBone = ''
  const q: number[] = []
  for (const [k, b] of e.bones.entries()) {
    const r = e.rest[k]
    const id = e.idle[k]
    if (!(b && r)) {
      q.push(0, 0, 0, 1)
      continue
    }
    bind += angle(b.quaternion, r)
    n++
    const d = id ? angle(b.quaternion, id) : 0
    if (d > idle) {
      idle = d
      idleBone = KEY[k] ?? ''
    }
    q.push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w)
  }
  const p = a.root.getWorldPosition(new Vector3())
  return {
    i,
    label: a.label,
    shown: a.meshes.some((m) => m.visible) && shown(a.root),
    clips: clipsOf(e.mixer),
    layers: layersOf(a),
    poseWeight: a.poseWeight(),
    bind: bind / Math.max(1, n),
    idle,
    idleBone,
    hipsDy: hipsHeight(e, a) - e.idleHips,
    scene: sceneOf(a.root),
    yaw: a.root.rotation.y,
    pos: [p.x, p.y, p.z],
    q,
  }
}

export interface AnimProbe {
  /** Every live actor, measured now. */
  actors: () => Measure[]
  /** One actor (by registry index). */
  measure: (i: number) => Measure | null
  /** One actor's key joints in world space, by bone name (metres). */
  joints: (i: number) => Record<string, [number, number, number]>
  /** The lineup's state driver (duel/anim-stage.ts), once the lineup is up. */
  stage: unknown
}

let installed = false
function install(): void {
  if (installed || !PROBE) {
    return
  }
  installed = true
  const probe: AnimProbe = {
    actors: () => entries.map((e, i) => measure(e, i)).filter((m): m is Measure => m !== null),
    measure: (i) => {
      const e = entries[i]
      return e ? measure(e, i) : null
    },
    joints: (i) => {
      const out: Record<string, [number, number, number]> = {}
      const e = entries[i]
      for (const [k, b] of (e?.bones ?? []).entries()) {
        if (b) {
          b.updateWorldMatrix(true, false)
          const p = b.getWorldPosition(new Vector3())
          out[KEY[k] ?? ''] = [p.x, p.y, p.z]
        }
      }
      return out
    },
    stage: null,
  }
  Reflect.set(globalThis, '__owAnim', probe)
}

/** The registry index of an actor (for the stage to name its subjects). */
export function probeIndex(owner: object): number {
  const e = byOwner.get(owner)
  return e ? entries.indexOf(e) : -1
}
