// biome-ignore-all lint/style/noExcessiveLinesPerFile: one town builder; the paint table and the per-feature builders share private helpers
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: array lookups narrowed by the layout's types
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
import { mergePlaced, type PropDef, placeMatrix, propDef, propsLibrary } from '../../scene/props.ts'
import { signAtlas } from '../../scene/textures.ts'
import { type Building, buildingWalls, type Side, type TownLayout } from '../sim/layout.ts'
import { cutaway } from './cutaway.ts'
import { dressCover } from './dressing.ts'
import { bakeGroundMask, groundMesh } from './ground.ts'

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
}
const DEFAULT_PAINT: Paint = PAINT.shed ?? (Object.values(PAINT)[0] as Paint)

const WOOD = 0xb0_8a_60
const DARK_WOOD = 0x6a_4c_34
const WALL_T = 0.5
/** Top of a porch's floor boards. */
const PORCH_DECK = 0.06
/** Buildings with a porch along their front. */
const PORCHED = new Set(['saloon', 'hotel', 'general_store', 'stage_line'])

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
  cutaway(roof, true)
  cutaway(wood, false)
  cutaway(windows, false)
  cutaway(signs, false)
  return { wall, stone, roof, wood, windows, signs, kit }
}

/** Which side of a building faces the nearest street (its front). */
function frontOf(b: Building, layout: TownLayout): Side {
  const doorSide = b.doors[0]?.side
  const cx = b.x + b.w / 2
  const cz = b.z + b.d / 2
  let best: Side = doorSide ?? 's'
  let bestD = Number.POSITIVE_INFINITY
  for (const s of layout.streets) {
    const sx = Math.max(s.x, Math.min(cx, s.x + s.w))
    const sz = Math.max(s.z, Math.min(cz, s.z + s.d))
    const dx = sx - cx
    const dz = sz - cz
    const d = Math.hypot(dx, dz)
    if (d < bestD) {
      bestD = d
      if (Math.abs(dx) / b.w > Math.abs(dz) / b.d) {
        best = dx > 0 ? 'e' : 'w'
      } else {
        best = dz > 0 ? 's' : 'n'
      }
    }
  }
  return best
}

