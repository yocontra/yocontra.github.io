// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one gun built part by part, top to bottom, reads best as one list
// biome-ignore-all lint/style/noMagicNumbers: a gunsmith's measurements, in metres
/**
 * The rifle: a Winchester Model 1873 saddle-ring carbine, built in code (`scene/gunsmith.ts`) as
 * ONE indexed geometry in the long guns' one material.
 *
 * Its proportions are the real carbine's: 20" round barrel (0.508 m) with the full-length tube
 * magazine under it, held by a band near the muzzle; a case-hardened receiver with its dust cover
 * on top, loading gate on the right, saddle ring on the left and the brass cartridge lifter
 * showing underneath; the lever's two loops (the trigger finger's and the hand's) under it; a
 * walnut fore-end with a steel cap, a straight-wrist walnut buttstock with the carbine's curved
 * crescent butt plate; a buckhorn rear sight and a brass-bladed front sight. 1.0 m overall.
 *
 * Metres, muzzle along +X, top +Y, the bore on y = 0, x = 0 at the receiver's rear face. The
 * landmarks the hands and the sights use are carried on the object (`userData.longAnatomy`,
 * read by `scene/longgun.ts`): the muzzle, the butt, the stock's wrist, the fore-end, the sights
 * and the lever.
 *
 * Two levels of detail: `hi` (first person, the pickups, the duel's rifleman) and `lo` (riders in
 * third person past a few metres: fewer sides, no screws or sights).
 */
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  LOD,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  TorusGeometry,
  Vector3,
} from 'three'
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
} from './gunsmith.ts'
import type { LongAnatomy } from './longgun.ts'

type Detail = 'hi' | 'lo'

/** The barrel: 20" from the receiver's front, tapering from the breech to the muzzle. */
const BREECH_X = 0.165
const MUZZLE_X = BREECH_X + 0.508
const BARREL_R0 = 0.0095
const BARREL_R1 = 0.0078
/** The magazine tube under it. */
const MAG_Y = -0.0185
const MAG_R = 0.0072
const MAG_END = 0.648
/** The sights' line, level with the bore: the buckhorn's notch and the blade's top. */
const SIGHT_Y = 0.026
const REAR_X = 0.24
const FRONT_X = 0.656

/** The rifle's landmarks in its own frame (the hands, the sights, the lever). */
export const RIFLE_ANATOMY: LongAnatomy = {
  muzzle: new Vector3(MUZZLE_X, 0, 0),
  // the hollow of the crescent, where it sits on the shoulder
  butt: new Vector3(-0.295, -0.093, 0),
  // where the strong hand closes: a lever gun is gripped like a pistol, the thumb over the
  // stock's wrist, the trigger finger in the lever's front loop and the rest through its back
  // one, so the fist's middle is below the wrist, at the lever
  wrist: new Vector3(-0.042, -0.064, 0),
  // the support hand under the middle of the fore-end
  fore: new Vector3(0.29, -0.046, 0),
  rear: new Vector3(REAR_X, SIGHT_Y, 0),
  front: new Vector3(FRONT_X, SIGHT_Y, 0),
  lever: new Vector3(-0.066, -0.078, 0),
  leverPivot: new Vector3(0.13, -0.0455, 0),
}

const M = (): Matrix4 => new Matrix4()
const tint = (f: Finish, k: number): Finish => ({
  ...f,
  rgb: [f.rgb[0] * k, f.rgb[1] * k, f.rgb[2] * k],
})

