// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * The clock tower at the end of the street: a courthouse (scene/courthouse.ts) with a square
 * brick tower on its front. Sandstone plinth, bands and quoins; a clock stage with four enamel
 * dials in stone drums and bronze bezels; an open belfry of round arches with a bronze bell on
 * an iron headstock; a bell-cast cedar-shingle spire with louvred lucarnes, a gilt ball finial
 * and a weathervane.
 *
 * Three draws of its own (masonry, iron, dials); its timber, glass and kit pieces join the
 * street's batches. The hands and the bell turn in the iron shader (scene/civic.ts).
 */
import {
  BoxGeometry,
  type BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Path,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { civicMaterial, dialMaterial, ironMaterials, SPIN, type SpinUniforms } from './civic.ts'
import {
  BRICK,
  boxOn,
  buildHall,
  buildPortico,
  DARK_WOOD,
  type Face,
  onFace,
  PAINT,
  type Parts,
  quoins,
  SHINGLE,
  STONE,
  sashWindow,
  TIN,
} from './courthouse.ts'
import type { GeoBuilder } from './geo.ts'
import { archPanel, archRing, dialFrame, ironPart, Masonry, plate, wallFrame } from './masonry.ts'

const TH = 2.5
const BH = 2.35
const BT = 0.35
const SHAFT_TOP = 14.1
const BELFRY0 = 14.6
const BELFRY1 = 18.3
const DIAL_Y = 12.2
const DIAL_R = 1.3
const DIAL_OUT = 0.22
const IRON = 0x24_22_20
const BRONZE = 0xa8_80_48
const GILT = 0xd8_b0_60

/** Outward normal of tower face k (0 = the street, then clockwise seen from above). */
function outward(k: number): Vector3 {
  return new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), (-k * Math.PI) / 2)
}

/** A tower face as a wall plane, at half-width `h` about the tower axis (0, tz). */
function face(k: number, h: number, tz: number): Face {
  const n = outward(k)
  const nx = Math.round(n.x)
  const nz = Math.round(n.z)
  return { nx, nz, d: nz === 0 ? nx * h : tz + nz * h }
}

/** Position along a tower face: x for the front and back, z for the sides. */
function along(f: Face, a: number, tz: number): number {
  if (f.nz === 0) {
    return tz - f.nx * a
  }
  return f.nz < 0 ? a : -a
}

interface Ctx extends Parts {
  tz: number
  iron: BufferGeometry[]
  dials: BufferGeometry[]
}

function shaft(c: Ctx): void {
  const { m, tz } = c
  const s = m.cell('stone')
  const br = m.cell('brick')
  s.box(0, 0.45, tz, TH * 2 + 0.2, 0.9, TH * 2 + 0.2, STONE, { skip: ['bottom'] })
  br.box(0, (0.9 + SHAFT_TOP) / 2, tz, TH * 2, SHAFT_TOP - 0.9, TH * 2, BRICK, {
    skip: ['bottom'],
  })
  for (const [y, h, p] of [
    [4.6, 0.2, 0.06],
    [8.52, 0.25, 0.15],
    [10.4, 0.2, 0.1],
    [SHAFT_TOP + 0.12, 0.25, 0.2],
    [SHAFT_TOP + 0.37, 0.25, 0.38],
  ] as const) {
    s.box(0, y, tz, TH * 2 + p * 2, h, TH * 2 + p * 2, STONE)
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      quoins(s, sx * TH, tz + sz * TH, sx, sz, 0.9, 10.3)
      quoins(s, sx * TH, tz + sz * TH, sx, sz, 10.5, SHAFT_TOP)
      quoins(s, sx * BH, tz + sz * BH, sx, sz, BELFRY0, BELFRY1, 0.3)
    }
  }
  sashWindow(c, face(0, TH, tz), 0, 5.6)
  for (let k = 0; k < 4; k++) {
    const f = face(k, TH, tz)
    // the clock stage: a dressed panel behind each dial, consoles under the cornice
    boxOn(s, f, along(f, 0, tz), DIAL_Y, 3.3, 3.3, 0.06, STONE)
    for (const a of [-2.0, -1.0, 0, 1.0, 2.0]) {
      boxOn(c.trim, f, along(f, a, tz), SHAFT_TOP - 0.17, 0.14, 0.34, 0.18, DARK_WOOD)
    }
    clockFace(c, k)
  }
}

