// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numbers, like three.js
/**
 * A side-by-side double-barrel coach gun (the 1870s–80s Wells Fargo kind), built in code as ONE
 * indexed BufferGeometry drawn with the props' shared "Kit" material: UVs land on the trim
 * atlas's steel and walnut bands (`scene/kit-atlas.ts`) and vertex colours tint the blued
 * barrels, the case-hardened lock and the walnut, so it costs no texture and no new program.
 *
 * Metres, muzzle along +X, origin at the wrist where the hand grips it, barrels side by side
 * along Z (so the top-down camera sees two fat tubes and the two hammers).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  TorusGeometry,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { KIT_BAND, KIT_H, KIT_INSET, type KitBand } from '../../scene/kit-atlas.ts'

type Rgb = readonly [number, number, number]

interface Finish {
  band: KitBand
  v0: number
  v1: number
  rgb: Rgb
}

// The steel strip of the metal sheet and the plank grain of the furniture sheet (the windows the
// revolver uses, tools/build-props.ts `textureRevolver`).
const BLUED: Finish = { band: 'metal', v0: 0.03, v1: 0.11, rgb: [0.56, 0.6, 0.7] }
const CASE: Finish = { band: 'metal', v0: 0.03, v1: 0.11, rgb: [0.95, 0.84, 0.7] }
const DARK: Finish = { band: 'metal', v0: 0.03, v1: 0.05, rgb: [0.05, 0.05, 0.05] }
const WALNUT: Finish = { band: 'furniture', v0: 0.14, v1: 0.3, rgb: [0.72, 0.46, 0.32] }

/** Where the shot leaves (between the two muzzles), in the gun's own metres. */
export const SHOTGUN_MUZZLE = new Vector3(0.585, 0.032, 0)

const BARREL_Y = 0.032
const BARREL_R = 0.0185
const BREECH_X = 0.072
const MUZZLE_X = 0.58

function bandV(b: KitBand, v: number): number {
  const r = KIT_BAND[b]
  const c = Math.min(1, Math.max(0, v))
  return (r.y + KIT_INSET + c * (r.h - 2 * KIT_INSET)) / KIT_H
}

/** A primitive placed, its UVs moved onto the finish's band (U runs along the gun), tinted. */
function part(g: BufferGeometry, at: Matrix4, f: Finish, around: 'u' | 'v'): BufferGeometry {
  g.applyMatrix4(at)
  const P = g.getAttribute('position')
  const T = g.getAttribute('uv')
  const uv = new Float32Array(P.count * 2)
  const col = new Float32Array(P.count * 3)
  for (let k = 0; k < P.count; k++) {
    const t = around === 'u' ? T.getX(k) : T.getY(k)
    uv[k * 2] = P.getX(k) * 2.5
    uv[k * 2 + 1] = bandV(f.band, f.v0 + (f.v1 - f.v0) * t)
    col.set(f.rgb, k * 3)
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2))
  g.setAttribute('color', new BufferAttribute(col, 3))
  return g
}