/** The carbine's parts: everything that stays put, and the lever (it swings on its pivot). */
function build(d: Detail): { body: BufferGeometry[]; lever: BufferGeometry } {
  const hi = d === 'hi'
  const round = hi ? 18 : 8
  const p: BufferGeometry[] = []
  // ---- the barrel and the magazine
  p.push(
    part(
      new CylinderGeometry(BARREL_R1, BARREL_R0, MUZZLE_X - BREECH_X, round, 1, !hi),
      alongX((BREECH_X + MUZZLE_X) / 2, 0, 0),
      BLUED,
    ),
    // the shank where the barrel screws into the receiver
    part(new CylinderGeometry(0.0118, 0.0124, 0.014, round, 1), alongX(0.172, 0, 0), CASE),
    part(
      new CylinderGeometry(MAG_R, MAG_R, MAG_END - BREECH_X, hi ? 12 : 6, 1, true),
      alongX((BREECH_X + MAG_END) / 2, MAG_Y, 0),
      BLUED,
    ),
    // the magazine's end cap and its plug
    part(
      new CylinderGeometry(MAG_R * 1.12, MAG_R * 1.12, 0.014, hi ? 12 : 6, 1),
      alongX(MAG_END + 0.007, MAG_Y, 0),
      BLUED,
    ),
    // the band round barrel and magazine near the muzzle
    loft(
      [
        [0.612, -0.0088, 0.0355, 0.0215],
        [0.624, -0.0088, 0.0355, 0.0215],
      ],
      tint(BLUED, 1.15),
      { sides: hi ? 14 : 8, square: 0.75 },
    ),
  )
  if (hi) {
    p.push(
      // the bore, a dark disc just proud of the crown
      part(
        new CylinderGeometry(0.0042, 0.0042, 0.001, 10, 1),
        alongX(MUZZLE_X + 0.0003, 0, 0),
        BORE,
      ),
    )
  }
  // ---- the receiver: case-hardened, flat sided, rounding into the barrel at the front
  p.push(
    loft(
      [
        [0, -0.012, 0.05, 0.03],
        [0.006, -0.011, 0.062, 0.032],
        [0.138, -0.011, 0.062, 0.032],
        [0.156, -0.008, 0.054, 0.031],
        [0.166, -0.006, 0.044, 0.029],
      ],
      CASE,
      { sides: hi ? 20 : 10, square: 0.22 },
    ),
    // the dust cover riding on top
    part(new BoxGeometry(0.094, 0.0034, 0.0135), at(0.078, 0.0212, 0), tint(CASE, 0.8), 'y'),
    // the brass cartridge lifter showing underneath
    part(new BoxGeometry(0.052, 0.0045, 0.02), at(0.104, -0.0432, 0), BRASS, 'y'),
    // the tangs, top and bottom, running back over and under the wrist
    part(
      new BoxGeometry(0.058, 0.0035, 0.0125),
      M().makeRotationZ(0.29).setPosition(-0.0275, 0.0045, 0),
      CASE,
      'y',
    ),
    part(
      new BoxGeometry(0.1, 0.0035, 0.0135),
      M().makeRotationZ(0.15).setPosition(-0.045, -0.0445, 0),
      CASE,
      'y',
    ),
  )
  if (hi) {
    p.push(
      // the dust cover's grip ridge and the loading gate (right side)
      part(new BoxGeometry(0.006, 0.0022, 0.0095), at(0.03, 0.0238, 0), tint(CASE, 0.7), 'y'),
      part(new BoxGeometry(0.044, 0.017, 0.0018), at(0.112, -0.024, 0.0162), tint(CASE, 0.82), 'y'),
    )
    // the side-plate screws, both sides
    for (const z of [-0.0164, 0.0164]) {
      for (const [x, y] of [
        [0.024, 0.004],
        [0.098, 0.004],
        [0.06, -0.026],
      ] as const) {
        p.push(
          part(
            new CylinderGeometry(0.0026, 0.0026, 0.0012, 8, 1),
            M()
              .makeRotationX(Math.PI / 2)
              .setPosition(x, y, z),
            tint(BLUED, 1.3),
          ),
        )
      }
    }
    // the saddle ring on the left (−Z): its stud and the ring hanging from it
    p.push(
      part(
        new CylinderGeometry(0.0032, 0.0032, 0.004, 8, 1),
        M()
          .makeRotationX(Math.PI / 2)
          .setPosition(0.03, -0.012, -0.0178),
        BLUED,
      ),
      part(new TorusGeometry(0.0115, 0.0017, 6, 22), at(0.03, -0.0225, -0.0196), BLUED),
    )
  }
  // ---- the hammer (at rest, half cocked) and the trigger
  p.push(
    // the hammer: its neck curving up and back out of the receiver, the spur on top
    sweep(
      [
        [0.014, 0.006, 0],
        [0.008, 0.0135, 0],
        [0.0, 0.0185, 0],
        [-0.009, 0.0205, 0],
      ],
      0.0042,
      CASE,
      { segments: hi ? 10 : 4, radial: hi ? 8 : 4, flat: 0.85 },
    ),
    part(
      // its top just under the sight line, so on the sights it sits below the notch
      new BoxGeometry(0.012, 0.0035, 0.0105),
      M().makeRotationZ(-0.2).setPosition(-0.012, 0.0215, 0),
      CASE,
      'y',
    ),
    part(
      new BoxGeometry(0.0038, 0.022, 0.0034),
      M().makeRotationZ(0.28).setPosition(0.017, -0.053, 0),
      BLUED,
      'y',
    ),
  )
  // ---- the lever: from its pivot under the receiver's front, round the trigger, then the
  // hand's loop under the wrist, its tip latched up against the stock
  const lever = sweep(
    [
      [0.13, -0.0455, 0],
      [0.09, -0.0462, 0],
      [0.05, -0.0468, 0],
      [0.036, -0.053, 0],
      [0.033, -0.067, 0],
      [0.021, -0.0775, 0],
      [0.004, -0.0775, 0],
      [-0.008, -0.068, 0],
      [-0.013, -0.0505, 0],
      [-0.022, -0.06, 0],
      [-0.033, -0.085, 0],
      [-0.054, -0.0995, 0],
      [-0.079, -0.0995, 0],
      [-0.099, -0.09, 0],
      [-0.106, -0.074, 0],
      [-0.099, -0.061, 0],
      [-0.083, -0.0545, 0],
    ],
    0.0034,
    CASE,
    { segments: hi ? 64 : 24, radial: hi ? 8 : 4, flat: 1.45 },
  )
  // ---- the walnut: the fore-end with its steel cap, the buttstock and its crescent plate
  p.push(
    loft(
      [
        [0.168, -0.0145, 0.04, 0.033],
        [0.186, -0.0152, 0.042, 0.0345],
        [0.36, -0.0146, 0.039, 0.0325],
        [0.392, -0.0136, 0.035, 0.0305],
      ],
      WALNUT,
      { sides: hi ? 16 : 8, square: 0.62 },
    ),
    loft(
      [
        [0.392, -0.0136, 0.0362, 0.0315],
        [0.404, -0.0132, 0.0345, 0.03],
      ],
      BLUED,
      { sides: hi ? 16 : 8, square: 0.62 },
    ),
    loft(
      [
        [-0.001, -0.012, 0.046, 0.0292],
        [-0.03, -0.019, 0.04, 0.0282],
        [-0.07, -0.028, 0.0362, 0.0272],
        [-0.112, -0.038, 0.0505, 0.0302],
        [-0.162, -0.055, 0.0765, 0.0342],
        [-0.222, -0.072, 0.0985, 0.0382],
        [-0.272, -0.086, 0.1125, 0.0402],
        [-0.306, -0.093, 0.1195, 0.0412, 0.011],
      ],
      WALNUT,
      { sides: hi ? 18 : 8, square: 0.66 },
    ),
    loft(
      [
        [-0.306, -0.093, 0.121, 0.0418, 0.011],
        [-0.3135, -0.093, 0.1235, 0.0422, 0.0125],
      ],
      BLUED,
      { sides: hi ? 18 : 8, square: 0.6 },
    ),
  )
  // ---- the sights
  if (hi) {
    // the buckhorn: a base on the barrel, two ears either side of the notch
    const top = BARREL_R0 * 0.96
    p.push(
      part(new BoxGeometry(0.03, 0.004, 0.011), at(REAR_X, top + 0.0012, 0), BLUED, 'y'),
      part(
        new BoxGeometry(0.0028, SIGHT_Y - top - 0.003, 0.0135),
        at(REAR_X, (SIGHT_Y + top + 0.003) / 2, 0),
        BLUED,
        'y',
      ),
      part(
        new BoxGeometry(0.0028, 0.0105, 0.0042),
        M()
          .makeRotationX(0.25)
          .setPosition(REAR_X, SIGHT_Y + 0.0035, 0.0052),
        BLUED,
        'y',
      ),
      part(
        new BoxGeometry(0.0028, 0.0105, 0.0042),
        M()
          .makeRotationX(-0.25)
          .setPosition(REAR_X, SIGHT_Y + 0.0035, -0.0052),
        BLUED,
        'y',
      ),
      // the front: a dovetailed base and the brass blade, its top on the sight line
      part(new BoxGeometry(0.014, 0.0035, 0.0062), at(FRONT_X, BARREL_R1 + 0.0012, 0), BLUED, 'y'),
      part(
        new BoxGeometry(0.0085, SIGHT_Y - BARREL_R1 - 0.0025, 0.0022),
        at(FRONT_X, (SIGHT_Y + BARREL_R1 + 0.0025) / 2, 0),
        BRASS,
        'y',
      ),
    )
  } else {
    p.push(part(new BoxGeometry(0.01, 0.009, 0.003), at(FRONT_X, BARREL_R1 + 0.004, 0), BRASS, 'y'))
  }
  return { body: p, lever }
}

