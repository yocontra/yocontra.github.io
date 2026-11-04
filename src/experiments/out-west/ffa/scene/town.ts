// biome-ignore-all lint/style/noExcessiveLinesPerFile: one town builder; the paint table and the per-feature builders share private helpers
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: array lookups narrowed by the layout's types
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: addBuilding assembles walls, windows, roof, front and porch per building kind
// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * Perdition, built from `town.layout.json` (the same file the server builds its collision grid
 * from, so what you see is what blocks you). Everything static merges into a handful of draws:
 * painted plank walls, stone walls (bank, jail), roofs (with a building id for the roof fade),
 * wood (boardwalks, porches, floors, the bridge, boxcars), windows and signs; props from the shared
 * props GLB are instanced per type.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Assets } from '../../engine/assets.ts'
import { GeoBuilder } from '../../scene/geo.ts'
import {
  instance,
  mergePlaced,
  type PropDef,
  placeMatrix,
  propDef,
  propsLibrary,
} from '../../scene/props.ts'
import { signAtlas } from '../../scene/textures.ts'
import { type Building, buildingWalls, type Side, type TownLayout } from '../sim/layout.ts'
import { addClockTower } from './clock-tower.ts'
import {
  decks,
  floorHeight,
  frontOf,
  PLATFORM_DEPTH,
  PORCH_DECK,
  PORCH_DEPTH,
  PORCH_ROOF,
  PORCHED,
  sideStrip,
} from './cover-kinds.ts'
import { cutaway } from './cutaway.ts'
import { dressCover } from './dressing.ts'
import { bakeGroundMask, groundMesh } from './ground.ts'
import { OUTSKIRTS_SEED, outskirtsGeometry } from './outskirts.ts'
import { buildRoof, RK_PLAIN, roofSkin, roofSkins, tinColor } from './roofs.ts'

interface Paint {
  wall: number
  trim: number
  roof: number
  sign: string | null
  signBg: string
  stone: boolean
  falseFront: boolean
  gable: boolean
}

