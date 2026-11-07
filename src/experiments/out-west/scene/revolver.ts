// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one gun built part by part, top to bottom, reads best as one list
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the cylinder's grid is one flat pass over rings and sides
// biome-ignore-all lint/style/noNestedTernary: three levels of detail picked inline, hi : mid : lo
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one gun, its moving parts and its placement read best together
// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numbers, like three.js
/**
 * The revolver: a Colt Single Action Army, the 1873 Peacemaker, with the 5½" "Artillery" barrel,
 * built in code (`scene/gunsmith.ts`) as ONE indexed geometry in the guns' one material.
 *
 * Its proportions are the real gun's: a round 5½" barrel with the ejector rod's housing under it
 * on the right; a fluted six-shot cylinder (1.66" across, 1.62" long) with its six chambers open at
 * the front and the rounds' lead noses in them; a case-hardened frame, its top strap ending in the
 * rear sight's notch, the recoil shield and its loading gate behind the cylinder; the hammer with
 * its checkered spur (down: on a Peacemaker the hammer at rest hides the notch, so you aim it
 * cocked); the trigger in a brass guard; the one-piece walnut "plow handle" grip between a brass
 * back strap and front strap; a half-moon front blade. 11" overall.
 *
 * Built in its native frame (metres, the bore along +X on y = 0, x = 0 at the cylinder's front
 * face), then scaled and placed like the kit prop it replaces (`revolverDef`: its length `size`,
 * resting on y = 0, centred), so every hand and holster fit keeps its frame. The landmarks the
 * hands, the holster and the sights use ride on the object (`userData.gunAnatomy`, read by
 * `scene/holster.ts`): the muzzle, the grip, the sights.
 *
 * Three levels of detail: `hi` (first person, the duel, the hub), `mid` (Frontier's riders near)
 * and `lo` (riders far off). A finish (`RevolverLook`: blued, nickel, gilt, a Buntline's 12"
 * barrel) is its own geometry in the same material, so a skin never costs a draw or a program.
 * The articulated variant (`revolverObject({ articulated: true })`) carries the cylinder and the
 * hammer as child meshes on their pivots, to turn and to cock.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  LOD,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Vector3,
} from 'three'
import { scrollEngraving } from './engraving.ts'
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
  LEAD,
  loft,
  loftPath,
  type PathSection,
  part,
  sweep,
  WALNUT,
} from './gunsmith.ts'
import type { GunAnatomy } from './holster.ts'
import { creaseNormals } from './normals.ts'
import type { Part, PropDef } from './props.ts'

export type RevolverDetail = 'hi' | 'mid' | 'lo'

/** A finish: the barrel and cylinder's steel, the frame and hammer, the guard and straps, the grip. */
export interface RevolverLook {
  engraved?: boolean
  /** Barrel length, inches (5½ the Artillery, 7½ the Cavalry, 12 the Buntline). */
  barrel: number
  steel: Finish
  frame: Finish
  guard: Finish
  grip: Finish
}

/** The Peacemaker as Colt shipped it: blued, a case-coloured frame, brass, walnut. */
export const PEACEMAKER: RevolverLook = {
  barrel: 5.5,
  steel: BLUED,
  frame: CASE,
  guard: BRASS,
  grip: WALNUT,
}

const IN = 0.0254
/** The cylinder: its axis under the bore (the top chamber on it), its length and radius. */
const CYL_Y = -0.0134
const CYL_R = 0.0211
const CYL_X0 = -0.0412
const CYL_X1 = -0.0006
/** The six chambers: on a circle round the axis, through the bore at the top. */
const BOLT_R = -CYL_Y
const CH_R = 0.0058
/** The barrel: from the cylinder's face, tapering to the muzzle. */
const BARREL_R0 = 0.0089
const BARREL_R1 = 0.0079
/** The frame's front, where the barrel screws in. */
const HEAD_X = 0.0195
/** The sight line: the notch's floor at the back of the top strap, the blade's top. */
const SIGHT_Y = 0.0138
const NOTCH_X0 = -0.0438
const NOTCH_X1 = -0.0528
const NOTCH_W = 0.0028
/** The hammer's pivot (its screw), and how far it turns back to full cock (rad). */
export const HAMMER_PIVOT = new Vector3(-0.0615, -0.0255, 0)
export const HAMMER_COCK = 0.58
/** The cylinder's axis (any point on it), for the articulated cylinder's pivot. */
export const CYLINDER_PIVOT = new Vector3(0, CYL_Y, 0)