/** One dial: a stone drum, the enamel face, a bronze bezel, the hands and their boss. */
function clockFace(c: Ctx, k: number): void {
  const n = outward(k)
  const centre = new Vector3(0, DIAL_Y, c.tz).addScaledVector(n, TH + DIAL_OUT)
  const fr = dialFrame(centre, n)
  const drum = new CylinderGeometry(1.42, 1.42, 0.16, 48, 1, true)
    .rotateX(Math.PI / 2)
    .translate(0, 0, -0.08)
    .applyMatrix4(fr)
  c.m.add('stone', drum, STONE)
  c.dials.push(new CircleGeometry(DIAL_R, 64).applyMatrix4(fr))
  c.iron.push(ironPart(new TorusGeometry(1.36, 0.075, 8, 64).applyMatrix4(fr), BRONZE))
  const boss = new CylinderGeometry(0.06, 0.07, 0.12, 16).rotateX(Math.PI / 2).translate(0, 0, 0.06)
  c.iron.push(ironPart(boss.applyMatrix4(fr), IRON))
  const pip = new Path()
  pip.absarc(0, 0.56, 0.035, 0, Math.PI * 2, false)
  const hour = plate(
    [
      [-0.035, -0.16],
      [0.035, -0.16],
      [0.03, 0.42],
      [0.12, 0.54],
      [0, 0.8],
      [-0.12, 0.54],
      [-0.03, 0.42],
    ],
    0.022,
    [pip],
  ).translate(0, 0, 0.025)
  const minute = plate(
    [
      [-0.024, -0.14],
      [0.024, -0.14],
      [0.018, 0.98],
      [0.07, 0.98],
      [0, 1.16],
      [-0.07, 0.98],
      [-0.018, 0.98],
    ],
    0.02,
  ).translate(0, 0, 0.055)
  // the minute hand's counterweight: a slim lozenge
  const minuteTail = plate(
    [
      [0, -0.12],
      [0.05, -0.26],
      [0, -0.4],
      [-0.05, -0.26],
    ],
    0.02,
  ).translate(0, 0, 0.055)
  for (const [g, kind] of [
    [hour, SPIN.hour],
    [minute, SPIN.minute],
    [minuteTail, SPIN.minute],
  ] as const) {
    c.iron.push(ironPart(g.applyMatrix4(fr), 0x14_13_12, kind, centre, n))
  }
}

/** The open belfry: four arched panels, archivolts, sills, balustrades, bell frame and bell. */
function belfry(c: Ctx): void {
  const { m, tz } = c
  const h = BELFRY1 - BELFRY0
  const ow = 2.0
  const sill = 0.42
  const spring = 2.3
  for (let k = 0; k < 4; k++) {
    const n = outward(k)
    const w = k % 2 === 0 ? BH * 2 : BH * 2 - BT * 2
    const right = new Vector3().crossVectors(n, new Vector3(0, 1, 0))
    const origin = new Vector3(0, BELFRY0, tz).addScaledVector(n, BH).addScaledVector(right, -w / 2)
    const fr = wallFrame(origin, n)
    m.add('brick', archPanel(w, h, BT, ow, sill, spring).applyMatrix4(fr), BRICK)
    m.add(
      'stone',
      archRing(w / 2, spring, ow / 2, ow / 2 + 0.24, 0.06)
        .translate(0, 0, -0.06)
        .applyMatrix4(fr),
      STONE,
    )
    const piece = (x: number, y: number, sx: number, sy: number, d: number) =>
      m.add(
        'stone',
        new BoxGeometry(sx, sy, d).translate(x, y, d / 2 - 0.08).applyMatrix4(fr),
        STONE,
      )
    piece(w / 2, spring + ow / 2 + 0.12, 0.3, 0.42, 0.22)
    piece(w / 2 - ow / 2 - 0.1, spring - 0.08, 0.36, 0.16, 0.2)
    piece(w / 2 + ow / 2 + 0.1, spring - 0.08, 0.36, 0.16, 0.2)
    piece(w / 2, sill - 0.05, ow + 0.4, 0.12, BT + 0.2)
    balustrade(c.trim, face(k, BH, tz), tz, BELFRY0 + sill, ow)
  }
  const s = m.cell('stone')
  s.box(0, BELFRY1 + 0.09, tz, BH * 2 + 0.3, 0.18, BH * 2 + 0.3, STONE)
  s.box(0, BELFRY1 + 0.25, tz, BH * 2 + 0.7, 0.16, BH * 2 + 0.7, STONE)
  // inside: plank floor, ceiling, and the oak frame the headstock rides on
  const t = c.trim
  const inner = (BH - BT) * 2
  t.box(0, BELFRY0 + 0.05, tz, inner, 0.1, inner, 0x2a_20_18)
  t.box(0, BELFRY1 - 0.05, tz, inner, 0.1, inner, 0x1e_18_12)
  for (const sx of [-1, 1]) {
    t.box(sx * 1.05, BELFRY0 + 1.1, tz, 0.2, 2.2, 0.24, 0x16_10_0c)
    t.box(sx * 1.05, BELFRY0 + 0.2, tz, 0.3, 0.2, 1.6, 0x16_10_0c)
  }
  bell(c)
}

