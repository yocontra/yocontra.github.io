// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/style/noMagicNumbers: an arena is a table of measurements, in metres
/**
 * Act III: the mission courtyard (outlaws 11–13, sunset into dusk).
 *
 * The lane runs across the plaza straight at the mission church: a limestone front with a carved
 * doorway and a choir window, and over it the curved bell gable, three bells in its arches and a
 * cross on top, black against the sunset (the low sun sits right behind it). On the left of the
 * frame the convento's long stone arcade, a flat roof over it with vigas and a parapet; on the
 * right a row of adobe houses with a ramada, a ladder to a roof, an oven; in the plaza a well and a
 * tall wooden cross. Iron lanterns light the arches and the church door as the light goes.
 */
import { ExtrudeGeometry, Shape, Vector3, Vector4 } from 'three'
import { buildFlora, type Plant } from '../flora.ts'
import { wallFrame } from '../masonry.ts'
import { DECK } from '../street.ts'
import type { LifeLayout } from '../townlife.ts'
import { ArenaParts, beam, cyl, hangLantern, hitchRail, placeAt, YAW } from './build.ts'
import { church, FRONT_Z } from './mission-church.ts'
import type { Arena, ArenaCtx } from './types.ts'

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z)

/** The arcade: front face (x), its run (z), bay and height; the convento wall behind it. */
const ARC_X = 8.6
const ARC_T = 0.6
const ARC_Z1 = 44
const ARC_BAYS = 23
const BAY = 3.2
const ARC_H = 4.3
const SPRING = 2.2
const CONVENTO_X = 11.5
/** The adobe row across the lane: its street face (x). */
const ROW_X = -11

const PLASTER = 0xf0_dc_c4
const ADOBE = 0xd8_b0_8a
const ADOBE_DARK = 0xb8_8e_6a
const BEAM = 0x5a_42_30
const IRON = 0x2a_26_22

/** Bay centres along the arcade (z), nearest the church first. */
const bayZ = (i: number): number => ARC_Z1 - BAY / 2 - i * BAY

/** An arcade's front, `n` bays in local units (x along, y up): the arches notched up from the foot. */
function arcadeShape(n: number, bay: number, pier: number, h: number, spring: number): Shape {
  const s = new Shape()
  s.moveTo(0, 0)
  for (let i = 0; i < n; i++) {
    const a = i * bay + pier / 2
    const b = (i + 1) * bay - pier / 2
    s.lineTo(a, 0)
    s.lineTo(a, spring)
    s.absarc((a + b) / 2, spring, (b - a) / 2, Math.PI, 0, true)
    s.lineTo(b, 0)
  }
  s.lineTo(n * bay, 0)
  s.lineTo(n * bay, h)
  s.lineTo(0, h)
  s.closePath()
  return s
}