interface Builders {
  wall: GeoBuilder
  stone: GeoBuilder
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

function addWindows(bs: Builders, b: Building, side: Side, floors: number): void {
  const len = sideLength(b, side)
  const doors = b.doors.filter((d) => d.side === side)
  const glass = 0x1a_22_2a
  const win = kitDef('k_window_thin')
  for (let f = 0; f < floors; f++) {
    const y0 = 1.1 + f * 3.2
    for (let a = 1.6; a + 1.3 < len - 0.8; a += 3.4) {
      if (f === 0 && doors.some((d) => a + 1.3 > d.at - 0.4 && a < d.at + d.width + 0.4)) {
        continue
      }
      if (win) {
        // a framed sash window with a sill (the kit's sits 0.97 m above its origin)
        bs.kit.push({ def: win, at: onSide(b, side, a + 0.65, y0 - 0.97 + 0.05) })
        continue
      }
      const q = faceQuad(b, side, a, a + 1.3, y0, y0 + 1.5, 0.04)
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
    const at = onSide(b, d.side, d.at + d.width / 2, d.side === porch ? PORCH_DECK : 0, 0.02)
    // the kit frame is 1.57 m wide: stretch it to the doorway
    at.multiply(new Matrix4().makeScale(Math.max(0.8, (d.width + 0.4) / 1.57), 1, 1))
    bs.kit.push({ def: frame, at })
  }
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
  for (const w of buildingWalls(b)) {
    g.box(w.x + w.w / 2, h / 2, w.z + w.d / 2, w.w, h, w.d, p.wall)
  }
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
      addWindows(bs, b, side, b.floors)
    }
  }
  // Roof.
  const roof = new GeoBuilder(2)
  const rc = bleach(p.roof)
  if (b.kind === 'tower') {
    roof.box(b.x + b.w / 2, h + 0.2, b.z + b.d / 2, b.w + 0.6, 0.4, b.d + 0.6, rc)
    roof.pyramid(b.x + b.w / 2, h + 0.4, b.z + b.d / 2, b.w + 0.4, 5, rc)
  } else if (p.gable) {
    const axis = b.w >= b.d ? 'x' : 'z'
    roof.gable(b.x + b.w / 2, h, b.z + b.d / 2, b.w, b.d, Math.min(b.w, b.d) * 0.32, axis, rc, 0.5)
  } else {
    // its underside 5 mm over the wall top, off the false front's bottom face (they z-fought)
    roof.box(b.x + b.w / 2, h + 0.1225, b.z + b.d / 2, b.w + 0.5, 0.235, b.d + 0.5, rc)
  }
  const rg = roof.build()
  rg.setAttribute(
    'bid',
    new BufferAttribute(new Float32Array(rg.getAttribute('position').count).fill(id), 1),
  )
  bs.roofs.push(rg)
  if (b.kind !== 'tower') {
    addDoorFrames(bs, b, PORCHED.has(b.kind) ? front : null)
  }
  if (p.falseFront) {
    addFalseFront(bs, b, front, p)
  }
  if (PORCHED.has(b.kind)) {
    addPorch(bs, b, front)
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

function addFalseFront(bs: Builders, b: Building, front: Side, p: Paint): void {
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
      quad: faceQuad(b, front, len / 2 - 3, len / 2 + 3, b.height + 0.2, top - 0.2, 0.2),
    })
    if (front !== 's') {
      const y = top - 0.4
      const z = b.z + b.d / 2
      const x0 = b.x + b.w / 2 - 3
      const x1 = b.x + b.w / 2 + 3
      // the board leans back on two legs, its foot on the flat roof (it hovered 6 cm over it)
      const roofTop = b.height + 0.24
      for (const lx of [x0 + 0.6, x1 - 0.6]) {
        bs.wood.box(lx, (roofTop + y) / 2, z - 0.27, 0.12, y - roofTop, 0.12, DARK_WOOD)
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
  const depth = 2
  const y = 3.1
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
  for (let a = 0.2; a <= len; a += len / Math.max(2, Math.round(len / 3.5))) {
    const [p0] = faceQuad(b, front, a, a, 0, 1, depth - 0.15)
    if (p0) {
      bs.wood.box(p0.x, y / 2, p0.z, 0.16, y, 0.16, DARK_WOOD)
    }
  }
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
    bs.wood.box(cx + dx * 1.6, 3.9, cz + dz * 1.6, 0.25, 7.8, 0.25, DARK_WOOD)
  }
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

function addBank(bs: Builders, layout: TownLayout): void {
  for (const z of layout.zones) {
    if (z.kind === 'bank') {
      // A brass teller grille on the partition behind each deposit window.
      bs.windows.box(z.x, 1.6, z.z + 1.25, 1.6, 1.4, 0.08, 0xc8_a0_50)
      bs.wood.box(z.x, 0.55, z.z + 1.05, 2, 1.1, 0.4, DARK_WOOD)
    } else {
      bs.wood.box(z.x, 0.55, z.z + 1.6, 3, 1.1, 0.5, DARK_WOOD)
    }
  }
}

function addCreek(bs: Builders, layout: TownLayout): void {
  const c = layout.creek
  const br = c.bridge
  const deck = 0.475
  bs.wood.box(br.x + br.w / 2, deck - 0.125, br.z + br.d / 2, br.w, 0.25, br.d + 1, WOOD)
  // sills on the creek bed hold the deck up (it hung 22 cm over the sand on nothing)
  for (const z of [4, br.z + br.d / 2, br.z + br.d + 0.35]) {
    bs.wood.box(br.x + br.w / 2, (deck - 0.25) / 2, z, br.w + 0.3, deck - 0.25, 0.3, DARK_WOOD)
  }
  // the rails stand on the deck (they floated 7.5 cm above it)
  for (const x of [br.x + 0.2, br.x + br.w - 0.2]) {
    bs.wood.box(x, deck + 0.45, br.z + br.d / 2, 0.15, 0.9, br.d + 1, DARK_WOOD)
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
  dressCover(layout, assets.props, root, bs.wood)
  const mask = bakeGroundMask(layout, sun)
  root.add(groundMesh(layout, { map: assets.tex.ground, normal: assets.tex.groundN }, mask))
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
  root.add(bluffMesh(layout, assets))
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
      Math.max(0, 0.18 + 0.32 * Math.sin(t * 0.13) * Math.sin(t * 0.31 + 1))
    const [z0, z1, h0, h1] = [at(x), at(x + step), half(x), half(x + step)]
    if (h0 + h1 > 0.02) {
      g.quad(V(x, z0 + h0), V(x + step, z1 + h1), V(x + step, z1 - h1), V(x, z0 - h0), 0x55_66_62)
    }
  }
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.12,
    metalness: 0.05,
    envMapIntensity: 1.2,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  })
  const m = new Mesh(g.build(), mat)
  m.name = 'creek'
  m.receiveShadow = true
  return m
}

function bluffMesh(layout: TownLayout, assets: Assets): Mesh {
  const c = layout.creek
  const g = new GeoBuilder(5)
  const V = (x: number, y: number, z: number) => new Vector3(x, y, z)
  const x0 = -200
  const x1 = layout.size + 200
  const col = 0xc8_a8_80
  g.quad(
    V(x0, 0, c.z + 0.4),
    V(x1, 0, c.z + 0.4),
    V(x1, 3.2, c.z - 1.6),
    V(x0, 3.2, c.z - 1.6),
    col,
  )
  g.quad(V(x0, 3.2, c.z - 1.6), V(x1, 3.2, c.z - 1.6), V(x1, 3.4, -200), V(x0, 3.4, -200), col)
  const map = assets.tex.ground.clone()
  map.needsUpdate = true
  const mat = new MeshStandardMaterial({ map, vertexColors: true, roughness: 0.95 })
  const m = new Mesh(g.build(), mat)
  m.name = 'bluff'
  m.receiveShadow = true
  return m
}