function balustrade(t: GeoBuilder, f: Face, tz: number, y: number, w: number): void {
  const a0 = along(f, 0, tz)
  boxOn(t, f, a0, y + 0.62, w + 0.1, 0.08, -BT / 2 + 0.07, PAINT, BT / 2 + 0.07)
  boxOn(t, f, a0, y + 0.06, w, 0.06, -BT / 2 + 0.06, PAINT, BT / 2 + 0.06)
  for (let a = -w / 2 + 0.12; a < w / 2 - 0.05; a += 0.19) {
    boxOn(t, f, along(f, a, tz), y + 0.34, 0.06, 0.5, -BT / 2 + 0.03, PAINT, BT / 2 + 0.03)
  }
}

/** The bell, its clapper and the iron headstock: they swing together about the headstock. */
function bell(c: Ctx): void {
  const top = BELFRY0 + 2.15
  const pivot = new Vector3(0, top + 0.12, c.tz)
  const axis = new Vector3(0, 0, 1)
  const prof = [
    [0, 1.0],
    [0.16, 1.0],
    [0.27, 0.95],
    [0.33, 0.82],
    [0.35, 0.62],
    [0.39, 0.42],
    [0.47, 0.22],
    [0.58, 0.08],
    [0.63, 0.0],
    [0.6, -0.02],
    [0.53, 0.05],
    [0.42, 0.2],
    [0.33, 0.42],
    [0.29, 0.66],
    [0.25, 0.86],
    [0, 0.92],
  ].map(([r = 0, y = 0]) => new Vector2(r, y))
  const body = new LatheGeometry(prof, 28).translate(0, top - 1.0, c.tz)
  c.iron.push(ironPart(body, BRONZE, SPIN.bell, pivot, axis))
  const crown = new CylinderGeometry(0.1, 0.14, 0.14, 12).translate(0, top + 0.05, c.tz)
  c.iron.push(ironPart(crown, BRONZE, SPIN.bell, pivot, axis))
  const stock = new BoxGeometry(2.0, 0.22, 0.26).translate(0, top + 0.2, c.tz)
  c.iron.push(ironPart(stock, IRON, SPIN.bell, pivot, axis))
  const clapper = new SphereGeometry(0.09, 10, 8).translate(0, top - 0.88, c.tz)
  c.iron.push(ironPart(clapper, IRON, SPIN.bell, pivot, axis))
  const rod = new CylinderGeometry(0.025, 0.025, 0.8, 6).translate(0, top - 0.48, c.tz)
  c.iron.push(ironPart(rod, IRON, SPIN.bell, pivot, axis))
}