/** The convento's arcade along the left of the frame (+x), its roof walk and the wall behind. */
function arcade(p: ArenaParts): void {
  const len = ARC_BAYS * BAY
  const z0 = ARC_Z1 - len
  const shape = arcadeShape(ARC_BAYS, BAY, 0.8, ARC_H, SPRING)
  const geo = new ExtrudeGeometry(shape, { depth: ARC_T, bevelEnabled: false, curveSegments: 10 })
  geo.applyMatrix4(wallFrame(V(ARC_X, 0, ARC_Z1), V(-1, 0, 0)))
  p.m.add('stone', geo, PLASTER)
  const st = p.m.cell('stone')
  // the walk under it (a step up, like a porch), its roof slab and the parapet along the top
  st.box(
    (ARC_X + CONVENTO_X) / 2 + 0.3,
    DECK / 2,
    (z0 + ARC_Z1) / 2,
    CONVENTO_X - ARC_X + 0.6,
    DECK,
    len,
    0xd8_c8_b0,
    {
      skip: ['bottom'],
    },
  )
  st.box(
    (ARC_X + CONVENTO_X) / 2,
    ARC_H + 0.12,
    (z0 + ARC_Z1) / 2,
    CONVENTO_X - ARC_X + 0.1,
    0.24,
    len,
    PLASTER,
  )
  st.box(ARC_X + 0.15, ARC_H + 0.24 + 0.48, (z0 + ARC_Z1) / 2, 0.3, 0.96, len, PLASTER, {
    skip: ['bottom'],
  })
  // the arches' piers get a moulded impost at the springing line
  for (let i = 0; i <= ARC_BAYS; i++) {
    const z = ARC_Z1 - i * BAY
    st.box(ARC_X + ARC_T / 2, SPRING + 0.05, z, ARC_T + 0.14, 0.14, 0.96, 0xe8_dc_c8)
  }
  // vigas: the roof beams' ends through the wall above the arches
  const t = p.trim
  for (let z = ARC_Z1 - 0.4; z > z0; z -= 0.8) {
    t.box(ARC_X - 0.18, ARC_H - 0.1, z, 0.36, 0.2, 0.2, BEAM)
  }
  // the dark arcade ceiling seen through the arches
  t.box(
    (ARC_X + CONVENTO_X) / 2,
    ARC_H - 0.02,
    (z0 + ARC_Z1) / 2,
    CONVENTO_X - ARC_X,
    0.04,
    len,
    0x4a_36_28,
    {
      rotUV: true,
      skip: ['top'],
    },
  )
  // the convento behind: adobe, plastered, a flat roof with its own parapet and canales
  const a = p.adobe
  const cx = CONVENTO_X + 4
  a.box(cx, 2.8, (z0 + ARC_Z1) / 2, 8, 5.6, len, ADOBE, { skip: ['bottom'] })
  a.box(CONVENTO_X + 0.15, 5.9, (z0 + ARC_Z1) / 2, 0.3, 0.6, len, ADOBE, { skip: ['bottom'] })
  for (let z = ARC_Z1 - 5; z > z0; z -= 9.6) {
    t.box(CONVENTO_X - 0.35, 5.45, z, 0.7, 0.16, 0.22, BEAM)
  }
  // doors and small windows in the back wall, one per bay or so
  for (let i = 0; i < ARC_BAYS; i++) {
    const z = bayZ(i)
    if (i % 3 === 1) {
      p.put('k_door', placeAt(CONVENTO_X - 0.06, DECK, z, YAW['-x']))
      p.put('k_doorframe', placeAt(CONVENTO_X - 0.12, DECK, z, YAW['-x']))
    } else if (i % 3 === 0) {
      p.put('k_window_thin', placeAt(CONVENTO_X - 0.02, DECK, z, YAW['-x']))
      p.put('k_shutters_thin', placeAt(CONVENTO_X + 0.1, DECK, z, YAW['-x']))
    }
  }
  // benches under the arches
  for (const i of [5, 8, 13]) {
    p.put('k_bench', placeAt(CONVENTO_X - 0.55, DECK, bayZ(i), YAW['-x']))
  }
  // ristras hung from the vigas nearest the duel
  for (const z of [27.6, 26.0, 18.4, 13.6, 4.4]) {
    for (let k = 0; k < 7; k++) {
      cyl(
        t,
        ARC_X - 0.3,
        ARC_H - 0.3 - k * 0.13,
        z,
        0.07,
        0.05,
        0.12,
        6,
        k % 2 === 0 ? 0x9a_1e_12 : 0x7a_16_0e,
      )
    }
    t.box(ARC_X - 0.3, ARC_H - 0.22, z, 0.01, 0.08, 0.01, 0x6a_5a_3a)
  }
  // the arcade's end wall against the church yard
  st.box(ARC_X + 1.5, ARC_H / 2, ARC_Z1 + 0.3, 3.0 + 0.3, ARC_H, 0.6, PLASTER, { skip: ['bottom'] })
}

/** A flat-roofed adobe house on the right of the frame: parapet, vigas, door, windows. */
function house(
  p: ArenaParts,
  z0: number,
  z1: number,
  h: number,
  depth: number,
  color: number,
): void {
  const a = p.adobe
  const zc = (z0 + z1) / 2
  const xc = ROW_X - depth / 2
  a.box(xc, h / 2, zc, depth, h, z1 - z0, color, { skip: ['bottom'] })
  // a parapet, its corners raised a touch, round-shouldered
  a.box(ROW_X - 0.15, h + 0.35, zc, 0.3, 0.7, z1 - z0, color, { skip: ['bottom'] })
  for (const z of [z0 + 0.2, z1 - 0.2]) {
    a.box(ROW_X - 0.2, h + 0.5, z, 0.4, 1.0, 0.4, color, { skip: ['bottom'] })
  }
  const t = p.trim
  for (let z = z0 + 0.5; z < z1 - 0.3; z += 0.85) {
    t.box(ROW_X + 0.16, h - 0.32, z, 0.32, 0.18, 0.18, BEAM)
  }
  // a dark wainscot of mud splash
  a.box(ROW_X + 0.02, 0.35, zc, 0.04, 0.7, z1 - z0, ADOBE_DARK)
}