const M = (): Matrix4 => new Matrix4()
const tint = (f: Finish, k: number): Finish => ({
  ...f,
  rgb: [f.rgb[0] * k, f.rgb[1] * k, f.rgb[2] * k],
})

/** The muzzle's x for a barrel length (inches). */
const muzzleX = (inches: number): number => inches * IN

/** A disc facing ±Z (a screw head) at (x, y, z). */
function screw(x: number, y: number, z: number, f: Finish, r = 0.0021): BufferGeometry {
  return part(
    new CylinderGeometry(r, r, 0.0009, 10, 1),
    M()
      .makeRotationX(Math.PI / 2)
      .setPosition(x, y, z),
    tint(f, 1.25),
  )
}

/**
 * The fluted cylinder in its native place (axis along X at y = CYL_Y): the side a grid whose
 * radius dips into six round-bottomed flutes between the chambers, bevelled at both ends; the front
 * face with six open chambers and a lead nose seated in each; the rear face against the shield.
 */
function cylinder(d: RevolverDetail, look: RevolverLook): BufferGeometry {
  const steel = look.steel
  const around = d === 'hi' ? 96 : d === 'mid' ? 24 : 12
  const xa = CYL_X0 + 0.0152
  const xb = CYL_X1 - 0.0035
  const end = 0.003
  const xs =
    d === 'hi'
      ? [
          CYL_X0,
          CYL_X0 + 0.0012,
          xa,
          xa + end * 0.35,
          xa + end * 0.7,
          xa + end,
          (xa + xb) / 2,
          xb - end * 0.7,
          xb - end * 0.35,
          xb,
          CYL_X1 - 0.0012,
          CYL_X1,
        ]
      : d === 'mid'
        ? [CYL_X0, xa, xa + end, xb - end, xb, CYL_X1]
        : [CYL_X0, xa, xb, CYL_X1]
  const hw = 0.33
  const depth = 0.0034
  const flute = (theta: number): number => {
    // the flutes sit between the chambers: at 30°, 90°, … from the top
    const s = Math.PI / 3
    const u = (((theta - s / 2) % s) + s) % s
    const dt = Math.min(u, s - u)
    return dt >= hw ? 0 : Math.sqrt(1 - (dt / hw) ** 2)
  }
  const along = (x: number): number => {
    if (x < xa || x > xb) {
      return 0
    }
    const a = Math.min(1, (x - xa) / end)
    const b = Math.min(1, (xb - x) / end)
    // round-ended, as the cutter leaves them
    return Math.sqrt(Math.max(0, 1 - (1 - a) ** 2)) * Math.sqrt(Math.max(0, 1 - (1 - b) ** 2))
  }
  const bevel = (x: number): number =>
    x === CYL_X0 || x === CYL_X1 ? (d === 'lo' ? 0 : 0.0011) : 0
  const ring = around + 1
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (const x of xs) {
    const g = along(x)
    for (let k = 0; k <= around; k++) {
      const t = (k / around) * Math.PI * 2
      const r = CYL_R - bevel(x) - depth * g * flute(t)
      pos.push(x, CYL_Y + r * Math.cos(t), r * Math.sin(t))
      uv.push(0, k / around)
    }
  }
  for (let i = 0; i < xs.length - 1; i++) {
    for (let k = 0; k < around; k++) {
      const a = i * ring + k
      const b = a + ring
      idx.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }
  const side = new BufferGeometry()
  side.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  side.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  side.setIndex(idx)
  creaseNormals(side, 28)
  const geos = [part(side, M(), steel, 'v')]
  // the faces: the front with its six chambers open, the rear flat against the shield
  const rimR = CYL_R - (d === 'lo' ? 0 : 0.0011)
  const face = new Shape()
  for (let k = 0; k <= around; k++) {
    const t = (k / around) * Math.PI * 2
    const px = rimR * Math.sin(t)
    const py = rimR * Math.cos(t)
    if (k === 0) {
      face.moveTo(px, py)
    } else {
      face.lineTo(px, py)
    }
  }
  const open = d !== 'lo'
  const holeSegs = d === 'hi' ? 18 : 8
  if (open) {
    for (let c = 0; c < 6; c++) {
      const t = (c / 6) * Math.PI * 2
      const hole = new Shape()
      hole.absarc(BOLT_R * Math.sin(t), BOLT_R * Math.cos(t), CH_R, 0, Math.PI * 2, true)
      face.holes.push(hole)
    }
  }
  // the shape's +Z (its face) turned to +X; its (u, v) → (−z, y)
  const front = new ShapeGeometry(face, holeSegs).rotateY(Math.PI / 2).translate(CYL_X1, CYL_Y, 0)
  geos.push(part(front, M(), tint(steel, 1.08), 'y'))
  const back = new ShapeGeometry(face, 4).rotateY(-Math.PI / 2).translate(CYL_X0, CYL_Y, 0)
  geos.push(part(back, M(), steel, 'y'))
  for (let c = 0; c < 6; c++) {
    const t = (c / 6) * Math.PI * 2
    const cy = CYL_Y + BOLT_R * Math.cos(t)
    const cz = BOLT_R * Math.sin(t)
    if (open) {
      // the chamber's wall, seen from inside (its faces turned in), and the round's nose in it
      const wall = new CylinderGeometry(CH_R, CH_R, 0.006, holeSegs, 1, true)
      const ix = wall.getIndex()
      if (ix) {
        const a = ix.array
        for (let k = 0; k < a.length; k += 3) {
          const v = a[k + 1] ?? 0
          a[k + 1] = a[k + 2] ?? 0
          a[k + 2] = v
        }
      }
      wall.deleteAttribute('normal')
      wall.computeVertexNormals()
      geos.push(part(wall, alongX(CYL_X1 - 0.003, cy, cz), tint(BORE, 1.6)))
      if (d !== 'hi') {
        continue
      }
      const nose = new SphereGeometry(
        CH_R * 0.92,
        d === 'hi' ? 12 : 6,
        d === 'hi' ? 5 : 2,
        0,
        Math.PI * 2,
        0,
        Math.PI / 2,
      )
      geos.push(
        part(
          nose,
          M()
            .makeRotationZ(-Math.PI / 2)
            .setPosition(CYL_X1 - 0.0062, cy, cz),
          LEAD,
        ),
      )
    } else {
      geos.push(
        part(
          new CylinderGeometry(CH_R, CH_R, 0.0006, 6, 1),
          alongX(CYL_X1 + 0.0002, cy, cz),
          tint(BORE, 1.6),
        ),
      )
    }
    if (d === 'hi') {
      // the bolt's stop notches, one over each chamber near the rear
      geos.push(
        part(
          new BoxGeometry(0.0042, 0.0014, 0.0024),
          M()
            .makeRotationX(-t)
            .setPosition(
              CYL_X0 + 0.0072,
              CYL_Y + (CYL_R - 0.0005) * Math.cos(t),
              (CYL_R - 0.0005) * Math.sin(t),
            ),
          BORE,
          'y',
        ),
      )
    }
  }
  return forge(geos)
}

/** The hammer at rest (down on the frame), in its native place. */
function hammer(d: RevolverDetail, look: RevolverLook): BufferGeometry {
  const hi = d !== 'lo'
  const f = look.frame
  const p: BufferGeometry[] = [
    // its body, rising out of the frame from the pivot, its face against the shield
    sweep(
      [
        [-0.0605, -0.027, 0],
        [-0.0592, -0.013, 0],
        [-0.0596, -0.001, 0],
        [-0.0628, 0.0085, 0],
      ],
      0.0052,
      f,
      { segments: hi ? 8 : 3, radial: hi ? 10 : 4, flat: 0.88 },
    ),
    // the neck curving back to the spur, wide and flat for the thumb
    sweep(
      [
        [-0.0618, 0.004, 0],
        [-0.0652, 0.0112, 0],
        [-0.0712, 0.0152, 0],
        [-0.0785, 0.0166, 0],
        [-0.0848, 0.0161, 0],
        [-0.0882, 0.0145, 0],
      ],
      0.0036,
      f,
      { segments: hi ? 14 : 4, radial: hi ? 10 : 4, flat: 1.55 },
    ),
  ]
  return forge(p)
}

/** Everything that stays put: barrel, frame, grip, guard, trigger, sights. */
function body(d: RevolverDetail, look: RevolverLook): BufferGeometry[] {
  const hi = d === 'hi'
  const lo = d === 'lo'
  const round = hi ? 24 : d === 'mid' ? 10 : 7
  const sides = hi ? 20 : d === 'mid' ? 10 : 6
  const mx = muzzleX(look.barrel)
  const { steel, frame, guard, grip } = look
  const p: BufferGeometry[] = []
  // ---- the barrel, the ejector rod's housing under it on the right, the base pin
  p.push(
    part(
      new CylinderGeometry(BARREL_R1, BARREL_R0, mx - 0.001, round, 1, false),
      alongX((0.001 + mx) / 2, 0, 0),
      steel,
    ),
  )
  const ex = 0.0125
  const ey = -0.0118
  const ez = 0.0052
  const housingEnd = Math.min(mx - 0.021, HEAD_X + 4.6 * IN)
  p.push(
    part(
      new CylinderGeometry(0.005, 0.005, housingEnd - ex, hi ? 14 : 8, 1, true),
      alongX((ex + housingEnd) / 2, ey, ez),
      steel,
    ),
    // its rounded nose and the ejector rod's head on its left, at rest at the front
    part(
      new SphereGeometry(0.005, hi ? 14 : 8, hi ? 6 : 3, 0, Math.PI * 2, 0, Math.PI / 2),
      M()
        .makeRotationZ(-Math.PI / 2)
        .setPosition(housingEnd, ey, ez),
      steel,
    ),
  )
  if (!lo) {
    p.push(
      part(
        new CylinderGeometry(0.0034, 0.0036, 0.0045, hi ? 12 : 6, 1),
        M()
          .makeRotationX(Math.PI / 2 + 0.5)
          .setPosition(housingEnd - 0.0045, ey - 0.0042, ez - 0.0042),
        tint(steel, 1.15),
      ),
      // the housing's stud and screw on the right, near its front
      screw(housingEnd - 0.011, ey, ez + 0.0052, steel, 0.0018),
      // the base pin's head out of the frame's front
      part(
        new CylinderGeometry(0.0029, 0.0029, 0.004, hi ? 12 : 6, 1),
        alongX(HEAD_X + 0.0015, CYL_Y, 0),
        tint(steel, 1.2),
      ),
      // the bore, a dark disc just proud of the crown
      part(
        new CylinderGeometry(0.0057, 0.0057, 0.0008, hi ? 14 : 8, 1),
        alongX(mx + 0.0002, 0, 0),
        BORE,
      ),
    )
  }
  // ---- the frame: its head round the barrel's shank, the top strap over the cylinder, the bottom
  // under it, the recoil shield behind it and the hammer's housing running back into the grip
  p.push(
    loft(
      [
        [-0.002, -0.0105, 0.0475, 0.0228],
        [0.009, -0.011, 0.0435, 0.0226],
        [HEAD_X - 0.002, -0.0115, 0.0405, 0.0222],
        [HEAD_X, -0.0115, 0.038, 0.0205],
      ],
      frame,
      { sides, square: 0.38 },
    ),
    // the top strap, rising a touch to the notch at its back
    loft(
      [
        [0.004, 0.0118, 0.0058, 0.0136],
        [-0.03, 0.0122, 0.0064, 0.0138],
        [NOTCH_X0 + 0.0005, 0.0128, 0.0076, 0.0146],
      ],
      frame,
      { sides: hi ? 14 : 8, square: 0.5 },
    ),
    // under the cylinder
    loft(
      [
        [0.0, -0.0366, 0.0055, 0.0205],
        [-0.008, -0.0378, 0.0064, 0.0215],
        [CYL_X0 - 0.004, -0.0381, 0.0068, 0.022],
      ],
      frame,
      { sides: hi ? 14 : 8, square: 0.45 },
    ),
    // the recoil shield: round behind the cylinder
    loft(
      [
        [CYL_X0 - 0.0006, -0.0122, 0.0505, 0.039],
        [-0.0468, -0.0124, 0.0518, 0.035],
        [-0.0535, -0.0135, 0.0505, 0.026],
      ],
      frame,
      { sides: hi ? 22 : d === 'mid' ? 12 : 8, square: 0.8 },
    ),
    // the hammer's housing, closing in round the hammer and curving down into the grip
    loft(
      [
        [-0.053, -0.0142, 0.0485, 0.0232],
        [-0.0595, -0.0172, 0.0405, 0.0192],
        [-0.0665, -0.0225, 0.0322, 0.0172],
        [-0.0725, -0.0302, 0.0215, 0.0164],
      ],
      frame,
      { sides, square: 0.42 },
    ),
  )
  // the rear sight: the notch cut across the strap's back end, its floor on the sight line
  const notchTop = 0.0167
  const railW = (0.0146 - NOTCH_W) / 2
  p.push(
    part(
      new BoxGeometry(NOTCH_X0 - NOTCH_X1, SIGHT_Y - 0.009, 0.0146),
      at((NOTCH_X0 + NOTCH_X1) / 2, (SIGHT_Y + 0.009) / 2, 0),
      frame,
      'y',
    ),
  )
  for (const s of [-1, 1]) {
    p.push(
      part(
        new BoxGeometry(NOTCH_X0 - NOTCH_X1, notchTop - SIGHT_Y + 0.0004, railW),
        at(
          (NOTCH_X0 + NOTCH_X1) / 2,
          (notchTop + SIGHT_Y - 0.0004) / 2,
          (s * (NOTCH_W + railW)) / 2,
        ),
        frame,
        'y',
      ),
    )
  }
  if (!lo) {
    p.push(
      // the loading gate in the shield's right side, its thumb tab proud
      part(
        new BoxGeometry(0.006, 0.013, 0.0016),
        M()
          .makeRotationX(-0.55)
          .setPosition(-0.0446, CYL_Y - 0.0085, 0.0158),
        tint(frame, 0.82),
        'y',
      ),
    )
  }
  if (hi) {
    // the frame's screws, both sides: the hammer's, the bolt's, the trigger's, the base pin latch
    for (const z of [-1, 1]) {
      p.push(
        screw(HAMMER_PIVOT.x, HAMMER_PIVOT.y, z * 0.0091, steel),
        screw(-0.0405, -0.0335, z * 0.0109, steel, 0.0019),
        screw(-0.051, -0.0335, z * 0.0118, steel, 0.0019),
      )
    }
    p.push(screw(0.011, -0.0245, -0.0115, steel, 0.0024))
  }
  // ---- the trigger and the brass guard round it, the guard's strap along the frame's belly
  p.push(
    sweep(
      [
        [-0.0455, -0.0372, 0],
        [-0.0462, -0.0462, 0],
        [-0.0492, -0.0535, 0],
        [-0.0545, -0.0582, 0],
      ],
      0.0021,
      look.frame,
      { segments: hi ? 10 : 3, radial: hi ? 8 : 4, flat: 1.35 },
    ),
    sweep(
      [
        [-0.0095, -0.0405, 0],
        [-0.0125, -0.0505, 0],
        [-0.0215, -0.0598, 0],
        [-0.0355, -0.0648, 0],
        [-0.0505, -0.0638, 0],
        [-0.0605, -0.0575, 0],
        [-0.0668, -0.0488, 0],
        [-0.0702, -0.0425, 0],
      ],
      0.0024,
      guard,
      { segments: hi ? 28 : 8, radial: hi ? 8 : 4, flat: 1.75 },
    ),
    loft(
      [
        [-0.006, -0.0417, 0.0036, 0.0118],
        [-0.072, -0.0417, 0.0036, 0.0118],
      ],
      guard,
      { sides: hi ? 10 : 6, square: 0.5, caps: true },
    ),
  )
  // ---- the grip: one-piece walnut between the brass straps, the plow handle curving down and
  // back to its rounded butt
  const spine: PathSection[] = [
    [-0.0738, -0.0335, 0.0245, 0.0238],
    [-0.0792, -0.0495, 0.0266, 0.0268],
    [-0.0852, -0.0655, 0.0284, 0.0294],
    [-0.0925, -0.0812, 0.0302, 0.031],
    [-0.1015, -0.0958, 0.0322, 0.0318],
    [-0.1112, -0.1072, 0.0338, 0.0312],
    [-0.1168, -0.1122, 0.031, 0.0286],
  ]
  p.push(loftPath(spine, grip, { sides: hi ? 22 : d === 'mid' ? 10 : 6, square: 0.62 }))
  if (!lo) {
    // the straps, narrower than the wood and riding its edges, front and back
    const strap = (s: PathSection): PathSection => [s[0], s[1], 0.0072, s[3] * 0.62]
    const edge = (sign: number) =>
      spine.map((s, i) => {
        const a = spine[Math.max(0, i - 1)] ?? s
        const b = spine[Math.min(spine.length - 1, i + 1)] ?? s
        const tx = b[0] - a[0]
        const ty = b[1] - a[1]
        const tl = Math.hypot(tx, ty) || 1
        // the depth axis points forward-down; its back edge is −, the front +
        const k = (sign * (s[2] - 0.0036)) / 2
        return strap([s[0] + (ty / tl) * k, s[1] + (-tx / tl) * k, s[2], s[3]])
      })
    // the back strap runs up over the hump behind the hammer to the frame
    const back = edge(-1)
    p.push(
      loftPath(
        [[-0.0688, -0.0055, 0.0072, 0.0112], [-0.0752, -0.0168, 0.0072, 0.0132], ...back.slice(1)],
        guard,
        { sides: hi ? 12 : 6, square: 0.5 },
      ),
      loftPath(edge(1).slice(1), guard, { sides: hi ? 12 : 6, square: 0.5 }),
    )
  }
  // ---- the front sight: a half-moon blade on the barrel, its top on the sight line
  const bladeR = 0.0068
  p.push(
    part(
      new CylinderGeometry(bladeR, bladeR, 0.0023, hi ? 20 : 8, 1),
      M()
        .makeRotationX(Math.PI / 2)
        .setPosition(mx - 0.0095, SIGHT_Y - bladeR, 0),
      steel,
      'y',
    ),
  )
  if (look.engraved && !lo) {
    p.push(...scrollEngraving())
  }
  return p
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
const lookKey = (l: RevolverLook): string => JSON.stringify(l)

// ---------------------------------------------------------------- placed like the kit prop

/** The standard gun's length and its box: every finish is placed by the same transform. */
let place: { k: number; m: Matrix4 } | null = null

function nativeToProp(size: number): Matrix4 {
  if (!place) {
    const g = nativeGeometry('lo', PEACEMAKER, 'whole')
    g.computeBoundingBox()
    const b = g.boundingBox
    if (!b) {
      throw new Error('revolver: no bounds')
    }
    const len = b.max.x - b.min.x
    const m = M().makeTranslation(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
    place = { k: 1 / len, m }
  }
  return M()
    .makeScale(size * place.k, size * place.k, size * place.k)
    .multiply(place.m)
}

type Piece = 'whole' | 'body' | 'cylinder' | 'hammer'

/** The gun (or one moving piece of it) in its native frame. */
function nativeGeometry(d: RevolverDetail, look: RevolverLook, piece: Piece): BufferGeometry {
  return cached(`native|${d}|${piece}|${lookKey(look)}`, () => {
    if (piece === 'cylinder') {
      return cylinder(d, look)
    }
    if (piece === 'hammer') {
      return hammer(d, look)
    }
    const parts = body(d, look)
    if (piece === 'body') {
      return forge(parts)
    }
    return forge([...parts, hammer(d, look), cylinder(d, look)])
  })
}

/** The revolver's geometry at a size and detail, in the kit prop's frame (shared: never mutate it). */
export function revolverGeometry(
  size: number,
  d: RevolverDetail = 'hi',
  look: RevolverLook = PEACEMAKER,
  piece: Piece = 'whole',
): BufferGeometry {
  return cached(`${size}|${d}|${piece}|${lookKey(look)}`, () => {
    const g = nativeGeometry(d, look, piece).clone().applyMatrix4(nativeToProp(size))
    if (piece === 'cylinder' || piece === 'hammer') {
      // on its pivot: the axis, the screw
      const pv = (piece === 'cylinder' ? CYLINDER_PIVOT : HAMMER_PIVOT)
        .clone()
        .applyMatrix4(nativeToProp(size))
      g.translate(-pv.x, -pv.y, -pv.z)
    }
    g.computeBoundingBox()
    g.computeBoundingSphere()
    return g
  })
}

/**
 * The revolver's landmarks in the kit prop's frame (barrel +X, top +Y, grip at −X −Y): the bore at
 * the muzzle, the middle of the grip where the fist closes, the sight line (the notch's floor and
 * the blade's top), and the sections the holster is cut to.
 */
export function revolverAnatomy(size: number, look: RevolverLook = PEACEMAKER): GunAnatomy {
  const m = nativeToProp(size)
  const k = m.elements[0] ?? 1
  const p = (x: number, y: number) => new Vector3(x, y, 0).applyMatrix4(m)
  const mx = muzzleX(look.barrel)
  const g = revolverGeometry(size, 'lo', look)
  const rearX = g.boundingBox?.min.x ?? p(-0.11, 0).x
  return {
    muzzle: p(mx, 0),
    grip: p(-0.0885, -0.0735),
    rearX,
    mouthX: p(-0.019, 0).x,
    cylinder: { cy: p(0, CYL_Y).y, hy: CYL_R * k, hz: CYL_R * k },
    // the barrel's section with the housing under it and the blade on top
    barrel: {
      cy: p(0, (SIGHT_Y - 0.0175) / 2).y,
      hy: ((SIGHT_Y + 0.0175) / 2) * k,
      hz: 0.0108 * k,
    },
    rear: p(NOTCH_X1 + 0.002, SIGHT_Y),
    front: p(mx - 0.0095, SIGHT_Y),
  }
}

/**
 * The revolver as a prop definition (one part in the guns' one material), placed like the kit's:
 * every `propObject` of it (a hand, a holster, the Outfitter) carries its landmarks.
 */
export function revolverDef(
  size = 0.3,
  d: RevolverDetail = 'hi',
  o: { articulated?: boolean } = {},
): PropDef {
  const g = revolverGeometry(size, d)
  const box = g.boundingBox
  const parts: Part[] = [{ geometry: g, material: gunMaterial() }]
  return {
    name: 'revolver',
    parts,
    size: box ? box.getSize(new Vector3()) : new Vector3(size, size / 2, size / 6),
    userData: {
      gunAnatomy: revolverAnatomy(size),
      revolver: { size, articulated: o.articulated === true },
    },
    ...(o.articulated
      ? { make: () => revolverObject({ size, detail: d, articulated: true }) }
      : {}),
  }
}

/** Past this distance (m) a rider's revolver draws its low level of detail. */
export const REVOLVER_LOD_FAR = 5

/**
 * The revolver as a drawable: one mesh (a hand, a holster), or with `lod` a three.js LOD that swaps
 * to the low level far off (still one draw). With `articulated` it is the body with the cylinder
 * and the hammer as child meshes on their pivots (`cylinder` turns about X, `hammer` about Z:
 * `HAMMER_COCK` is full cock), for first person and the duel's close-ups. Its landmarks ride on it.
 */
export function revolverObject(
  o: {
    size?: number
    detail?: RevolverDetail
    look?: RevolverLook
    lod?: boolean
    articulated?: boolean
    material?: Material
  } = {},
): Object3D {
  const size = o.size ?? 0.3
  const look = o.look ?? PEACEMAKER
  const d = o.detail ?? 'hi'
  const mat = o.material ?? gunMaterial()
  const mesh = (g: BufferGeometry, name: string): Mesh => {
    const m = new Mesh(g, mat)
    m.name = name
    m.castShadow = true
    m.receiveShadow = true
    return m
  }
  let obj: Object3D
  if (o.articulated) {
    const b = mesh(revolverGeometry(size, d, look, 'body'), 'revolver')
    const cyl = mesh(revolverGeometry(size, d, look, 'cylinder'), 'cylinder')
    const ham = mesh(revolverGeometry(size, d, look, 'hammer'), 'hammer')
    const m = nativeToProp(size)
    cyl.position.copy(CYLINDER_PIVOT).applyMatrix4(m)
    ham.position.copy(HAMMER_PIVOT).applyMatrix4(m)
    b.add(cyl, ham)
    obj = b
  } else if (o.lod) {
    const lod = new LOD()
    lod.addLevel(mesh(revolverGeometry(size, d, look), 'revolver'), 0)
    const far = mesh(revolverGeometry(size, 'lo', look), 'revolver-lod')
    // the far level isn't measured (it lies inside the near one)
    far.userData.lod = true
    lod.addLevel(far, REVOLVER_LOD_FAR)
    obj = lod
  } else {
    obj = mesh(revolverGeometry(size, d, look), 'revolver')
  }
  obj.name = 'revolver'
  obj.userData.gunAnatomy = revolverAnatomy(size, look)
  obj.userData.revolver = { size, look }
  return obj
}

/** Seconds after a shot the thumb brings the hammer back, and how long a cocking stroke takes. */
const RECOCK_AT = 0.07
const RECOCK_S = 0.15
/** A Colt's cylinder turns clockwise seen from behind: +X, a sixth a stroke. */
const CHAMBER_TURN = Math.PI / 3

const smooth01 = (t: number): number => {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/**
 * A single action's moving parts on an articulated revolver. Every cocking stroke brings the
 * hammer back and turns the next chamber up under it; at a shot the hammer falls, and while the
 * gun is in hand (`arm`) the thumb cocks it again. Holstered, it is let down. While loading the
 * hammer sits at half cock and the cylinder turns past the gate a chamber at a time.
 */
export class RevolverAction {
  /** Ticked by its owner (Frontier's view model), not by the man holding it (`tickGuns`). */
  manual = false
  private since = 9
  private armed = false
  /** The hammer's travel, 0 down to 1 full cock. */
  private k = 0
  private strokes = 0
  private turn = 0
  private readonly hammer: Object3D | null
  private readonly cylinder: Object3D | null

  constructor(gun: Object3D) {
    this.hammer = gun.getObjectByName('hammer') ?? null
    this.cylinder = gun.getObjectByName('cylinder') ?? null
  }

  /** In hand (cock it) or holstered (let it down). */
  arm(on: boolean): void {
    this.armed = on
  }

  fired(): void {
    this.since = 0
    this.k = 0
  }

  /** Per frame: `reload` is 0..1 through a reload, or null. */
  update(dt: number, reload: number | null = null): void {
    this.since += dt
    const want = this.armed && this.since > RECOCK_AT ? 1 : 0
    const was = this.k
    const step = dt / RECOCK_S
    this.k = want > was ? Math.min(1, was + step) : Math.max(0, was - step * 2)
    if (this.k > was) {
      if (was === 0) {
        this.strokes = (this.strokes + 1) % 6
      }
      this.turn = (this.strokes - 1 + smooth01(this.k)) * CHAMBER_TURN
    }
    let cock = HAMMER_COCK * smooth01(this.k)
    let turn = this.turn
    if (reload !== null) {
      cock = HAMMER_COCK * 0.32
      // six chambers past the gate while the rounds go in, each turned on at the end of its dip
      const loading = Math.min(1, Math.max(0, (reload - 0.3) / 0.52)) * 6
      const n = Math.floor(loading)
      turn += (n + smooth01((loading - n - 0.6) / 0.4)) * CHAMBER_TURN
    }
    if (this.hammer) {
      this.hammer.rotation.z = cock
    }
    if (this.cylinder) {
      this.cylinder.rotation.x = turn
    }
  }
}

const actions = new WeakMap<Object3D, RevolverAction | null>()

/** One of a man's revolvers: cocked once it is out of the holster, let down in it. */
function tickGun(g: Object3D | null, holster: Object3D | null, dt: number): void {
  const a = actionOf(g)
  if (a && !a.manual) {
    a.arm(g?.parent !== holster)
    a.update(dt)
  }
}

/** A man's revolvers, per frame (scene/actor.ts). */
export function tickGuns(
  a: {
    gun: Object3D | null
    offGun: Object3D | null
    holster: Object3D | null
    offHolster: Object3D | null
  },
  dt: number,
): void {
  tickGun(a.gun, a.holster, dt)
  tickGun(a.offGun, a.offHolster, dt)
}

/** The action of a gun (null when it has no moving parts: a rider's, a thumbnail's). */
export function actionOf(gun: Object3D | null): RevolverAction | null {
  if (!gun) {
    return null
  }
  let a = actions.get(gun)
  if (a === undefined) {
    a = gun.getObjectByName('hammer') ? new RevolverAction(gun) : null
    actions.set(gun, a)
  }
  return a
}
