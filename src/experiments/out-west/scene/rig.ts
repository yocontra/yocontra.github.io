// biome-ignore-all lint/suspicious/noUnnecessaryConditions: three's isMesh flag is typed `true` on the cast type; testing it is the runtime type check
/**
 * The pure parts of building an actor, kept apart from the `Actor` class that owns its state:
 * his colours, the garments he wears, where a slot sits on a bone, how long his stride is, and
 * where his hat seats on his skull.
 */
import {
  type AnimationClip,
  type AnimationMixer,
  type Bone,
  Group,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import type { HatKey } from '../data/outlaws.ts'
import type { Piece } from './bake.ts'
import { onBones } from './fit.ts'
import { CROWN_R, makeHat } from './hats.ts'
import {
  bandana,
  bandoliers,
  beard,
  coat,
  type Fit,
  mask,
  moustache,
  poncho,
  star,
} from './outfit.ts'
import { type Floor, vary } from './style.ts'

/** What the dressing and tinting read from an actor's options. */
export interface DressOpts {
  tint?: Readonly<Record<string, number>>
  bandana?: number | undefined
  coat?: number | undefined
  poncho?: number | undefined
  moustache?: number | undefined
  beard?: number | undefined
  bandoliers?: boolean | undefined
  star?: boolean | undefined
  mask?: number | undefined
  seed?: string
}

const tmpV = new Vector3()
const tmpQ = new Quaternion()

/**
 * The tint of one of the base's materials: the outlaw's own, else the base's default (the
 * build gives the ranger's green a western colour, hair a brown); brows follow his hair and a
 * sculpted beard takes the beard colour.
 */
function tintFor(
  src: Material,
  tint: Readonly<Record<string, number>>,
  o: DressOpts,
): number | undefined {
  const own = tint[src.name]
  if (own !== undefined) {
    return own
  }
  if (src.name === 'Beard' && o.beard !== undefined) {
    return o.beard
  }
  if ((src.name === 'Brows' || src.name === 'Beard') && tint.Hair !== undefined) {
    return tint.Hair
  }
  return src.userData.tint as number | undefined
}

/** His own colours: each material tinted, then a seeded nudge so no two read identical. */
export function tintModel(model: Object3D, o: DressOpts): void {
  const tint = o.tint ?? {}
  const seed = o.seed ?? 'player'
  const cache = new Map<Material, Material>()
  const swap = (src: Material): Material => {
    const cached = cache.get(src)
    if (cached) {
      return cached
    }
    const c = src.clone() as MeshStandardMaterial
    const hex = tintFor(src, tint, o)
    c.color.setHex(hex ?? 0xff_ff_ff)
    // a tinted garment is recoloured (its main fabric), untinted keeps its texture
    c.userData.recolor = hex !== undefined && ((src.userData.lum as number | undefined) ?? 0) > 0
    vary(c, seed)
    if (hex === undefined) {
      // untinted: the texture as authored (vary still sets roughness and rim)
      c.color.setHex(0xff_ff_ff)
    }
    cache.set(src, c)
    return c
  }
  model.traverse((obj) => {
    const m = obj as Mesh
    if (m.isMesh) {
      m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
    }
  })
}

/** Everything he wears, fitted and skinned (see outfit.ts). */
export function dressPieces(f: Fit, o: DressOpts, root: Object3D, realBeard: boolean): Piece[] {
  const out: Piece[] = []
  if (o.coat !== undefined) {
    out.push(...coat(f, o.coat))
  }
  if (o.poncho !== undefined) {
    out.push(...poncho(f, o.poncho))
  }
  if (o.mask !== undefined) {
    out.push(...mask(f, o.mask))
  } else if (o.bandana !== undefined) {
    out.push(...bandana(f, o.bandana))
  }
  if (o.bandoliers) {
    out.push(...bandoliers(f, root))
  }
  if (o.star) {
    out.push(...star(f, root))
  }
  if (o.beard !== undefined && !realBeard) {
    out.push(...beard(f, o.beard))
  }
  if (o.moustache !== undefined) {
    out.push(...moustache(f, o.moustache, root))
  }
  return out
}

/** A bone-local slot that holds world-space-authored children (unit scale, root orientation). */
export function slotOn(bone: Bone, worldPos: Vector3, worldQuat: Quaternion): Group {
  const slot = new Group()
  bone.add(slot)
  bone.updateMatrixWorld(true)
  const inv = bone.matrixWorld.clone().invert()
  slot.position.copy(worldPos.clone().applyMatrix4(inv))
  bone.getWorldQuaternion(tmpQ)
  slot.quaternion.copy(tmpQ.clone().invert().multiply(worldQuat))
  const ws = bone.getWorldScale(new Vector3())
  slot.scale.setScalar(1 / ws.x)
  return slot
}

export interface Stride {
  /** Distance per pace at full stride, or null when the clip doesn't give a sane one. */
  paceLength: number | null
  /** Walk clip time of each heel strike. */
  heelStrikes: number[]
}

/** Sample the walk clip to find stride length and heel-strike times (no foot sliding). */
export function measureStride(
  rig: { mixer: AnimationMixer; root: Object3D; feet: readonly [Bone, Bone] },
  clip: AnimationClip,
): Stride {
  const { mixer, root } = rig
  const [footL, footR] = rig.feet
  const action = mixer.clipAction(clip)
  action.reset().play()
  action.weight = 1
  const n = 48
  const zl: number[] = []
  const zr: number[] = []
  const inv = root.matrixWorld.clone().invert()
  for (let i = 0; i < n; i++) {
    mixer.setTime((i / n) * clip.duration)
    root.updateMatrixWorld(true)
    inv.copy(root.matrixWorld).invert()
    zl.push(footL.getWorldPosition(tmpV).applyMatrix4(inv).z)
    zr.push(footR.getWorldPosition(tmpV).applyMatrix4(inv).z)
  }
  action.stop()
  const range = (a: number[]) => Math.max(...a) - Math.min(...a)
  const stride = (range(zl) + range(zr)) / 2
  const argmax = (a: number[]) => a.indexOf(Math.max(...a))
  return {
    paceLength: stride > 0.2 && stride < 1.5 ? stride : null,
    heelStrikes: [(argmax(zl) / n) * clip.duration, (argmax(zr) / n) * clip.duration].sort(
      (a, b) => a - b,
    ),
  }
}

/**
 * Seat a hat on his head bone: sized to his skull (hair included) and lowered until the crown's
 * inner rim meets it, like a real hat.
 */
export function seatHat(
  f: Fit,
  hat: { key: HatKey; color: number; floor: Floor },
  on: { head: Bone; root: Object3D },
): Group {
  const { key } = hat
  const g = makeHat(key, hat.color, hat.floor)
  const h = f.head
  const crownR = CROWN_R[key] ?? 0.1
  const s = Math.min(1.3, Math.max(0.9, (h.r * 1.04) / crownR))
  const want = crownR * s
  const skull = onBones(f.body, ['Head'])
  // Highest height at which the head is as wide as the crown's opening.
  let seat = h.top - 0.06
  for (let y = h.top; y > h.top - 0.2; y -= 0.004) {
    let r = 0
    for (const p of skull) {
      if (Math.abs(p.p.y - y) < 0.006) {
        r = Math.max(r, Math.hypot(p.p.x - h.cx, p.p.z - h.cz))
      }
    }
    if (r >= want * 0.96) {
      seat = y
      break
    }
  }
  const inner = g.children[0]
  inner?.scale.setScalar(s)
  const slot = slotOn(
    on.head,
    new Vector3(h.cx, seat - 0.025 * s, h.cz),
    on.root.getWorldQuaternion(new Quaternion()),
  )
  slot.add(g)
  g.rotation.x = -0.08
  return g
}