const cache = new Map<string, BufferGeometry>()
const cached = (key: string, make: () => BufferGeometry): BufferGeometry => {
  let g = cache.get(key)
  if (!g) {
    g = make()
    cache.set(key, g)
  }
  return g
}

/** The carbine's geometry at a level of detail, lever and all (shared: never mutate it). */
export function rifleGeometry(d: Detail = 'hi'): BufferGeometry {
  return cached(d, () => {
    const { body, lever } = build(d)
    return forge([...body, lever])
  })
}

/**
 * The carbine split for a lever throw (shared: never mutate them): the body, and the lever with
 * its origin on its pivot (`RIFLE_ANATOMY.leverPivot`), so turning it about Z swings it down.
 */
export function rifleParts(): { body: BufferGeometry; lever: BufferGeometry } {
  const p = RIFLE_ANATOMY.leverPivot ?? new Vector3()
  return {
    body: cached('body', () => forge(build('hi').body)),
    lever: cached('lever', () => forge([build('hi').lever]).translate(-p.x, -p.y, -p.z)),
  }
}

/** Past this distance (m) a rider's rifle draws its low level of detail. */
const LOD_FAR = 9

/**
 * The carbine as one drawable: one mesh (pickups, riders), or with `lod` a three.js LOD that swaps
 * to the low level past a few metres (still one draw). With `lever` it is the body and a child
 * mesh named `lever` on its pivot, for the first-person reload (that gun alone costs a second
 * draw). Its landmarks ride on it.
 */