/** Bell-cast spire: a flared eave, then a concave taper to the finial; four lucarnes. */
function spire(c: Ctx): void {
  const { m, tz } = c
  const b = m.cell('slate')
  const rings: [number, number][] = [
    [BELFRY1 + 0.3, 3.05],
    [BELFRY1 + 0.62, 2.55],
  ]
  const y0 = BELFRY1 + 0.62
  const tip = 25.2
  for (let i = 1; i <= 10; i++) {
    const s = i / 10
    rings.push([y0 + (tip - y0) * s, 0.09 + 2.46 * (1 - s) ** 1.5])
  }
  const rot = (k: number) => new Matrix4().makeRotationY((-k * Math.PI) / 2)
  for (let k = 0; k < 4; k++) {
    const r = rot(k)
    const W = (x: number, y: number, z: number) =>
      new Vector3(x, y, z).applyMatrix4(r).add(new Vector3(0, 0, tz))
    const side = k % 2 === 1
    for (let i = 0; i + 1 < rings.length; i++) {
      const [ya, ha] = rings[i] as [number, number]
      const [yb, hb] = rings[i + 1] as [number, number]
      const flat = ha - hb > yb - ya
      b.quad(
        W(ha, ya, -ha),
        W(-ha, ya, -ha),
        W(-hb, yb, -hb),
        W(hb, yb, -hb),
        SHINGLE,
        side && flat,
      )
    }
    // the eave's underside
    const [ey, eh] = rings[0] as [number, number]
    const e = BH + 0.35
    m.cell('tin').quad(W(-eh, ey, -eh), W(eh, ey, -eh), W(e, ey, -e), W(-e, ey, -e), TIN)
    lucarne(c, k, rings)
  }
  finial(c, tip)
}

/** A small gabled louvre vent on spire face k. */
function lucarne(c: Ctx, k: number, rings: [number, number][]): void {
  const y = 20.35
  const [ya, ha] = rings[2] as [number, number]
  const [yb, hb] = rings[4] as [number, number]
  const hw = ha + ((hb - ha) * (y - ya)) / (yb - ya)
  const f = face(k, hw + 0.5, c.tz)
  const a = along(f, 0, c.tz)
  const slate = c.m.cell('slate')
  // shingled cheeks, a louvred front, and a little gable roof running into the spire
  boxOn(slate, f, a, y, 0.86, 0.9, 0.0, SHINGLE, 0.9)
  boxOn(c.trim, f, a, y - 0.02, 0.62, 0.72, 0.03, 0x1a_14_10)
  for (let i = 0; i < 5; i++) {
    boxOn(c.trim, f, a, y - 0.3 + i * 0.14, 0.58, 0.04, 0.09, 0x8a_78_60)
  }
  boxOn(c.trim, f, a, y, 0.92, 0.96, 0.02, PAINT, 0)
  const out = onFace(f, a, y + 0.45, -0.35)
  slate.gable(out.x, out.y, out.z, 1.0, 1.0, 0.42, f.nz === 0 ? 'x' : 'z', SHINGLE, 0.1)
}

function finial(c: Ctx, tip: number): void {
  const p = (g: BufferGeometry, col: number) => c.iron.push(ironPart(g.translate(0, 0, c.tz), col))
  p(new CylinderGeometry(0.12, 0.2, 0.3, 12).translate(0, tip, 0), IRON)
  p(new SphereGeometry(0.24, 16, 12).translate(0, tip + 0.36, 0), GILT)
  p(new CylinderGeometry(0.035, 0.05, 1.5, 8).translate(0, tip + 1.2, 0), IRON)
  for (const rz of [0, Math.PI / 2]) {
    p(
      new CylinderGeometry(0.02, 0.02, 1.0, 6)
        .rotateZ(Math.PI / 2)
        .rotateY(rz)
        .translate(0, tip + 0.95, 0),
      IRON,
    )
  }
  for (const [x, z] of [
    [0.5, 0],
    [-0.5, 0],
    [0, 0.5],
    [0, -0.5],
  ] as const) {
    p(new SphereGeometry(0.05, 8, 6).translate(x, tip + 0.95, z), GILT)
  }
  const vane = plate(
    [
      [-0.85, 0.0],
      [-0.6, 0.0],
      [-0.7, 0.2],
      [-0.4, 0.04],
      [0.55, 0.04],
      [0.55, 0.13],
      [0.85, 0.02],
      [0.55, -0.09],
      [0.55, 0.0],
      [-0.4, -0.0],
      [-0.7, -0.16],
      [-0.6, -0.0],
    ],
    0.02,
  ).translate(0, tip + 1.62, -0.01)
  p(vane, IRON)
  p(new SphereGeometry(0.06, 8, 6).translate(0, tip + 1.98, 0), GILT)
}

