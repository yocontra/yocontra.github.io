// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one gun built part by part, top to bottom, reads best as one list
// biome-ignore-all lint/style/noMagicNumbers: a gunsmith's measurements, in metres
/**
 * A side-by-side double-barrel coach gun (the 1870s–80s Wells Fargo kind: a 12-bore hammer gun
 * with 20" barrels), built in code (`scene/gunsmith.ts`) as ONE indexed geometry in the long guns'
 * one material.
 *
 * Twin blued barrels with a matted rib between them and a brass bead at the muzzles; a
 * case-hardened action with its round fences behind the breech and a back-action lock plate on
 * each side, an exposed hammer on each lock; the top lever on the tang; a blued trigger guard
 * with two triggers; a walnut splinter fore-end with its iron tip, and a straight English stock
 * with a steel butt plate. 0.97 m overall.
 *
 * Metres, muzzle along +X, origin at the wrist where the hand grips it, barrels side by side
 * along Z. Its landmarks (the hands, the sight line along the rib) ride on the object
 * (`userData.longAnatomy`, read by `scene/longgun.ts`).
 */
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  alongX,
  at,
  BLUED,
  BORE,
  BRASS,
  CASE,
  type Finish,
  forge,
  gunMaterial,
  loft,
  part,
  sweep,
  WALNUT,
} from '../../scene/gunsmith.ts'
import type { LongAnatomy } from '../../scene/longgun.ts'

const BARREL_Y = 0.032
/** A 12-bore's tubes: 24 mm across at the breech, 21 at the muzzle, touching. */
const BARREL_R0 = 0.0122
const BARREL_R1 = 0.0106
const BARREL_Z = 0.0121
const BREECH_X = 0.072
const MUZZLE_X = 0.58
const RIB_Y = BARREL_Y + BARREL_R0 * 0.78

/** Where the shot leaves (between the two muzzles), in the gun's own metres. */
export const SHOTGUN_MUZZLE = new Vector3(MUZZLE_X + 0.001, BARREL_Y, 0)

/** The coach gun's landmarks in its own frame. */
export const SHOTGUN_ANATOMY: LongAnatomy = {
  muzzle: SHOTGUN_MUZZLE.clone(),
  butt: new Vector3(-0.386, -0.054, 0),
  wrist: new Vector3(-0.085, 0.002, 0),
  fore: new Vector3(0.13, BARREL_Y - 0.05, 0),
}

const M = (): Matrix4 => new Matrix4()
const tint = (f: Finish, k: number): Finish => ({
  ...f,
  rgb: [f.rgb[0] * k, f.rgb[1] * k, f.rgb[2] * k],
})