const PAINT: Record<string, Paint> = {
  saloon: {
    wall: 0x9a_4a_32,
    trim: 0xe8_d8_b0,
    roof: 0x5a_3a_2a,
    sign: 'SALOON',
    signBg: '#2a1810',
    stone: false,
    falseFront: true,
    gable: false,
  },
  hotel: {
    wall: 0x6f_86_8a,
    trim: 0xf0_e6_cc,
    roof: 0x4a_44_40,
    sign: 'HOTEL',
    signBg: '#efe2c0',
    stone: false,
    falseFront: true,
    gable: false,
  },
  assay: {
    wall: 0xb8_9a_6a,
    trim: 0x5a_3c_24,
    roof: 0x5a_48_38,
    sign: 'ASSAY OFFICE',
    signBg: '#3a2414',
    stone: false,
    falseFront: true,
    gable: false,
  },
  church: {
    wall: 0xe8_e0_cc,
    trim: 0x7a_5a_3a,
    roof: 0x4a_3a_30,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
  tower: {
    wall: 0xe8_e0_cc,
    trim: 0x7a_5a_3a,
    roof: 0x4a_3a_30,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: false,
  },
  stable: {
    wall: 0x8a_5a_3a,
    trim: 0xe0_d0_b0,
    roof: 0x6a_4a_30,
    sign: 'LIVERY',
    signBg: '#e8dcc0',
    stone: false,
    falseFront: false,
    gable: true,
  },
  stage_line: {
    wall: 0x3e_5a_44,
    trim: 0xe8_c8_70,
    roof: 0x3a_32_2a,
    sign: 'STAGE LINE',
    signBg: '#e8c870',
    stone: false,
    falseFront: true,
    gable: false,
  },
  general_store: {
    wall: 0xc8_a8_70,
    trim: 0x4a_30_1c,
    roof: 0x5e_4a_38,
    sign: 'GENERAL STORE',
    signBg: '#4a301c',
    stone: false,
    falseFront: true,
    gable: false,
  },
  bank: {
    wall: 0xb8_a8_90,
    trim: 0x2e_3a_30,
    roof: 0x3e_3a_36,
    sign: 'BANK',
    signBg: '#1e2a22',
    stone: true,
    falseFront: true,
    gable: false,
  },
  undertaker: {
    wall: 0x3a_34_32,
    trim: 0xb8_b0_a0,
    roof: 0x2a_26_24,
    sign: 'UNDERTAKER',
    signBg: '#141010',
    stone: false,
    falseFront: true,
    gable: false,
  },
  jail: {
    wall: 0xa0_94_82,
    trim: 0x3a_30_28,
    roof: 0x44_3c_34,
    sign: 'SHERIFF',
    signBg: '#2a2018',
    stone: true,
    falseFront: true,
    gable: false,
  },
  depot: {
    wall: 0x8a_3a_2a,
    trim: 0xe8_d0_a0,
    roof: 0x3a_34_30,
    sign: 'DEPOT',
    signBg: '#e8d0a0',
    stone: false,
    falseFront: false,
    gable: true,
  },
  shed: {
    wall: 0x8a_70_54,
    trim: 0x5a_44_30,
    roof: 0x6a_5a_48,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
  outhouse: {
    wall: 0x7a_5e_42,
    trim: 0x5a_44_30,
    roof: 0x5a_4a_3a,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
  smithy: {
    wall: 0x5a_4a_40,
    trim: 0xd0_a0_60,
    roof: 0x3a_32_2c,
    sign: 'SMITHY',
    signBg: '#d0a060',
    stone: false,
    falseFront: false,
    gable: true,
  },
  water_tower: {
    wall: 0x7a_5a_3c,
    trim: 0x5a_44_30,
    roof: 0x4a_3a_2c,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: false,
  },
  barn: {
    wall: 0x8a_2e_22,
    trim: 0xe8_dc_c0,
    roof: 0x5a_4a_3c,
    sign: null,
    signBg: '',
    stone: false,
    falseFront: false,
    gable: true,
  },
}
const DEFAULT_PAINT: Paint = PAINT.shed ?? (Object.values(PAINT)[0] as Paint)

const WOOD = 0xb0_8a_60
const DARK_WOOD = 0x6a_4c_34
const WALL_T = 0.5
/** Doorways wider than this get a timber lintel and jambs, not a stretched kit frame. */
const WIDE_DOOR = 3.2
/** Top of a doorway (the kit frame's lintel), m: the wall closes over it. */
const DOOR_TOP = 2.45

/** Roofs are most of what the top-down camera sees: sun-bleached, never near-black. */
function bleach(hex: number): number {
  const ch = (shift: number) => Math.min(255, Math.round(((hex >> shift) & 255) * 1.9 + 40))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export interface TownMaterials {
  wall: MeshStandardMaterial
  stone: MeshStandardMaterial
  roof: MeshStandardMaterial
  wood: MeshStandardMaterial
  windows: MeshStandardMaterial
  signs: MeshStandardMaterial
  /** Wagon bonnets and laundry: woven canvas. */
  cloth: MeshStandardMaterial
  /** Kit doors, windows and rails (the props' trim atlas, with the cutaway). */
  kit: MeshStandardMaterial
}

export interface Town {
  root: Group
  /** Building rects by roof id, for the roof fade. */
  roofs: Building[]
  sun: Vector3
  dispose: () => void
}

function brickTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#8c8478'
    ctx.fillRect(0, 0, 256, 256)
    const rows = 8
    const h = 256 / rows
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? 32 : 0
      for (let x = -64; x < 256; x += 64) {
        const l = 200 + Math.floor(Math.random() * 40)
        ctx.fillStyle = `rgb(${l},${l - 8},${l - 22})`
        ctx.fillRect(x + off + 2, r * h + 2, 60, h - 4)
      }
    }
  }
  const t = new CanvasTexture(c)
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.colorSpace = SRGBColorSpace
  return t
}

function makeMaterials(assets: Assets): TownMaterials {
  const tiled = (t: Texture) => {
    const c = t.clone()
    c.wrapS = RepeatWrapping
    c.wrapT = RepeatWrapping
    c.needsUpdate = true
    return c
  }
  const wall = new MeshStandardMaterial({
    map: tiled(assets.tex.vplanks),
    normalMap: tiled(assets.tex.vplanksN),
    normalScale: new Vector2(0.7, 0.7),
    vertexColors: true,
    roughness: 0.86,
  })
  const stone = new MeshStandardMaterial({
    map: brickTexture(),
    vertexColors: true,
    roughness: 0.92,
  })
  const roof = new MeshStandardMaterial({
    map: tiled(assets.tex.planks),
    normalMap: tiled(assets.tex.planksN),
    vertexColors: true,
    roughness: 0.9,
  })
  const wood = new MeshStandardMaterial({
    map: tiled(assets.tex.planks),
    normalMap: tiled(assets.tex.planksN),
    vertexColors: true,
    roughness: 0.82,
  })
  const windows = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.18,
    metalness: 0.2,
    emissive: 0xff_b0_60,
    emissiveIntensity: 0.12,
  })
  const signs = new MeshStandardMaterial({ roughness: 0.75 })
  // the props' trim-atlas material, with the see-through cut like every town surface
  const kitSrc = propsLibrary()
    ?.scenes.flatMap((sc) => {
      const found: MeshStandardMaterial[] = []
      sc.traverse((o) => {
        const m = (o as Mesh).material as MeshStandardMaterial | undefined
        if (m?.name === 'Kit') {
          found.push(m)
        }
      })
      return found
    })
    .at(0)
  const kit = kitSrc ? kitSrc.clone() : new MeshStandardMaterial({ color: WOOD })
  if (kitSrc) {
    // clone() doesn't carry the shader patch (the NaN-normal guard); cutaway chains onto it
    kit.onBeforeCompile = kitSrc.onBeforeCompile
  }
  cutaway(kit, false)
  cutaway(wall, false)
  cutaway(stone, false)
  roofSkins(roof)
  cutaway(roof, true)
  cutaway(wood, false)
  cutaway(windows, false)
  cutaway(signs, false)
  const cloth = new MeshStandardMaterial({
    map: canvasTexture(),
    vertexColors: true,
    roughness: 0.95,
    side: DoubleSide,
  })
  cutaway(cloth, false)
  return { wall, stone, roof, wood, windows, signs, kit, cloth }
}

/** Woven canvas: a fine warp-and-weft grain with a few darker stains (wagon bonnets, laundry). */
function canvasTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#d8d0c0'
    ctx.fillRect(0, 0, 128, 128)
    for (let i = 0; i < 128; i += 2) {
      ctx.fillStyle = `rgba(90,70,40,${0.05 + ((i * 37) % 7) / 100})`
      ctx.fillRect(i, 0, 1, 128)
      ctx.fillStyle = `rgba(255,250,235,${0.05 + ((i * 53) % 5) / 100})`
      ctx.fillRect(0, i, 128, 1)
    }
    for (const [x, y, r] of [
      [30, 90, 18],
      [96, 40, 12],
    ] as const) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(110,80,40,0.18)')
      g.addColorStop(1, 'rgba(110,80,40,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
  }
  const t = new CanvasTexture(c)
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.colorSpace = SRGBColorSpace
  return t
}