/** A tube along +X through rounded-octagon sections `[x, centreY, height, width]`, capped. */
function loft(
  sections: readonly (readonly [number, number, number, number])[],
  f: Finish,
): BufferGeometry {
  const sides = 10
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const ring = sides + 1
  for (const [x, cy, h, w] of sections) {
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2
      // a squarish oval: wood stocks are flat-sided with rounded edges
      const c = Math.cos(a)
      const s = Math.sin(a)
      const sq = (v: number) => Math.sign(v) * Math.abs(v) ** 0.7
      pos.push(x, cy + (h / 2) * sq(s), (w / 2) * sq(c))
      uv.push(x * 2.5, bandV(f.band, f.v0 + (f.v1 - f.v0) * (k / sides)))
    }
  }
  for (let i = 0; i < sections.length - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * ring + k
      const b = a + ring
      idx.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }
  const body = new BufferGeometry()
  body.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  body.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  body.setIndex(idx)
  body.computeVertexNormals()
  const geos = [body]
  // flat end caps (their own vertices, so the sides stay smooth and the ends stay flat)
  for (const end of [0, sections.length - 1]) {
    const sec = sections[end]
    if (!sec) {
      continue
    }
    const cap = new BufferGeometry()
    const cp: number[] = []
    const cu: number[] = []
    const ci: number[] = []
    const nx = end === 0 ? -1 : 1
    cp.push(sec[0], sec[1], 0)
    cu.push(sec[0] * 2.5, bandV(f.band, (f.v0 + f.v1) / 2))
    for (let k = 0; k < sides; k++) {
      const o = (end * ring + k) * 3
      cp.push(pos[o] ?? 0, pos[o + 1] ?? 0, pos[o + 2] ?? 0)
      cu.push((pos[o + 1] ?? 0) * 2.5, bandV(f.band, f.v0 + (f.v1 - f.v0) * (k / sides)))
    }
    for (let k = 0; k < sides; k++) {
      const a = 1 + k
      const b = 1 + ((k + 1) % sides)
      ci.push(...(nx < 0 ? [0, a, b] : [0, b, a]))
    }
    cap.setAttribute('position', new BufferAttribute(new Float32Array(cp), 3))
    cap.setAttribute('uv', new BufferAttribute(new Float32Array(cu), 2))
    cap.setIndex(ci)
    cap.computeVertexNormals()
    geos.push(cap)
  }
  const merged = mergeGeometries(geos, false) ?? body
  const n = merged.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) {
    col.set(f.rgb, k * 3)
  }
  merged.setAttribute('color', new BufferAttribute(col, 3))
  return merged
}

const M = () => new Matrix4()
/** A cylinder (three's along Y) laid along +X, centred at (x, y, z). */
const alongX = (x: number, y: number, z: number) =>
  M()
    .makeRotationZ(-Math.PI / 2)
    .setPosition(x, y, z)

