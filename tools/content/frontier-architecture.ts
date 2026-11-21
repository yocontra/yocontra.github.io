import type { Node } from '@gltf-transform/core'
import type { Building, Side, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import {
  frontOf,
  PORCH_DEPTH,
  PORCH_ROOF,
  PORCH_ROOF_T,
  PORCHED,
  sideStrip,
} from '../../src/experiments/out-west/ffa/sim/porches.ts'
import { ROOF_DECK_Y } from '../../src/experiments/out-west/ffa/sim/roofwalks.ts'
import type { FrontierPlan } from './frontier-authoring.ts'
import {
  type compileFrontierCollision,
  FALSE_FRONT_RISE,
  falseFrontSide,
  fenceSpans,
  roofMesh,
} from './frontier-collision.ts'
import type { FrontierGeometry, Placement, Rgb } from './frontier-geometry.ts'
import { LABELS, SHORT_LABELS, SIGN_ROWS } from './frontier-materials.ts'
import { MOUNT_IRON_TINT } from './frontier-mounts.ts'
import { buildingDoors } from './frontier-openings.ts'
import { pitchedRoof } from './frontier-roofs.ts'
import { saloonFloor } from './frontier-saloon.ts'
import {
  BANK_SIGN_SIZE,
  FACADE_SIGN_HEIGHT,
  facadeSignWidth,
  signUvRect,
} from './frontier-sign-layout.ts'
import { weatheredEave } from './frontier-weathering.ts'
export function authorDecksAndRoofs(
  g: FrontierGeometry,
  ground: Node,
  layout: TownLayout,
  collision: ReturnType<typeof compileFrontierCollision>,
) {
  for (const box of collision.boxes) {
    if (!box.id.startsWith('deck:')) {
      continue
    }
    const [x, y, z] = box.center
    const [w, h, d] = box.halfExtents
    g.box(
      ground,
      'floor',
      { x: x - w, z: z - d, w: w * 2, d: d * 2, y0: y - h, top: y + h },
      [0.72, 0.61, 0.44],
    )
  }
  const roofs = new Map(layout.buildings.map((building) => [`roof:${building.id}`, building]))
  for (const mesh of collision.meshes) {
    const building = roofs.get(mesh.id)
    if (building?.roof) {
      const visible = roofMesh(building, 'render')
      if (visible) {
        pitchedRoof(g, ground, visible, building)
      }
    } else if (mesh.id.startsWith('stair:')) {
      g.surface(ground, 'wood', mesh, [0.75, 0.63, 0.45])
    }
  }
}

export function buildingDetails(
  g: FrontierGeometry,
  plan: FrontierPlan,
  building: Building,
  root: Node,
) {
  const { x, z, w, d, height } = building
  const paint = plan.style.buildingPaint[building.id] ?? plan.style.woodTint
  const trim: Rgb = [0.82, 0.72, 0.53]
  if (building.hollow) {
    // A real 3 cm floor, with matching native support, and a ceiling below the roof.
    if (building.id === 'saloon') {
      saloonFloor(g, root, building, plan.layout.cover)
    } else {
      g.box(root, 'floor', { x, z, w, d, y0: 0, top: 0.03 }, [0.83, 0.72, 0.55])
    }
    g.box(root, 'wood', { x, z, w, d, y0: height - 0.14, top: height }, [0.6, 0.49, 0.35])
  }
  // The corner timbers, foundation and eaves define scale without extra materials.
  for (const dx of [0, w - 0.15]) {
    for (const dz of [0, d - 0.15]) {
      g.box(root, 'wood', { x: x + dx, z: z + dz, w: 0.15, d: 0.15, y0: 0, top: height }, trim)
    }
  }
  for (const side of ['n', 's', 'e', 'w'] as const) {
    const strip = sideStrip(building, side, 0.13)
    g.box(
      root,
      'wood',
      { ...strip, y0: height - 0.21, top: height + 0.04 },
      weatheredEave(building, side, trim),
    )
  }
  falseFrontJoinery(g, root, building, trim)
  const front = frontOf(building, plan.layout)
  porchSupports(g, root, building, { front, paint })
  buildingSign(g, root, { building, front, layout: plan.layout })
  hangingSign(g, root, building, front)
  if (building.kind === 'church' || building.kind === 'tower') {
    const centerX = x + w / 2
    const centerZ = z + d / 2
    if (building.kind === 'tower') {
      g.box(
        root,
        'wood',
        { x: centerX - 0.1, z: centerZ - 0.1, w: 0.2, d: 0.2, y0: height, top: height + 2.1 },
        trim,
      )
      g.box(
        root,
        'wood',
        {
          x: centerX - 0.65,
          z: centerZ - 0.1,
          w: 1.3,
          d: 0.2,
          y0: height + 1.15,
          top: height + 1.35,
        },
        trim,
      )
    }
  }
  buildingDoors(g, root, building)
}

function falseFrontJoinery(g: FrontierGeometry, root: Node, building: Building, trim: Rgb) {
  const front = falseFrontSide(building)
  if (!front) {
    return
  }
  const alongX = front === 'n' || front === 's'
  const span = alongX ? building.w : building.d
  const top = building.height + FALSE_FRONT_RISE
  const bandDepth = 0.13
  const piece = (
    [start, width]: [start: number, width: number],
    [y0, y1]: [bottom: number, top: number],
    depth: number,
    tint: Rgb = trim,
  ) => {
    const footprint = alongX
      ? { ...building, x: building.x + start, w: width }
      : { ...building, z: building.z + start, d: width }
    // Seat each molding 12 mm into the false front so the join stays closed at a shallow angle.
    const seat = sideStrip(footprint, front, depth)
    const inset = 0.012
    if (alongX) {
      seat.d += inset
      seat.z -= front === 's' ? inset : 0
    } else {
      seat.w += inset
      seat.x -= front === 'e' ? inset : 0
    }
    g.box(root, 'wood', { ...seat, y0, top: y1 }, tint)
  }
  // The lower band, projecting bed molding and drip cap read separately against the sky.
  piece([0, span], [top - 0.29, top - 0.11], bandDepth)
  piece([-0.055, span + 0.11], [top - 0.16, top - 0.055], 0.21)
  piece([-0.1, span + 0.2], [top - 0.08, top], 0.27, [0.66, 0.54, 0.39])
  for (const end of [0.14, span - 0.38]) {
    piece([end, 0.24], [building.height + 0.035, top - 0.315], 0.084)
    piece([end - 0.05, 0.34], [top - 0.4, top - 0.275], 0.16)
  }
  const bays = Math.ceil((span - 1.5) / 1.14)
  for (let index = 0; index <= bays; index++) {
    const at = 0.75 + ((span - 1.5) * index) / bays
    piece([at - 0.065, 0.13], [top - 0.46, top - 0.27], 0.17)
    piece([at - 0.088, 0.176], [top - 0.37, top - 0.245], 0.192)
  }
}

function buildingSign(
  g: FrontierGeometry,
  root: Node,
  { building, front, layout }: { building: Building; front: Side; layout: TownLayout },
) {
  const { x, z, w, d, height } = building
  const label = LABELS[building.id]
  if (!label) {
    return
  }
  {
    const index = Object.keys(LABELS).indexOf(building.id)
    const mount = porchSignMount(layout, building)
    if (mount) {
      mountPorchSign(g, root, index, mount)
      return
    }
    const fascia = porchFasciaSignMount(building, front)
    if (fascia) {
      mountPorchSign(g, root, index, fascia)
      braceFasciaSign(g, root, building, fascia)
      return
    }
    const alongX = front === 'n' || front === 's'
    const span = (front === 'n' || front === 'e' ? -1 : 1) * facadeSignWidth(building, front, label)
    const cx = x + w / 2
    const cz = z + d / 2
    const upperFascia = building.floors > 1
    const depth = upperFascia ? 0.025 : 0.14
    const at = { s: z + d + depth, n: z - depth, e: x + w + depth, w: x - depth }[front]
    const bottom = upperFascia ? height - 1.18 : Math.min(height - 1.15, 3.4)
    const points = alongX
      ? [
          [cx - span / 2, bottom, at],
          [cx + span / 2, bottom, at],
          [cx + span / 2, bottom + FACADE_SIGN_HEIGHT, at],
          [cx - span / 2, bottom + FACADE_SIGN_HEIGHT, at],
        ]
      : [
          [at, bottom, cz - span / 2],
          [at, bottom, cz + span / 2],
          [at, bottom + FACADE_SIGN_HEIGHT, cz + span / 2],
          [at, bottom + FACADE_SIGN_HEIGHT, cz - span / 2],
        ]
    signQuad(g, root, index, points)
  }
}

type PorchSignMount = Required<Placement> & {
  facing: -1 | 1
  fixingRows: number[]
  inset: number
}

/** These two one-storey façades have a walkable porch and a street-facing rail. */
export function porchSignMount(layout: TownLayout, building: Building): PorchSignMount | undefined {
  if (building.id !== 'general_store' && building.id !== 'jail') {
    return
  }
  const rail = layout.cover.find(
    (cover) =>
      cover.kind === 'fence' &&
      cover.y0 === ROOF_DECK_Y &&
      cover.x >= building.x &&
      cover.x + cover.w <= building.x + building.w &&
      cover.z >= building.z - PORCH_DEPTH &&
      cover.z + cover.d <= building.z &&
      cover.w > building.w * 0.9,
  )
  const rails = rail && fenceSpans(rail).filter(({ id }) => id.startsWith('rail:'))
  const lower = rails?.[0]
  const upper = rails?.[1]
  if (!(lower && upper)) {
    throw new Error(`Missing street-facing porch rails for ${building.id}`)
  }
  const width = facadeSignWidth(building, 'n', LABELS[building.id] ?? '')
  const top = upper.y1 + 0.08
  return {
    x: building.x + (building.w - width) / 2,
    z: lower.z - 0.06,
    w: width,
    d: 0.06,
    y0: top - FACADE_SIGN_HEIGHT,
    top,
    facing: -1,
    inset: 0.1,
    fixingRows: [lower, upper].map(({ y0, y1 }) => (y0 + y1) / 2),
  }
}

const FASCIA_SIGN_IDS = new Set(['assay', 'smithy', 'stage_line', 'undertaker'])
const FASCIA_DEPTH = 0.05

export function porchFasciaSignMount(building: Building, front: Side): PorchSignMount | undefined {
  if (!FASCIA_SIGN_IDS.has(building.id)) {
    return
  }
  if (front !== 'n' && front !== 's') {
    throw new Error(`Unsupported porch fascia for ${building.id}`)
  }
  const strip = sideStrip(building, front, PORCH_DEPTH)
  const facing = front === 'n' ? -1 : 1
  const edge = front === 'n' ? strip.z : strip.z + strip.d
  const back = edge + facing * FASCIA_DEPTH
  const w = facadeSignWidth(building, front, LABELS[building.id] ?? '')
  const d = 0.06
  const y0 = PORCH_ROOF - PORCH_ROOF_T / 2
  return {
    x: building.x + (building.w - w) / 2,
    z: facing === -1 ? back - d : back,
    w,
    d,
    y0,
    top: y0 + FACADE_SIGN_HEIGHT,
    facing,
    inset: 0.42,
    fixingRows: [PORCH_ROOF, PORCH_ROOF + 0.55],
  }
}

function braceFasciaSign(
  g: FrontierGeometry,
  root: Node,
  building: Building,
  mount: PorchSignMount,
) {
  const { x, z, w, d, y0, facing, inset } = mount
  const back = facing === -1 ? z + d : z
  // The fascia caps the plank ends. Its inner half overlaps the actual roof edge.
  g.box(
    root,
    'wood',
    {
      x: building.x,
      z: facing === -1 ? back : back - 2 * FASCIA_DEPTH,
      w: building.w,
      d: 2 * FASCIA_DEPTH,
      y0: y0 - 0.02,
      top: PORCH_ROOF + PORCH_ROOF_T / 2 + 0.012,
    },
    [0.52, 0.42, 0.31],
  )
  const base = PORCH_ROOF + PORCH_ROOF_T / 2
  const towardWall = -facing
  for (const center of [x + inset, x + w - inset]) {
    const positions = [center - 0.04, center + 0.04].flatMap((edge) => [
      edge,
      base,
      back,
      edge,
      base,
      back + towardWall * 0.43,
      edge,
      PORCH_ROOF + 0.62,
      back,
    ])
    const indices = [0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0]
    if (facing === 1) {
      indices.reverse()
    }
    g.surface(
      root,
      'wood',
      { id: `sign-brace:${building.id}`, positions, indices },
      [0.49, 0.39, 0.27],
    )
  }
}

function mountPorchSign(g: FrontierGeometry, root: Node, row: number, mount: PorchSignMount) {
  const { x, z, w, d, y0, top, facing, inset, fixingRows } = mount
  g.box(root, 'wood', mount, [0.51, 0.4, 0.28])
  const face = facing === -1 ? z - 0.001 : z + d + 0.001
  const [left, right] = facing === -1 ? [x + w, x] : [x, x + w]
  signQuad(g, root, row, [
    [left, y0, face],
    [right, y0, face],
    [right, top, face],
    [left, top, face],
  ])
  for (const y of fixingRows) {
    for (const pin of [x + inset, x + w - inset]) {
      g.box(
        root,
        'iron',
        {
          x: pin - 0.016,
          z: facing === -1 ? face - 0.008 : face - 0.002,
          w: 0.032,
          d: 0.01,
          y0: y - 0.016,
          top: y + 0.016,
        },
        MOUNT_IRON_TINT,
      )
    }
  }
}

function porchSupports(
  g: FrontierGeometry,
  root: Node,
  building: Building,
  options: { front: Side; paint: Rgb },
) {
  const { x, z, w, d } = building
  const { front, paint } = options
  if (PORCHED.has(building.kind)) {
    const strip = sideStrip(building, front, PORCH_DEPTH)
    const horizontal = front === 'n' || front === 's'
    const length = horizontal ? w : d
    for (let along = 0.25; along < length; along += 4.5) {
      const px = horizontal ? x + along : strip.x + (front === 'e' ? 1.7 : 0.3)
      const pz = horizontal ? strip.z + (front === 's' ? 1.7 : 0.3) : z + along
      g.box(
        root,
        'wood',
        { x: px - 0.08, z: pz - 0.08, w: 0.16, d: 0.16, y0: 0.06, top: 3.1 },
        paint,
      )
    }
  }
}

export function signQuad(g: FrontierGeometry, root: Node, index: number, points: number[][]): void {
  const { u0, u1, v0, v1 } = signUvRect(index)
  g.quad(root, 'sign', points, {
    uvs: [
      [u0, v1],
      [u1, v1],
      [u1, v0],
      [u0, v0],
    ],
  })
}
function hangingSign(g: FrontierGeometry, root: Node, b: Building, front: Side) {
  if (!(Object.hasOwn(SHORT_LABELS, b.id) && ['n', 's'].includes(front))) {
    return
  }
  const x = b.x + 0.75
  const z = front === 's' ? b.z + b.d + 0.22 : b.z - 1.72
  const row = Object.keys(LABELS).length + Object.keys(SHORT_LABELS).indexOf(b.id)
  bladeSignFaces(g, root, row, { x, z, bottom: 2.25 })
  if (b.id === 'undertaker') {
    undertakerAlleyBlade(g, root, row, b)
  }
}

function bladeSignFaces(
  g: FrontierGeometry,
  root: Node,
  row: number,
  { x, z, bottom }: { x: number; z: number; bottom: number },
) {
  const top = bottom + 0.7
  signQuad(g, root, row, [
    [x - 0.041, bottom, z],
    [x - 0.041, bottom, z + 1.5],
    [x - 0.041, top, z + 1.5],
    [x - 0.041, top, z],
  ])
  signQuad(g, root, row, [
    [x + 0.041, bottom, z + 1.5],
    [x + 0.041, bottom, z],
    [x + 0.041, top, z],
    [x + 0.041, top, z + 1.5],
  ])
}

function undertakerAlleyBlade(g: FrontierGeometry, root: Node, row: number, b: Building) {
  const x = b.x + b.w - 2.7
  const edge = b.z - PORCH_DEPTH
  const back = edge - FASCIA_DEPTH
  const bottom = PORCH_ROOF + PORCH_ROOF_T / 2
  // The perpendicular board sits above the alley. Both straps tie it to a roof post.
  g.box(
    root,
    'wood',
    { x: x - 0.04, z: back - 1.5, w: 0.08, d: 1.5, y0: bottom, top: bottom + 0.7 },
    [0.51, 0.4, 0.28],
  )
  bladeSignFaces(g, root, row, { x, z: back - 1.5, bottom })
  g.box(
    root,
    'wood',
    { x: x - 0.055, z: edge + 0.14, w: 0.11, d: 0.11, y0: bottom, top: bottom + 0.72 },
    [0.49, 0.39, 0.27],
  )
  for (const y of [bottom + 0.12, bottom + 0.58]) {
    g.box(
      root,
      'iron',
      { x: x - 0.023, z: back - 0.08, w: 0.046, d: 0.29, y0: y - 0.018, top: y + 0.018 },
      MOUNT_IRON_TINT,
    )
  }
}
export function bankServiceSigns(g: FrontierGeometry, root: Node, layout: FrontierPlan['layout']) {
  const halfWidth = BANK_SIGN_SIZE.width / 2
  const top = 2.7 + BANK_SIGN_SIZE.height
  for (const [index, zone] of layout.zones.filter((v) => v.kind === 'bank').entries()) {
    signQuad(g, root, SIGN_ROWS.length - 4 + index, [
      [zone.x + halfWidth, 2.7, zone.z + 0.94],
      [zone.x - halfWidth, 2.7, zone.z + 0.94],
      [zone.x - halfWidth, top, zone.z + 0.94],
      [zone.x + halfWidth, top, zone.z + 0.94],
    ])
  }
}