interface Builders {
  wall: GeoBuilder
  stone: GeoBuilder
  cloth: GeoBuilder
  wood: GeoBuilder
  windows: GeoBuilder
  roofs: BufferGeometry[]
  signs: { text: string; bg: string; fg: string; quad: Vector3[] }[]
  extra: BufferGeometry[]
  /** Textured kit pieces (windows, door frames, porch rails), merged at the end. */
  kit: { def: PropDef; at: Matrix4 }[]
}

/** Kit +Z turned to face out of a side. */
const SIDE_RY: Record<Side, number> = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 }

const kitDef = (name: string): PropDef | null => {
  const lib = propsLibrary()
  return lib ? propDef(lib, name, 1, 'y', true) : null
}

/** A kit piece on a building's side, `a` metres along it, its origin on the wall face. */
function onSide(b: Building, side: Side, a: number, y: number, out = 0): Matrix4 {
  const [p] = faceQuad(b, side, a, a, y, y, out)
  return placeMatrix(p?.x ?? 0, y, p?.z ?? 0, SIDE_RY[side])
}

/** The four corners of a vertical quad on side `side` of rect, at heights y0..y1, from a to b along it. */
function faceQuad(
  b: Building,
  side: Side,
  a: number,
  c: number,
  y0: number,
  y1: number,
  out: number,
): Vector3[] {
  const V = (x: number, y: number, z: number) => new Vector3(x, y, z)
  switch (side) {
    case 's':
      return [
        V(b.x + a, y0, b.z + b.d + out),
        V(b.x + c, y0, b.z + b.d + out),
        V(b.x + c, y1, b.z + b.d + out),
        V(b.x + a, y1, b.z + b.d + out),
      ]
    case 'n':
      return [
        V(b.x + c, y0, b.z - out),
        V(b.x + a, y0, b.z - out),
        V(b.x + a, y1, b.z - out),
        V(b.x + c, y1, b.z - out),
      ]
    case 'e':
      return [
        V(b.x + b.w + out, y0, b.z + c),
        V(b.x + b.w + out, y0, b.z + a),
        V(b.x + b.w + out, y1, b.z + a),
        V(b.x + b.w + out, y1, b.z + c),
      ]
    default:
      return [
        V(b.x - out, y0, b.z + a),
        V(b.x - out, y0, b.z + c),
        V(b.x - out, y1, b.z + c),
        V(b.x - out, y1, b.z + a),
      ]
  }
}

const sideLength = (b: Building, side: Side) => (side === 'n' || side === 's' ? b.w : b.d)

/** Shopfronts: big display windows either side of the door on the street face. */
const SHOPFRONT = new Set([
  'saloon',
  'hotel',
  'general_store',
  'stage_line',
  'assay',
  'undertaker',
  'bank',
  'jail',
])

function addWindows(bs: Builders, b: Building, side: Side, floors: number, front: Side): void {
  const len = sideLength(b, side)
  const doors = b.doors.filter((d) => d.side === side)
  const glass = 0x1a_22_2a
  const thin = kitDef('k_window_thin')
  const wide = kitDef('k_window_wide')
  for (let f = 0; f < floors; f++) {
    // sills at a rider's waist on the ground floor (windows sized to a 3.2 m storey, not a doll's)
    const sill = 0.95 + f * 3.2
    const shop = f === 0 && side === front && SHOPFRONT.has(b.kind) && wide
    const step = shop ? 3.8 : 3.0
    const span = shop ? 2.0 : 1.3
    for (let a = 1.2; a + span < len - 0.7; a += step) {
      if (f === 0 && doors.some((d) => a + span > d.at - 0.5 && a < d.at + d.width + 0.5)) {
        continue
      }
      const win = shop ? wide : thin
      if (win) {
        // the kit's sash sits 0.97 m above its origin; scaled up 1.3x to fit the storey
        const s = shop ? 1.35 : 1.3
        const at = onSide(b, side, a + span / 2, sill - 0.97 * s + 0.05)
        at.multiply(new Matrix4().makeScale(s, s, 1))
        bs.kit.push({ def: win, at })
        continue
      }
      const q = faceQuad(b, side, a, a + span, sill, sill + 1.5, 0.04)
      const [p0, p1, p2, p3] = q
      if (p0 && p1 && p2 && p3) {
        bs.windows.quad(p0, p1, p2, p3, glass)
      }
    }
  }
}

/** A dark-wood frame round every doorway, standing on the porch deck where there is one. */
function addDoorFrames(bs: Builders, b: Building, porch: Side | null): void {
  const frame = kitDef('k_doorframe')
  if (!frame) {
    return
  }
  for (const d of b.doors) {
    const y = d.side === porch ? PORCH_DECK : 0
    if (d.width > WIDE_DOOR) {
      // a barn or forge opening: heavy jambs and a lintel beam, both faces
      for (const out of [0.06, -WALL_T - 0.06]) {
        const [q0, q1] = faceQuad(b, d.side, d.at - 0.12, d.at + d.width + 0.12, 0, 1, out)
        if (!(q0 && q1)) {
          continue
        }
        const along = d.side === 'n' || d.side === 's'
        const top = DOOR_TOP + 0.6
        bs.wood.box(
          (q0.x + q1.x) / 2,
          top + 0.15,
          (q0.z + q1.z) / 2,
          along ? d.width + 0.5 : 0.14,
          0.3,
          along ? 0.14 : d.width + 0.5,
          DARK_WOOD,
        )
        for (const a of [d.at - 0.1, d.at + d.width + 0.1]) {
          const [q] = faceQuad(b, d.side, a, a, 0, 1, out)
          if (q) {
            bs.wood.box(
              q.x,
              (y + top) / 2,
              q.z,
              along ? 0.2 : 0.14,
              top - y,
              along ? 0.14 : 0.2,
              DARK_WOOD,
            )
          }
        }
      }
      continue
    }
    const at = onSide(b, d.side, d.at + d.width / 2, y, 0.02)
    // the kit frame is 1.57 m wide: stretch it to the doorway
    at.multiply(new Matrix4().makeScale(Math.max(0.8, (d.width + 0.4) / 1.57), 1, 1))
    bs.kit.push({ def: frame, at })
  }
}