function build(): BufferGeometry {
  const p: BufferGeometry[] = []
  const len = MUZZLE_X - BREECH_X
  // ---- the barrels, the bores, the ribs and the bead
  for (const z of [-BARREL_Z, BARREL_Z]) {
    p.push(
      part(
        new CylinderGeometry(BARREL_R1, BARREL_R0, len, 18, 1),
        alongX(BREECH_X + len / 2, BARREL_Y, z),
        BLUED,
      ),
      part(
        new CylinderGeometry(BARREL_R1 * 0.72, BARREL_R1 * 0.72, 0.001, 12, 1),
        alongX(MUZZLE_X + 0.0004, BARREL_Y, z),
        BORE,
      ),
    )
  }
  p.push(
    // the matted top rib, tapering toward the muzzle, and the bottom rib
    loft(
      [
        [BREECH_X, RIB_Y - 0.002, 0.007, 0.0105],
        [MUZZLE_X - 0.001, BARREL_Y + BARREL_R1 * 0.78 - 0.002, 0.007, 0.0082],
      ],
      tint(BLUED, 0.8),
      { sides: 8, square: 0.3 },
    ),
    loft(
      [
        [BREECH_X + 0.03, BARREL_Y - BARREL_R0 * 0.72, 0.008, 0.009],
        [MUZZLE_X - 0.03, BARREL_Y - BARREL_R1 * 0.72, 0.008, 0.008],
      ],
      BLUED,
      { sides: 8, square: 0.3 },
    ),
    part(new SphereGeometry(0.0026, 8, 6), at(MUZZLE_X - 0.008, RIB_Y + 0.0036, 0), BRASS, 'v'),
  )
  // ---- the action: the bar under the barrels, the standing breech and its round fences
  p.push(
    loft(
      [
        [-0.02, 0.026, 0.05, 0.044],
        [0.0, 0.022, 0.06, 0.05],
        [0.07, 0.02, 0.05, 0.05],
        [0.098, 0.022, 0.034, 0.046],
      ],
      CASE,
      { sides: 18, square: 0.4 },
    ),
  )
  for (const z of [-BARREL_Z, BARREL_Z]) {
    p.push(
      // the fences: the breech's domed shoulders behind each barrel
      part(
        new SphereGeometry(0.0145, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        M()
          .makeRotationZ(Math.PI / 2)
          .setPosition(BREECH_X - 0.002, BARREL_Y + 0.001, z * 1.05),
        CASE,
        'v',
      ),
    )
  }
  // ---- the locks: a plate on each side running back into the wrist, its hammer on it
  for (const side of [-1, 1]) {
    const z = side * 0.0236
    p.push(
      loft(
        [
          [-0.062, 0.013, 0.022, 0.003],
          [-0.045, 0.016, 0.034, 0.0035],
          [0.012, 0.018, 0.036, 0.0035],
          [0.03, 0.016, 0.026, 0.003],
        ],
        tint(CASE, 1.06),
        { sides: 10, square: 0.35 },
      ).applyMatrix4(at(0, 0, z)),
      // the hammer: its neck curving up and back off the lock's tumbler, the spur on top
      sweep(
        [
          [0.002, 0.024, z],
          [-0.004, 0.038, z],
          [-0.01, 0.049, z],
          [-0.02, 0.057, z],
        ],
        0.0056,
        CASE,
        { segments: 10, radial: 8, flat: 0.6 },
      ),
      part(
        new BoxGeometry(0.021, 0.006, 0.013),
        M().makeRotationZ(-0.18).setPosition(-0.027, 0.0595, z),
        CASE,
        'y',
      ),
      // the hammer's tumbler boss and the lock's pin heads
      part(
        new CylinderGeometry(0.0055, 0.0055, 0.002, 10, 1),
        M()
          .makeRotationX(Math.PI / 2)
          .setPosition(0.003, 0.022, z + side * 0.0018),
        tint(CASE, 0.85),
      ),
      part(
        new CylinderGeometry(0.0024, 0.0024, 0.0012, 8, 1),
        M()
          .makeRotationX(Math.PI / 2)
          .setPosition(-0.045, 0.014, z + side * 0.0018),
        tint(BLUED, 1.3),
      ),
    )
  }
  // ---- the top lever on the tang, the trigger guard and the two triggers
  p.push(
    part(
      new BoxGeometry(0.042, 0.005, 0.011),
      M().makeRotationY(0.22).setPosition(-0.016, 0.0505, 0.004),
      BLUED,
      'y',
    ),
    part(
      new BoxGeometry(0.046, 0.004, 0.012),
      M().makeRotationZ(0.44).setPosition(-0.04, 0.0425, 0),
      CASE,
      'y',
    ),
    sweep(
      [
        [0.05, -0.002, 0],
        [0.044, -0.016, 0],
        [0.026, -0.025, 0],
        [0.002, -0.024, 0],
        [-0.016, -0.014, 0],
        [-0.03, -0.006, 0],
        [-0.075, -0.012, 0],
      ],
      0.0032,
      BLUED,
      { segments: 26, radial: 6, flat: 1.6 },
    ),
    part(
      new BoxGeometry(0.0038, 0.02, 0.0034),
      M().makeRotationZ(0.32).setPosition(0.024, -0.008, 0),
      CASE,
      'y',
    ),
    part(
      new BoxGeometry(0.0038, 0.019, 0.0034),
      M().makeRotationZ(0.32).setPosition(0.008, -0.008, 0),
      CASE,
      'y',
    ),
  )
  // ---- the walnut: the straight stock and the splinter fore-end with its iron tip
  p.push(
    loft(
      [
        [-0.018, 0.023, 0.056, 0.046],
        [-0.06, 0.0105, 0.045, 0.04],
        [-0.1, -0.0015, 0.037, 0.031],
        [-0.14, -0.012, 0.048, 0.033],
        [-0.2, -0.0255, 0.073, 0.039],
        [-0.29, -0.041, 0.1, 0.043],
        [-0.378, -0.054, 0.12, 0.045],
      ],
      WALNUT,
      { sides: 18, square: 0.66 },
    ),
    loft(
      [
        [-0.378, -0.054, 0.12, 0.0455],
        [-0.386, -0.054, 0.121, 0.046],
      ],
      BLUED,
      { sides: 16, square: 0.55 },
    ),
    loft(
      [
        [BREECH_X + 0.03, BARREL_Y - 0.021, 0.022, 0.044],
        [BREECH_X + 0.05, BARREL_Y - 0.024, 0.03, 0.05],
        [BREECH_X + 0.17, BARREL_Y - 0.023, 0.028, 0.047],
        [BREECH_X + 0.2, BARREL_Y - 0.018, 0.02, 0.04],
      ],
      WALNUT,
      { sides: 14, square: 0.6 },
    ),
    loft(
      [
        [BREECH_X + 0.2, BARREL_Y - 0.018, 0.0205, 0.0405],
        [BREECH_X + 0.214, BARREL_Y - 0.016, 0.015, 0.032],
      ],
      CASE,
      { sides: 14, square: 0.6 },
    ),
  )
  return forge(p)
}

let cached: BufferGeometry | null = null

/** The coach gun's geometry (shared: never mutate it). */
export function shotgunGeometry(): BufferGeometry {
  cached ??= build()
  return cached
}

/** The props' shared atlas material ("Kit", engine/assets.ts), or a plain vertex-coloured one. */
const loose = new WeakMap<Material, Material>()

/**
 * The kit material for LOOSE meshes (guns in hands and holsters, pickups): a twin of the town's
 * kit material (same maps, same shader patch, same program) that is never used by an
 * InstancedMesh. Sharing one material between instanced and plain meshes makes three.js
 * re-resolve its program on every switch between them, twice a frame.
 */
export function kitMaterial(props: GLTF | null): Material {
  let found: Material | null = null
  const look = (o: Object3D): void => {
    if (!found && o instanceof Mesh && !Array.isArray(o.material) && o.material.name === 'Kit') {
      found = o.material
    }
  }
  for (const s of props?.scenes ?? []) {
    s.traverse(look)
  }
  const shared = found as Material | null
  if (!shared) {
    return new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 })
  }
  let twin = loose.get(shared)
  if (!twin) {
    twin = shared.clone()
    twin.onBeforeCompile = shared.onBeforeCompile
    twin.customProgramCacheKey = shared.customProgramCacheKey
    loose.set(shared, twin)
  }
  return twin
}

/** One mesh of the coach gun (one draw, the long guns' material); its landmarks ride on it. */
export function shotgunMesh(material: Material = gunMaterial()): Object3D {
  const m = new Mesh(shotgunGeometry(), material)
  m.name = 'shotgun'
  m.castShadow = true
  m.receiveShadow = true
  m.userData.longAnatomy = SHOTGUN_ANATOMY
  return m
}