/** The adobe row across the lane, its ramada, ladder, oven, and the garden wall to the church. */
function row(p: ArenaParts): void {
  house(p, -30, -8, 3.4, 8, 0xd0_a8_84)
  house(p, -7, 8, 4.2, 7, 0xd8_b4_8e)
  house(p, 9, 31, 3.6, 8, ADOBE)
  const ry = YAW['+x']
  for (const z of [-24, -12, 0.5, 20, 28]) {
    p.put('k_door', placeAt(ROW_X + 0.06, 0, z, ry))
    p.put('k_doorframe', placeAt(ROW_X + 0.12, 0, z, ry))
  }
  for (const z of [-19, -15.5, -3, 4, 12, 16]) {
    p.put('k_window_thin', placeAt(ROW_X + 0.02, 0, z, ry))
  }
  // the ramada: posts, two beams, and a roof of thin poles across them
  const t = p.trim
  const rx0 = -8.9
  const rz0 = 11.5
  const rz1 = 25.5
  for (const z of [rz0, 16.2, 20.8, rz1]) {
    cyl(t, rx0, 0, z, 0.1, 0.09, 2.75, 6, BEAM, false)
  }
  t.box(rx0, 2.8, (rz0 + rz1) / 2, 0.2, 0.2, rz1 - rz0 + 0.6, BEAM)
  t.box(ROW_X + 0.1, 2.8, (rz0 + rz1) / 2, 0.2, 0.2, rz1 - rz0 + 0.6, BEAM)
  for (let z = rz0 - 0.2; z <= rz1 + 0.2; z += 0.22) {
    beam(t, V(rx0 + 0.3, 2.95, z), V(ROW_X + 0.05, 2.95, z + 0.05), 0.07, 0.07, 0x8a_74_56)
  }
  p.put('k_bench', placeAt(ROW_X + 0.55, 0, 14.3, ry))
  p.put('k_bench', placeAt(ROW_X + 0.55, 0, 22.4, ry))
  p.put('k_table', placeAt(-9.9, 0, 18.4, 0.1))
  // a ladder up to the third house's roof
  for (const s of [-0.24, 0.24]) {
    beam(t, V(ROW_X + 0.9, 0, 30 + s), V(ROW_X + 0.05, 4.6, 30 + s), 0.06, 0.06, 0x8a_6a_48)
  }
  for (let k = 1; k < 11; k++) {
    const f = k / 11
    t.box(ROW_X + 0.9 - f * 0.85, f * 4.6, 30, 0.05, 0.05, 0.5, 0x8a_6a_48)
  }
  // a beehive oven out front
  for (let i = 0; i < 5; i++) {
    const a0 = (i / 5) * (Math.PI / 2)
    const a1 = ((i + 1) / 5) * (Math.PI / 2)
    cyl(
      p.adobe,
      -8.4,
      Math.sin(a0) * 1.1,
      -2.5,
      Math.cos(a0) * 0.95,
      Math.cos(a1) * 0.95,
      (Math.sin(a1) - Math.sin(a0)) * 1.1,
      12,
      ADOBE_DARK,
      false,
    )
  }
  p.trim.box(-7.5, 0.35, -2.5, 0.06, 0.4, 0.5, 0x1a_14_10)
  // the garden wall from the row to the church, a gate in it
  const a = p.adobe
  a.box(-9.2, 1.25, 41.5, 0.6, 2.5, 20, ADOBE, { skip: ['bottom'] })
  a.box(-9.2, 2.6, 41.5, 0.8, 0.2, 20.2, 0xb0_6a_4a)
  a.box(-8.2, 1.25, 51.7, 2.6, 2.5, 0.6, ADOBE, { skip: ['bottom'] })
  // clay pots by the doors
  for (const [x, z] of [
    [-10.5, -11.2],
    [-10.6, 1.4],
    [-10.5, 27.2],
    [10.9, 9.2],
  ] as const) {
    cyl(p.adobe, x, x > 0 ? DECK : 0, z, 0.22, 0.3, 0.55, 10, 0xb0_5a_3a)
  }
  p.prop('cart', 3.6, 'max', placeAt(-8.3, 0, -15.5, 0.25))
  p.prop('hay', 1.3, 'y', placeAt(-8.6, 0, 6.2, 0.4))
}