/** The solid stretches of one side between its doorways, as [from, to] metres along it. */
function solidRuns(b: Building, side: Side): [number, number][] {
  const len = sideLength(b, side)
  const gaps = b.doors
    .filter((d) => d.side === side)
    .map((d) => [d.at, d.at + d.width] as const)
    .toSorted((p, q) => p[0] - q[0])
  const out: [number, number][] = []
  let start = 0
  for (const [g0, g1] of gaps) {
    if (g0 > start) {
      out.push([start, g0])
    }
    start = Math.max(start, g1)
  }
  if (start < len) {
    out.push([start, len])
  }
  return out
}

/**
 * What makes a plank wall read as built at eye level: corner boards up every corner, a skirting
 * board along the foot (stopping at doorways), and on two-storey fronts a belt course where the
 * floors meet. Brick buildings get a stone plinth instead of the skirting.
 */
function addFacadeTrim(bs: Builders, b: Building, p: Paint, front: Side): void {
  const decked = PORCHED.has(b.kind) || b.kind === 'depot'
  const h = b.height
  const out = 0.04
  if (!p.stone) {
    for (const [x, z] of [
      [b.x, b.z],
      [b.x + b.w, b.z],
      [b.x, b.z + b.d],
      [b.x + b.w, b.z + b.d],
    ] as const) {
      bs.wood.box(x, (h - 0.3) / 2, z, 0.26, h - 0.3, 0.26, p.trim)
    }
  }
  for (const side of ['n', 's', 'e', 'w'] as const) {
    const along = side === 'n' || side === 's'
    if (decked && side === front) {
      // the porch deck runs along this foot
      continue
    }
    for (const [a0, a1] of solidRuns(b, side)) {
      const [q0, q1] = faceQuad(b, side, a0 + 0.13, a1 - 0.13, 0, 1, out / 2)
      if (!(q0 && q1) || a1 - a0 < 0.4) {
        continue
      }
      const cx = (q0.x + q1.x) / 2
      const cz = (q0.z + q1.z) / 2
      const len = a1 - a0 - 0.26
      const base = p.stone ? bs.stone : bs.wood
      const baseH = p.stone ? 0.45 : 0.24
      base.box(
        cx,
        baseH / 2,
        cz,
        along ? len : out,
        baseH,
        along ? out : len,
        p.stone ? 0x8a_80_74 : DARK_WOOD,
      )
      if (b.floors > 1) {
        bs.wood.box(cx, 3.2, cz, along ? len : out * 1.5, 0.16, along ? out * 1.5 : len, p.trim)
      }
    }
  }
}

/** A closed plank door on the front of a building you can't go into, so it never reads as a box. */
function addClosedDoor(bs: Builders, b: Building, front: Side): void {
  const door = kitDef('k_door_plank')
  const frame = kitDef('k_doorframe')
  if (!(door && frame)) {
    return
  }
  const a = sideLength(b, front) / 2
  bs.kit.push({ def: frame, at: onSide(b, front, a, 0, 0.02) })
  bs.kit.push({ def: door, at: onSide(b, front, a, 0, 0.03) })
}