export function rifleObject(
  o: { lod?: boolean; material?: Material; lever?: boolean } = {},
): Object3D {
  const mat = o.material ?? gunMaterial()
  if (o.lever) {
    return articulated(mat)
  }
  const mesh = (d: Detail): Mesh => {
    const m = new Mesh(rifleGeometry(d), mat)
    m.name = d === 'hi' ? 'rifle' : 'rifle-lod'
    m.castShadow = true
    m.receiveShadow = true
    return m
  }
  let obj: Object3D
  if (o.lod) {
    const lod = new LOD()
    lod.addLevel(mesh('hi'), 0)
    const far = mesh('lo')
    // the far level isn't measured (it lies inside the near one)
    far.userData.lod = true
    lod.addLevel(far, LOD_FAR)
    obj = lod
  } else {
    obj = mesh('hi')
  }
  obj.name = 'rifle'
  obj.userData.longAnatomy = RIFLE_ANATOMY
  return obj
}

/** The body with the lever as a child mesh on its pivot (rotate `lever` about Z to throw it). */
function articulated(mat: Material): Object3D {
  const parts = rifleParts()
  const body = new Mesh(parts.body, mat)
  const lever = new Mesh(parts.lever, mat)
  lever.name = 'lever'
  lever.position.copy(RIFLE_ANATOMY.leverPivot ?? new Vector3())
  for (const m of [body, lever]) {
    m.castShadow = true
    m.receiveShadow = true
  }
  body.add(lever)
  body.name = 'rifle'
  body.userData.longAnatomy = RIFLE_ANATOMY
  return body
}