/** The plaza: a well, the tall cross, a hitching rail, and the church yard's lamps. */
function plaza(p: ArenaParts): void {
  // the well: a stone ring, a timber frame, a crossbar and a bucket
  const wx = -5.6
  const wz = 31
  cyl(p.m.cell('stone'), wx, 0, wz, 1.0, 1.0, 0.8, 16, 0xe0_d0_b8)
  cyl(p.m.cell('stone'), wx, 0.8, wz, 1.06, 1.06, 0.1, 16, 0xd0_c0_a8, false)
  p.adobe.box(wx, 0.79, wz, 1.6, 0.02, 1.6, 0x2a_22_1c)
  const t = p.trim
  for (const dx of [-0.95, 0.95]) {
    t.box(wx + dx, 1.3, wz, 0.14, 1.9, 0.14, BEAM)
  }
  t.box(wx, 2.2, wz, 2.2, 0.14, 0.16, BEAM)
  t.box(wx, 1.8, wz, 0.01, 0.8, 0.01, 0x6a_5a_3a)
  p.put('k_bucket', placeAt(wx, 1.2, wz))
  // the cross on its stepped base, in the church yard (screen left of the lane)
  const cx = 5.2
  const cz = 40
  const st = p.m.cell('stone')
  st.box(cx, 0.2, cz, 2.2, 0.4, 2.2, 0xe0_d0_b8, { skip: ['bottom'] })
  st.box(cx, 0.55, cz, 1.5, 0.3, 1.5, 0xe0_d0_b8, { skip: ['bottom'] })
  t.box(cx, 3.6, cz, 0.3, 5.8, 0.3, 0x5a_44_30)
  t.box(cx, 5.1, cz, 2.0, 0.28, 0.3, 0x5a_44_30)
  // hitching rails either side
  hitchRail(t, 8.2, 30.5, 'z')
  hitchRail(t, -8.25, 4.4, 'z')
  // lamp brackets either side of the church door
  for (const sx of [-1, 1]) {
    t.box(sx * 2.25, 4.4, FRONT_Z - 0.35, 0.06, 0.06, 0.6, IRON)
  }
}

/** Prickly pear and ocotillo by the walls and in the garden, and tufts at the walls' feet. */
function plants(p: ArenaParts, tier: string): void {
  const list: Plant[] = []
  let seed = 7
  const add = (kind: Plant['kind'], x: number, z: number, s = 1) => {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0
    list.push({ kind, x, z, s, seed, lod: 0 })
  }
  for (const [x, z] of [
    [-12, 36],
    [-14.5, 44],
    [-11.5, 48],
    [-16, 39],
  ] as const) {
    add('pear', x, z, 1.1)
  }
  add('ocotillo', -13, 41.5, 1.2)
  add('ocotillo', 7.6, 47.5, 1.1)
  add('pear', 7.8, 49.5, 0.9)
  add('barrel', -8.3, 9.4, 0.9)
  add('pear', -7.9, -6.4, 0.8)
  if (tier !== 'floor' && tier !== 'legacy') {
    for (let z = -26; z < 44; z += 3.3) {
      add('grass', 8.25, z + ((z * 7) % 1.3), 0.7)
      add('grass', -10.6, z + 1.1 + ((z * 5) % 1.1), 0.7)
    }
  }
  p.root.add(buildFlora(list, { heightAt: () => 0, chunk: 60 }))
}