function addBuilding(bs: Builders, b: Building, layout: TownLayout, id: number): void {
  const p = PAINT[b.kind] ?? DEFAULT_PAINT
  const g = p.stone ? bs.stone : bs.wall
  const front = frontOf(b, layout)
  const h = b.height
  if (b.kind === 'water_tower') {
    addWaterTower(bs, b)
    return
  }
  if (b.kind === 'tower') {
    addClockTower(bs, b, id, layout.buildings)
    return
  }
  for (const w of buildingWalls(b)) {
    g.box(w.x + w.w / 2, h / 2, w.z + w.d / 2, w.w, h, w.d, p.wall)
  }
  // the wall over every doorway (the collision gap runs full height; the opening doesn't)
  for (const d of b.doors) {
    const [q0, q1] = faceQuad(b, d.side, d.at, d.at + d.width, 0, 1, -WALL_T / 2)
    if (q0 && q1) {
      const along = d.side === 'n' || d.side === 's'
      const y0 = DOOR_TOP + (d.width > WIDE_DOOR ? 0.6 : 0)
      g.box(
        (q0.x + q1.x) / 2,
        (y0 + h) / 2,
        (q0.z + q1.z) / 2,
        along ? d.width : WALL_T,
        h - y0,
        along ? WALL_T : d.width,
        p.wall,
      )
    }
  }
  addFacadeTrim(bs, b, p, front)
  if (b.hollow) {
    bs.wood.box(
      b.x + b.w / 2,
      0.015,
      b.z + b.d / 2,
      b.w - WALL_T * 2,
      0.03,
      b.d - WALL_T * 2,
      0x9a_7a_58,
      { skip: ['bottom'] },
    )
  }
  // Trim: a band round the top of the walls, flush on their faces (an open-bottomed shell 6 cm
  // out left a slot of air between the band and the wall)
  const t = 0.06
  for (const [x, z, w, d] of [
    [b.x + b.w / 2, b.z - t / 2, b.w + 2 * t, t],
    [b.x + b.w / 2, b.z + b.d + t / 2, b.w + 2 * t, t],
    [b.x - t / 2, b.z + b.d / 2, t, b.d],
    [b.x + b.w + t / 2, b.z + b.d / 2, t, b.d],
  ] as const) {
    bs.wood.box(x, h - 0.15, z, w, 0.3, d, p.trim, { skip: ['top'] })
  }
  for (const side of ['n', 's', 'e', 'w'] as const) {
    if (b.kind !== 'tower') {
      addWindows(bs, b, side, b.floors, front)
    }
  }
  // Roof: pitched, shingled or tin, with ridge and edge trim (see roofs.ts).
  const skin = roofSkin(b.kind, id)
  const span = front === 'n' || front === 's' ? b.w : b.d
  const bays = p.falseFront && span > 13 ? 2 : 1
  const built = buildRoof(
    p.falseFront
      ? {
          b,
          // the western roof: a low gable running back from the street, under the false front
          axis: front === 'n' || front === 's' ? 'z' : 'x',
          rise: Math.min(1.45, (span / bays / 2) * 0.55),
          bays,
          overhang: 0.35,
          front,
          skin,
          color: skin === 'tin' ? tinColor(b.kind, id) : bleach(p.roof),
          trim: p.trim,
          wallColor: p.wall,
        }
      : {
          b,
          axis: b.w >= b.d ? 'x' : 'z',
          rise: Math.min(b.w, b.d) * 0.32,
          bays: 1,
          overhang: 0.5,
          front: null,
          skin,
          color: skin === 'tin' ? tinColor(b.kind, id) : bleach(p.roof),
          trim: p.trim,
          wallColor: p.wall,
        },
    g,
  )
  const rg = built.geometry
  rg.setAttribute(
    'bid',
    new BufferAttribute(new Float32Array(rg.getAttribute('position').count).fill(id), 1),
  )
  bs.roofs.push(rg)
  addDoorFrames(bs, b, PORCHED.has(b.kind) || b.kind === 'depot' ? front : null)
  if (b.doors.length === 0) {
    addClosedDoor(bs, b, front)
  }
  if (p.falseFront) {
    addFalseFront(bs, b, front, p, built.heightAt)
  }
  if (PORCHED.has(b.kind)) {
    addPorch(bs, b, front)
  }
  if (b.kind === 'depot') {
    addPlatform(bs, b, front)
  }
  if (p.sign && !p.falseFront) {
    const q = faceQuad(
      b,
      front,
      sideLength(b, front) / 2 - 2.2,
      sideLength(b, front) / 2 + 2.2,
      h - 1.3,
      h - 0.3,
      0.06,
    )
    bs.signs.push({ text: p.sign, bg: p.signBg, fg: '#2a1a10', quad: q })
  }
}

function addFalseFront(
  bs: Builders,
  b: Building,
  front: Side,
  p: Paint,
  roofAt: (x: number, z: number) => number,
): void {
  const len = sideLength(b, front)
  const top = b.height + 1.8
  const g = p.stone ? bs.stone : bs.wall
  const [q0, q1, q2, q3] = faceQuad(b, front, 0, len, b.height, top, 0)
  if (!(q0 && q1 && q2 && q3)) {
    return
  }
  const cx = (q0.x + q1.x) / 2
  const cz = (q0.z + q1.z) / 2
  const along = front === 'n' || front === 's'
  g.box(cx, (b.height + top) / 2, cz, along ? len : 0.3, top - b.height, along ? 0.3 : len, p.wall)
  bs.wood.box(cx, top + 0.1, cz, along ? len + 0.3 : 0.5, 0.2, along ? 0.5 : len + 0.3, p.trim)
  if (p.sign) {
    const fg = p.signBg === '#e8c870' || p.signBg.startsWith('#e') ? '#2a1a10' : '#f0e2c0'
    // On the street face; and for fronts facing away from the camera, a board on the roof too.
    bs.signs.push({
      text: p.sign,
      bg: p.signBg,
      fg,
      quad: faceQuad(b, front, len / 2 - 3, len / 2 + 3, b.height + 0.2, top - 0.2, 0.16),
    })
    if (front !== 's') {
      const z = b.z + b.d / 2
      const x0 = b.x + b.w / 2 - 3
      const x1 = b.x + b.w / 2 + 3
      // the board stands on two legs over the pitched roof, clear of every ridge under it
      let roofTop = 0
      for (let x = x0; x <= x1; x += 0.25) {
        roofTop = Math.max(roofTop, roofAt(x, z - 0.2), roofAt(x, z + 0.9))
      }
      roofTop += 0.15
      const y = Math.max(top - 0.4, roofTop + 1.2)
      for (const lx of [x0 + 0.6, x1 - 0.6]) {
        const foot = roofAt(lx, z - 0.27) - 0.05
        bs.wood.box(lx, (foot + y) / 2, z - 0.27, 0.12, y - foot, 0.12, DARK_WOOD)
      }
      bs.signs.push({
        text: p.sign,
        bg: p.signBg,
        fg,
        quad: [
          new Vector3(x0, roofTop, z + 0.9),
          new Vector3(x1, roofTop, z + 0.9),
          new Vector3(x1, y, z - 0.2),
          new Vector3(x0, y, z - 0.2),
        ],
      })
    }
  }
}