function build(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const barrelLen = MUZZLE_X - BREECH_X
  for (const z of [-BARREL_R, BARREL_R]) {
    parts.push(
      part(
        new CylinderGeometry(BARREL_R, BARREL_R * 1.04, barrelLen, 14, 1),
        alongX(BREECH_X + barrelLen / 2, BARREL_Y, z),
        BLUED,
        'u',
      ),
      // the bores: a dark disc proud of each muzzle
      part(
        new CylinderGeometry(BARREL_R * 0.66, BARREL_R * 0.66, 0.004, 10, 1),
        alongX(MUZZLE_X + 0.0005, BARREL_Y, z),
        DARK,
        'u',
      ),
    )
  }
  // the ribs in the valleys between the barrels, top and bottom
  parts.push(
    part(
      new BoxGeometry(barrelLen, 0.008, 0.012),
      M().makeTranslation(BREECH_X + barrelLen / 2, BARREL_Y + BARREL_R * 0.86, 0),
      BLUED,
      'v',
    ),
    part(
      new BoxGeometry(barrelLen * 0.9, 0.008, 0.012),
      M().makeTranslation(BREECH_X + barrelLen * 0.45, BARREL_Y - BARREL_R * 0.86, 0),
      BLUED,
      'v',
    ),
    // front bead
    part(
      new BoxGeometry(0.006, 0.006, 0.006),
      M().makeTranslation(MUZZLE_X - 0.008, BARREL_Y + BARREL_R + 0.006, 0),
      CASE,
      'v',
    ),
  )
  // the receiver (case-hardened): the action body, with the breech fences rising round the barrels
  parts.push(
    part(new BoxGeometry(0.095, 0.058, 0.046), M().makeTranslation(0.025, 0.018, 0), CASE, 'v'),
    part(
      new CylinderGeometry(0.03, 0.03, 0.018, 12, 1),
      alongX(BREECH_X - 0.006, BARREL_Y + 0.004, 0).multiply(M().makeScale(1, 1, 1.35)),
      CASE,
      'u',
    ),
    // top lever, swung back over the wrist
    part(
      new BoxGeometry(0.04, 0.006, 0.01),
      M().makeRotationY(0.25).setPosition(-0.012, 0.049, 0.004),
      BLUED,
      'v',
    ),
  )
  // two exposed hammers: a body leaning back from the lock, a broad spur on top
  // (a little oversized, splayed out over the lock plates, so they read from above)
  for (const z of [-0.02, 0.02]) {
    parts.push(
      part(
        new BoxGeometry(0.016, 0.036, 0.011),
        M().makeRotationZ(0.45).setPosition(-0.004, 0.05, z),
        CASE,
        'v',
      ),
      part(
        new BoxGeometry(0.03, 0.009, 0.018),
        M().makeRotationZ(-0.25).setPosition(-0.022, 0.071, z),
        CASE,
        'v',
      ),
    )
  }
  // trigger guard (a half ring under the action) and the two triggers
  parts.push(
    part(
      new TorusGeometry(0.024, 0.0035, 4, 10, Math.PI),
      M()
        .makeRotationX(Math.PI)
        .setPosition(0.012, -0.011, 0)
        .multiply(M().makeScale(1.25, 1, 1)),
      BLUED,
      'u',
    ),
    part(
      new BoxGeometry(0.004, 0.02, 0.004),
      M().makeRotationZ(0.3).setPosition(0.02, -0.02, 0),
      CASE,
      'v',
    ),
    part(
      new BoxGeometry(0.004, 0.02, 0.004),
      M().makeRotationZ(0.3).setPosition(0.005, -0.02, 0),
      CASE,
      'v',
    ),
  )
  // the walnut: a straight English stock with a slim wrist, and the short splinter forend
  parts.push(
    loft(
      [
        [-0.022, 0.018, 0.056, 0.042],
        [-0.06, 0.004, 0.034, 0.03],
        [-0.12, -0.01, 0.042, 0.033],
        [-0.2, -0.026, 0.074, 0.039],
        [-0.3, -0.042, 0.1, 0.043],
        [-0.38, -0.052, 0.118, 0.045],
      ],
      WALNUT,
    ),
    loft(
      [
        [BREECH_X + 0.004, BARREL_Y - 0.02, 0.022, 0.044],
        [BREECH_X + 0.03, BARREL_Y - 0.022, 0.03, 0.05],
        [BREECH_X + 0.18, BARREL_Y - 0.02, 0.026, 0.046],
        [BREECH_X + 0.205, BARREL_Y - 0.014, 0.016, 0.034],
      ],
      WALNUT,
    ),
    // butt plate
    part(new BoxGeometry(0.008, 0.12, 0.046), M().makeTranslation(-0.384, -0.052, 0), BLUED, 'v'),
  )
  const geo = mergeGeometries(parts, false)
  if (!geo) {
    throw new Error('shotgun: merge failed')
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

let cached: BufferGeometry | null = null

/** The coach gun's geometry (shared: never mutate it). */
export function shotgunGeometry(): BufferGeometry {
  cached ??= build()
  return cached
}

/** The props' shared atlas material ("Kit", engine/assets.ts), or a plain vertex-coloured one. */
export function kitMaterial(props: GLTF | null): Material {
  const found: Material[] = []
  const look = (o: Object3D): void => {
    if (o instanceof Mesh && !Array.isArray(o.material) && o.material.name === 'Kit') {
      found.push(o.material)
    }
  }
  for (const s of props?.scenes ?? []) {
    s.traverse(look)
  }
  return (
    found[0] ?? new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 })
  )
}

/** One mesh of the coach gun (one draw). */
export function shotgunMesh(material: Material): Object3D {
  const m = new Mesh(shotgunGeometry(), material)
  m.name = 'shotgun'
  m.castShadow = true
  return m
}