/** Darken what the sun can't reach: the belfry's inside, the eave soffit. */
function occlusion(tz: number) {
  const lim = BH - BT + 0.02
  return (p: Vector3, n: Vector3): number => {
    if (
      Math.abs(p.x) <= lim &&
      Math.abs(p.z - tz) <= lim &&
      p.y > BELFRY0 - 0.05 &&
      p.y < BELFRY1 + 0.05
    ) {
      return 0.32
    }
    return n.y < -0.5 ? 0.6 : 1
  }
}

/** The clock tower, its moving parts and its lighting hooks. */
export class ClockTower {
  readonly bellPos: Vector3
  readonly dialMat: MeshStandardMaterial
  private readonly spin: SpinUniforms
  private readonly hand = [
    { x: 0, v: 0, to: 0 },
    { x: 0, v: 0, to: 0 },
  ]
  private swing = 0
  private swingV = 0

  /** `cz` is the street's tower line (STREET.churchZ); `onReady` fires when the atlas lands. */
  constructor(root: Object3D, parts: Omit<Parts, 'm'>, cz: number, onReady: () => void) {
    const tz = cz - 0.5
    const c: Ctx = { ...parts, m: new Masonry(), tz, iron: [], dials: [] }
    buildHall(c, cz, TH)
    buildPortico(c, tz - TH)
    shaft(c)
    belfry(c)
    spire(c)
    const add = (
      geo: BufferGeometry | null,
      mat: MeshStandardMaterial,
      shadow: boolean,
    ): Mesh | null => {
      if (!geo) {
        return null
      }
      const mesh = new Mesh(geo, mat)
      mesh.castShadow = shadow
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      root.add(mesh)
      return mesh
    }
    add(c.m.build(occlusion(tz)), civicMaterial(4, onReady), true)
    const iron = ironMaterials()
    this.spin = iron.uniforms
    const ironMesh = add(mergeGeometries(c.iron, false), iron.mat, true)
    if (ironMesh) {
      ironMesh.customDepthMaterial = iron.depth
    }
    this.dialMat = dialMaterial()
    add(mergeGeometries(c.dials, false), this.dialMat, false)
    this.bellPos = new Vector3(0, BELFRY0 + 1.6, tz)
  }

  /** Set the time; the hands step there (a small step clunks, a big one jumps). */
  setClock(h: number, m: number): void {
    const target = [((h % 12) + m / 60) * (Math.PI / 6), (m / 60) * Math.PI * 2]
    this.hand.forEach((s, i) => {
      const t = target[i] ?? 0
      const d = Math.atan2(Math.sin(t - s.x), Math.cos(t - s.x))
      s.to = s.x + d
      if (Math.abs(d) > 0.3) {
        s.x = s.to
        s.v = 0
      }
    })
    this.writeAngles()
  }

  /** A stroke of the bell: it swings out and settles. */
  toll(): void {
    this.swingV += 1.1
  }

  /** Night lighting of the dials (0..1). */
  night(k: number): void {
    this.dialMat.emissiveIntensity = k * 1.25
  }

  update(dt: number): void {
    const step = Math.min(dt, 1 / 30)
    for (const s of this.hand) {
      const a = 900 * (s.to - s.x) - 30 * s.v
      s.v += a * step
      s.x += s.v * step
    }
    const w = (Math.PI * 2) / 1.7
    this.swingV += (-w * w * this.swing - 2 * 0.07 * w * this.swingV) * step
    this.swing = Math.max(-0.55, Math.min(0.55, this.swing + this.swingV * step))
    this.writeAngles()
  }

  private writeAngles(): void {
    // the shader turns about the outward normal: clockwise as seen is negative
    this.spin.owAngles.value.set(-(this.hand[0]?.x ?? 0), -(this.hand[1]?.x ?? 0), this.swing)
  }
}