function addPorch(bs: Builders, b: Building, front: Side): void {
  const len = sideLength(b, front)
  const depth = PORCH_DEPTH
  const y = PORCH_ROOF
  const [q0, q1] = faceQuad(b, front, 0, len, 0, 1, depth / 2)
  if (!(q0 && q1)) {
    return
  }
  const along = front === 'n' || front === 's'
  const cx = (q0.x + q1.x) / 2
  const cz = (q0.z + q1.z) / 2
  bs.wood.box(cx, PORCH_DECK / 2, cz, along ? len : depth, PORCH_DECK, along ? depth : len, WOOD, {
    skip: ['bottom'],
  })
  bs.wood.box(
    cx,
    y,
    cz,
    along ? len + 0.2 : depth + 0.2,
    0.12,
    along ? depth + 0.2 : len + 0.2,
    DARK_WOOD,
  )
  // a balcony rail along the porch roof (two-storey fronts)
  const rail = kitDef('k_balcony')
  if (rail && b.floors > 1) {
    const n = Math.max(1, Math.floor((len - 0.4) / 2))
    for (let i = 0; i < n; i++) {
      const a = len / 2 - ((n - 1) * 2) / 2 + i * 2
      // the kit rail stands 0.9-1.1 m out from its origin
      bs.kit.push({ def: rail, at: onSide(b, front, a, y + 0.06, depth - 1.1) })
    }
  }
}

function addWaterTower(bs: Builders, b: Building): void {
  const cx = b.x + b.w / 2
  const cz = b.z + b.d / 2
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    // up to the platform's underside, not flush with its top (z-fighting)
    bs.wood.box(cx + dx * 1.86, 3.9, cz + dz * 1.86, 0.26, 7.8, 0.26, DARK_WOOD)
  }
  // the pump house under the tank fills the footprint (what blocks you is what you see)
  bs.wall.box(cx, 1.3, cz, b.w - 0.5, 2.6, b.d - 0.5, 0x6a_4e_36)
  bs.wood.gable(cx, 2.6, cz, b.w - 0.5, b.d - 0.5, 0.6, 'x', 0x5a_4a_3a, 0.12)
  addClosedDoor(bs, { ...b, x: b.x + 0.25, z: b.z + 0.25, w: b.w - 0.5, d: b.d - 0.5 }, 's')
  bs.wood.box(cx, 7.9, cz, 4.4, 0.2, 4.4, DARK_WOOD)
  const tank = new CylinderGeometry(2.1, 2.1, 3.6, 16, 1, false).toNonIndexed()
  tank.translate(cx, 9.8, cz)
  const cap = new CylinderGeometry(0.2, 2.4, 1.4, 16, 1, false).toNonIndexed()
  cap.translate(cx, 12.3, cz)
  for (const [geo, color] of [
    [tank, 0x7a_5a_3c],
    [cap, 0x4a_3a_2c],
  ] as const) {
    const n = geo.getAttribute('position').count
    const c = new Float32Array(n * 3)
    const col = new Vector3(
      ((color >> 16) & 255) / 255,
      ((color >> 8) & 255) / 255,
      (color & 255) / 255,
    )
    for (let i = 0; i < n; i++) {
      c.set([col.x ** 2.2, col.y ** 2.2, col.z ** 2.2], i * 3)
    }
    geo.setAttribute('color', new Float32BufferAttribute(c, 3))
    bs.extra.push(geo)
  }
}

/**
 * The bank's deposit windows: a teller cage at each one on the lobby partition (a counter ledge,
 * brass bars, a lamp) under a DEPOSITS board, so the four spots read from the doorways. The
 * stage-line counter is a cover piece of its own.
 */
function addBank(bs: Builders, layout: TownLayout): void {
  const windows = layout.zones.filter((z) => z.kind === 'bank')
  if (windows.length === 0) {
    return
  }
  // the partition's north face sits 1.5 m behind each window's centre
  const face = (windows[0]?.z ?? 0) + 1.5
  for (const z of windows) {
    // counter front a hand proud of the partition, its ledge at waist height
    bs.wood.box(z.x, 0.52, face - 0.12, 1.9, 1.04, 0.24, 0x4a_2e_1c)
    bs.wood.box(z.x, 1.07, face - 0.16, 2.0, 0.06, 0.32, 0x8a_5a_34)
    // brass bars and an arched brass top
    for (let k = 0; k < 9; k++) {
      bs.windows.box(z.x - 0.8 + k * 0.2, 1.65, face - 0.03, 0.03, 1.1, 0.03, 0xc8_a0_50)
    }
    bs.windows.box(z.x, 2.24, face - 0.03, 1.7, 0.08, 0.05, 0xd8_b0_58)
    bs.windows.box(z.x, 1.12, face - 0.03, 1.7, 0.05, 0.05, 0xd8_b0_58)
    // a green-shaded teller lamp glows on the ledge
    bs.windows.box(z.x + 0.6, 1.16, face - 0.2, 0.22, 0.12, 0.16, 0x2a_6a_3a)
  }
  const x0 = Math.min(...windows.map((z) => z.x)) - 1
  const x1 = Math.max(...windows.map((z) => z.x)) + 1
  bs.signs.push({
    text: 'DEPOSITS',
    bg: '#1e2a22',
    fg: '#e8c870',
    quad: [
      // wound to face north, into the lobby
      new Vector3(x1 - 2, 2.45, face - 0.01),
      new Vector3(x0 + 2, 2.45, face - 0.01),
      new Vector3(x0 + 2, 3.05, face - 0.01),
      new Vector3(x1 - 2, 3.05, face - 0.01),
    ],
  })
}

/** A plank bridge at grade over the dry creek (riders walk at ground level): deck and sills. */
function addCreek(bs: Builders, layout: TownLayout): void {
  const br = layout.creek.bridge
  const deck = PORCH_DECK
  bs.wood.box(br.x + br.w / 2, deck / 2, br.z + br.d / 2, br.w, deck, br.d, WOOD, {
    skip: ['bottom'],
  })
  // stringers along each edge, under the rails
  for (const x of [br.x + 0.25, br.x + br.w - 0.25]) {
    bs.wood.box(x, deck + 0.04, br.z + br.d / 2, 0.5, 0.08, br.d, DARK_WOOD)
  }
}