function lifeLayout(): LifeLayout {
  const faceR = -Math.PI / 2
  const faceL = Math.PI / 2
  const seat = DECK + 0.42
  const bench = CONVENTO_X - 0.63
  const lane = ARC_X + 1.3
  return {
    folk: [
      { x: ARC_X + 0.85, y: ARC_H + 0.24, z: 14.2, yaw: faceR, habit: 'rail', door: null },
      {
        x: ARC_X + 0.88,
        y: DECK,
        z: ARC_Z1 - 7 * BAY + 0.25,
        yaw: faceR - 0.35,
        habit: 'lean',
        door: [CONVENTO_X + 0.3, bayZ(7)],
        lane,
      },
      {
        x: -9.6,
        y: 0,
        z: 25.2,
        yaw: faceL - 0.3,
        habit: 'stand',
        door: [ROW_X - 0.4, 20],
        floor: 0,
        lane: -9.6,
      },
      { x: ROW_X - 0.55, y: 3.6, z: 19.6, yaw: faceL, habit: 'rail', door: null },
      {
        x: bench,
        y: seat,
        z: bayZ(5),
        yaw: faceR,
        habit: 'whittle',
        door: [CONVENTO_X + 0.3, bayZ(4)],
        lane,
      },
      {
        x: CONVENTO_X - 0.4,
        y: DECK,
        z: bayZ(10) + 0.1,
        yaw: faceR - 0.4,
        habit: 'door',
        door: [CONVENTO_X + 0.3, bayZ(10)],
        lane,
      },
      {
        x: ROW_X + 0.63,
        y: 0.42,
        z: 14.3,
        yaw: faceL,
        habit: 'sit',
        door: [ROW_X - 0.4, 12],
        floor: 0,
        lane: -9.8,
      },
      { x: -4.2, y: 0, z: 30.4, yaw: faceL - 0.6, habit: 'stand', door: null, floor: 0 },
      { x: bench, y: seat, z: bayZ(13), yaw: faceR, habit: 'sit', door: null },
    ],
    // along the third house's parapet, in the standoff's frame beyond the outlaw
    crows: { x: ROW_X - 0.15, y: 4.08, z: 23.5, along: 'z', face: Math.PI / 2 },
    horses: [
      { x: 6.95, y: 0, z: 30.5, yaw: Math.PI / 2 },
      { x: -7.05, y: 0, z: 4.4, yaw: -Math.PI / 2 },
    ],
    dog: { x: ARC_X + 1.25, y: DECK, z: bayZ(8) - 0.6, yaw: faceR },
    // the convento door a bay up from the arcade's near end: a slatted door, banging in the wind
    door: { x: CONVENTO_X - 0.15, y: DECK, z: bayZ(4) - 0.45, yaw: 0 },
    hens: { x: -6.8, z: 34.5 },
  }
}

export function build(ctx: ArenaCtx): Arena {
  const p = new ArenaParts(ctx, 'mission')
  church(p)
  arcade(p)
  row(p)
  plaza(p)
  plants(p, ctx.tier)
  const lamps: [number, number, number][] = []
  for (const i of [3, 6, 9]) {
    const z = bayZ(i)
    lamps.push([ARC_X + 1.2, hangLantern(p, ARC_X + 1.2, ARC_H, z), z])
  }
  lamps.push([-9.95, hangLantern(p, -9.95, 2.7, 18.6), 18.6])
  for (const sx of [-1, 1]) {
    const x = sx * 2.25
    lamps.push([x, hangLantern(p, x, 4.37, FRONT_Z - 0.62), FRONT_Z - 0.62])
  }
  p.finish()
  const pools = [
    ...lamps.map(([x, , z]) => new Vector4(x, z, 4.4, 1)),
    new Vector4(0, FRONT_Z - 2, 4.5, -0.8),
    ...[bayZ(4), bayZ(7), bayZ(10)].map((z) => new Vector4(CONVENTO_X - 1.2, z, 2.6, -0.5)),
    ...[0.5, 20].map((z) => new Vector4(ROW_X + 1, z, 2.6, -0.5)),
  ]
  return {
    id: 'mission',
    root: p.root,
    lanterns: lamps,
    pools,
    bell: V(0, 13.4, FRONT_Z + 0.55),
    life: lifeLayout(),
    ruts: 0.25,
    dispose: () => p.dispose(),
  }
}