/** The depot's platform: a plank deck out to the track, with a timber edge. */
function addPlatform(bs: Builders, b: Building, front: Side): void {
  const r = sideStrip(b, front, PLATFORM_DEPTH)
  bs.wood.box(r.x + r.w / 2, PORCH_DECK / 2, r.z + r.d / 2, r.w, PORCH_DECK, r.d, WOOD, {
    skip: ['bottom'],
  })
  const along = front === 'n' || front === 's'
  const [edge] = faceQuad(b, front, sideLength(b, front) / 2, 0, 0, 1, PLATFORM_DEPTH - 0.1)
  if (edge) {
    bs.wood.box(
      edge.x,
      PORCH_DECK + 0.04,
      edge.z,
      along ? r.w : 0.2,
      0.08,
      along ? 0.2 : r.d,
      0xd8_c0_40,
    )
  }
}

/**
 * Life on the street that never blocks: a lantern under the porch roof by every front door, and
 * laundry strung high across the back alleys (above any rider's head).
 */
function addDecor(bs: Builders, layout: TownLayout, lanterns: Matrix4[]): void {
  for (const b of layout.buildings) {
    if (!PORCHED.has(b.kind)) {
      continue
    }
    const front = frontOf(b, layout)
    for (const d of b.doors.filter((dd) => dd.side === front)) {
      const [q] = faceQuad(b, front, d.at + d.width + 0.6, 0, 0, 1, 0.5)
      if (q) {
        // hung from the porch roof's underside on a short chain
        bs.wood.box(q.x, PORCH_ROOF - 0.06 - 0.15, q.z, 0.02, 0.3, 0.02, 0x2a_2a_2a)
        lanterns.push(placeMatrix(q.x, PORCH_ROOF - 0.06 - 0.3 - 0.4, q.z, 0, 1))
      }
      // a shingle sign hung from the porch beam, edge-on to the street, readable walking past
      const paint = PAINT[b.kind]
      const [s0] = faceQuad(b, front, d.at - 0.9, 0, 0, 1, PORCH_DEPTH - 0.45)
      if (paint?.sign && s0) {
        const along = front === 'n' || front === 's'
        const half = 0.55
        const y0 = 2.35
        const y1 = 2.8
        const fg = paint.signBg.startsWith('#e') ? '#2a1a10' : '#f0e2c0'
        for (const k of [1, -1]) {
          const ax = along ? 0 : k * half
          const az = along ? k * half : 0
          const nx = along ? k * 0.012 : 0
          const nz = along ? 0 : k * 0.012
          bs.signs.push({
            text: paint.sign,
            bg: paint.signBg,
            fg,
            quad: [
              new Vector3(s0.x - ax + nx, y0, s0.z - az + nz),
              new Vector3(s0.x + ax + nx, y0, s0.z + az + nz),
              new Vector3(s0.x + ax + nx, y1, s0.z + az + nz),
              new Vector3(s0.x - ax + nx, y1, s0.z - az + nz),
            ],
          })
        }
        bs.wood.box(
          s0.x,
          (y1 + PORCH_ROOF - 0.06) / 2,
          s0.z,
          0.02,
          PORCH_ROOF - 0.06 - y1,
          0.02,
          0x2a_2a_2a,
        )
      }
    }
  }
  // laundry lines across the alleys between neighbours (east wall of one, west wall of the next)
  const lines: [string, string, number][] = [
    ['livery', 'saloon', 46],
    ['hotel', 'assay', 50],
    ['bank', 'undertaker', 82],
    ['general_store', 'bank', 86],
  ]
  const shirt = [0xc8_c0_b0, 0x8a_9a_b8, 0xb8_5a_4a, 0xe0_d8_c0, 0x6a_7a_5a]
  for (const [wId, eId, z] of lines) {
    const w = layout.buildings.find((x) => x.id === wId)
    const e = layout.buildings.find((x) => x.id === eId)
    if (!(w && e)) {
      continue
    }
    const x0 = w.x + w.w
    const x1 = e.x
    const y = 3.2
    bs.wood.box((x0 + x1) / 2, y, z, x1 - x0, 0.02, 0.02, 0x3a_34_2a)
    let k = 0
    for (let x = x0 + 0.35; x < x1 - 0.5; x += 0.85) {
      const wdt = 0.45 + ((k * 7) % 3) * 0.1
      const h = 0.5 + ((k * 5) % 3) * 0.12
      const V = (xx: number, yy: number) => new Vector3(xx, yy, z)
      bs.cloth.quad(
        V(x, y - h),
        V(x + wdt, y - h),
        V(x + wdt, y),
        V(x, y),
        shirt[k % shirt.length] ?? 0xc8_c0_b0,
      )
      k++
    }
  }
}

function signMesh(signs: Builders['signs'], mat: MeshStandardMaterial): Mesh | null {
  if (signs.length === 0) {
    return null
  }
  const unique = [...new Map(signs.map((s) => [s.text, s])).values()]
  const { tex, rows } = signAtlas(unique.map((s) => ({ text: s.text, bg: s.bg, fg: s.fg })))
  mat.map = tex
  const pos: number[] = []
  const uv: number[] = []
  const nor: number[] = []
  for (const s of signs) {
    const row = unique.findIndex((u) => u.text === s.text)
    const v0 = 1 - (row + 1) / rows
    const v1 = 1 - row / rows
    const [a, b, c, d] = s.quad
    if (!(a && b && c && d)) {
      continue
    }
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(d, a)).normalize()
    for (const [p, u, v] of [
      [a, 0, v0],
      [b, 1, v0],
      [c, 1, v1],
      [a, 0, v0],
      [c, 1, v1],
      [d, 0, v1],
    ] as const) {
      pos.push(p.x, p.y, p.z)
      uv.push(u, v)
      nor.push(n.x, n.y, n.z)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  geo.computeBoundingSphere()
  return new Mesh(geo, mat)
}

export function buildTown(layout: TownLayout, assets: Assets, sun: Vector3): Town {
  const root = new Group()
  root.name = 'town'
  const mats = makeMaterials(assets)
  const bs: Builders = {
    wall: new GeoBuilder(2.4),
    stone: new GeoBuilder(2),
    wood: new GeoBuilder(2),
    cloth: new GeoBuilder(1.5),
    windows: new GeoBuilder(1),
    roofs: [],
    signs: [],
    extra: [],
    kit: [],
  }
  const roofs: Building[] = []
  for (const b of layout.buildings) {
    addBuilding(bs, b, layout, roofs.length)
    roofs.push(b)
  }
  addBank(bs, layout)
  addCreek(bs, layout)
  const lanterns: Matrix4[] = []
  addDecor(bs, layout, lanterns)
  const lantern = propDef(assets.props, 'lantern', 0.4, 'y')
  if (lantern && lanterns.length > 0) {
    instance(lantern, lanterns, root, false)
  }
  const deckRects = decks(layout)
  dressCover(
    layout,
    assets.props,
    root,
    bs,
    (x, z) => floorHeight(layout, deckRects, x, z),
    PORCH_ROOF - 0.06,
  )
  const mask = bakeGroundMask(layout, sun)
  const ground = groundMesh(layout, { map: assets.tex.ground, normal: assets.tex.groundN }, mask)
  root.add(ground)
  // the land past the playable edge (cut bank, bench, hills, mesas, scrub) in the ground's material
  const land = new Mesh(outskirtsGeometry(layout, OUTSKIRTS_SEED, sun), ground.material)
  land.name = 'outskirts'
  land.receiveShadow = true
  root.add(land)
  const add = (geo: BufferGeometry | null, mat: MeshStandardMaterial, name: string) => {
    if (!geo || geo.getAttribute('position').count === 0) {
      return
    }
    const m = new Mesh(geo, mat)
    m.name = name
    m.receiveShadow = true
    m.matrixAutoUpdate = false
    root.add(m)
  }
  add(bs.wall.empty ? null : bs.wall.build(), mats.wall, 'walls')
  add(bs.stone.empty ? null : bs.stone.build(), mats.stone, 'stone')
  const wood = bs.wood.build()
  add(bs.extra.length > 0 ? mergeGeometries([wood, ...bs.extra]) : wood, mats.wood, 'wood')
  add(bs.windows.empty ? null : bs.windows.build(), mats.windows, 'windows')
  add(bs.cloth.empty ? null : bs.cloth.build(), mats.cloth, 'canvas')
  for (const r of bs.roofs) {
    if (!r.getAttribute('rk')) {
      // the clock tower's roofs: plain boards
      const n = r.getAttribute('position').count
      r.setAttribute('rk', new BufferAttribute(new Float32Array(n).fill(RK_PLAIN), 1))
    }
  }
  add(bs.roofs.length > 0 ? mergeGeometries(bs.roofs) : null, mats.roof, 'roofs')
  if (bs.kit.length > 0) {
    for (const m of mergePlaced(
      bs.kit,
      root,
      new Map([
        ['Kit', mats.kit],
        ['KitGlass', mats.windows],
      ]),
      false,
    )) {
      m.name = 'kit'
    }
  }
  const signs = signMesh(bs.signs, mats.signs)
  if (signs) {
    signs.matrixAutoUpdate = false
    root.add(signs)
  }
  root.add(waterMesh(layout))
  root.updateMatrixWorld(true)
  // Static: never recompose these matrices again.
  root.traverse((o) => {
    o.matrixAutoUpdate = false
    o.matrixWorldAutoUpdate = false
  })
  return {
    root,
    roofs,
    sun,
    dispose: () => {
      root.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose()
        }
      })
      for (const m of Object.values(mats)) {
        m.dispose()
      }
      mask.dispose()
    },
  }
}

function waterMesh(layout: TownLayout): Mesh {
  const c = layout.creek
  const g = new GeoBuilder(4)
  const V = (x: number, z: number) => new Vector3(x, 0.04, z)
  // A dry creek: a thin trickle wandering down the bed, narrowing to nothing in places, so it
  // reads as water over sand from above (not a painted stripe).
  const mid = c.z + c.d / 2 + 0.6
  const step = 1.5
  for (let x = c.x - 30; x < c.x + c.w + 30; x += step) {
    const at = (t: number) => mid + Math.sin(t * 0.21) * 0.9 + Math.sin(t * 0.057) * 1.4
    const half = (t: number) =>
      Math.max(0, 0.05 + 0.2 * Math.sin(t * 0.13) * Math.sin(t * 0.31 + 1))
    const [z0, z1, h0, h1] = [at(x), at(x + step), half(x), half(x + step)]
    if (h0 + h1 > 0.02) {
      g.quad(V(x, z0 + h0), V(x + step, z1 + h1), V(x + step, z1 - h1), V(x, z0 - h0), 0x4a_44_3a)
    }
  }
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.12,
    metalness: 0.05,
    envMapIntensity: 1.2,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  })
  const m = new Mesh(g.build(), mat)
  m.name = 'creek'
  m.receiveShadow = true
  return m
}
