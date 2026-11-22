/** Full-height shopfront joinery for the unsigned row on Main Street. */
import type { Document, Material, Node, vec3 } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'

type Point = readonly [z: number, y: number]
type Color = readonly [red: number, green: number, blue: number]
type Crown = 'gable' | 'stepped' | 'segment' | 'cornice'
interface Shop {
  name: string
  side: -1 | 1
  start: number
  end: number
  roof: number
  crown: Crown
  field: Color
  trim: Color
  inset: Color
}

const SHOPS: Shop[] = [
  {
    name: 'Harness shop board-and-batten',
    side: -1,
    start: -50,
    end: -38,
    roof: 7.2,
    crown: 'gable',
    field: [0.13, 0.22, 0.17],
    trim: [0.33, 0.3, 0.22],
    inset: [0.07, 0.13, 0.1],
  },
  {
    name: 'Provisioner stepped false front',
    side: -1,
    start: -36,
    end: -26,
    roof: 7.8,
    crown: 'stepped',
    field: [0.32, 0.21, 0.12],
    trim: [0.44, 0.36, 0.24],
    inset: [0.2, 0.085, 0.045],
  },
  {
    name: 'Carpenter segmental pediment',
    side: -1,
    start: -24.5,
    end: -14.5,
    roof: 7.6,
    crown: 'segment',
    field: [0.208, 0.105, 0.079],
    trim: [0.4, 0.3, 0.21],
    inset: [0.11, 0.06, 0.047],
  },
  {
    name: 'Laundry blue-grey cornice',
    side: -1,
    start: -11.5,
    end: -1.5,
    roof: 7.4,
    crown: 'cornice',
    field: [0.15, 0.22, 0.25],
    trim: [0.41, 0.4, 0.34],
    inset: [0.09, 0.13, 0.16],
  },
]

function panelGeometry(shop: Shop) {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const point = (face: Point, depth: number): vec3 => [
    shop.side * (11.15 - depth),
    face[1],
    face[0],
  ]
  const quad = (corners: readonly vec3[], tint: Color, verticalGrain = false) => {
    const [a, b, c] = corners
    if (!(a && b && c)) {
      throw new Error('Shopfront faces require a direction')
    }
    const normal = new Vec3()
      .cross(
        new Vec3().fromArray(b).sub(new Vec3().fromArray(a)),
        new Vec3().fromArray(c).sub(new Vec3().fromArray(a)),
      )
      .normalize()
    const at = positions.length / 3
    for (const [x, y, z] of corners) {
      positions.push(x, y, z)
      normals.push(normal.x, normal.y, normal.z)
      const stain = 0.88 + 0.08 * Math.sin(z * 3.271) + 0.04 * Math.sin(z * 1.35 + y * 1.83)
      colors.push(...tint.map((channel) => channel * stain))
      const across = Math.abs(normal.z) > 0.6 ? x : z
      uvs.push(
        verticalGrain ? y * 0.68 : across * 0.68,
        verticalGrain ? across * 0.68 : (Math.abs(normal.y) > 0.6 ? x : y) * 0.68,
      )
    }
    indices.push(at, at + 1, at + 2)
    if (corners.length === 4) {
      indices.push(at, at + 2, at + 3)
    }
  }
  const outward = (corners: vec3[]) => (shop.side < 0 ? corners.reverse() : corners)
  const block = (
    outline: readonly Point[],
    [near, far]: readonly [number, number],
    tint: Color,
    verticalGrain = false,
  ) => {
    const front = outline.map((p) => point(p, far))
    const rear = outline.map((p) => point(p, near))
    for (const [face, reverse] of [
      [front, false],
      [rear, true],
    ] as const) {
      const first = face[0]
      if (!first) {
        throw new Error('Shopfront face needs a closed outline')
      }
      for (let i = 1; i < face.length - 1; i++) {
        const a = face[i]
        const b = face[i + 1]
        if (a && b) {
          quad(outward(reverse ? [first, b, a] : [first, a, b]), tint, verticalGrain)
        }
      }
    }
    for (let i = 0; i < front.length; i++) {
      const next = (i + 1) % front.length
      const a = front[i]
      const b = front[next]
      const c = rear[next]
      const d = rear[i]
      if (a && b && c && d) {
        quad(outward([b, a, d, c]), tint)
      }
    }
  }
  const rail = (
    [a, b]: readonly [number, number],
    [low, high]: readonly [number, number],
    depth: number,
    finish: { tint: Color; verticalGrain?: boolean },
  ) =>
    block(
      [
        [a, low],
        [b, low],
        [b, high],
        [a, high],
      ],
      // Seat the joinery 20 mm inside the native wall, including at the recessed edges.
      [-0.02, depth],
      finish.tint,
      finish.verticalGrain,
    )
  return { positions, normals, colors, uvs, indices, block, rail }
}

function crown(shop: Shop, g: ReturnType<typeof panelGeometry>, low: number, high: number) {
  const { roof: y, field, trim } = shop
  const center = (low + high) / 2
  const segment = Array.from({ length: 13 }, (_, index): Point => {
    const t = (Math.PI * index) / 12
    return [center + 2.48 * Math.cos(t), y + 0.13 + 0.58 * Math.sin(t)]
  })
  const silhouette: Record<Crown, Point[]> = {
    gable: [
      [low + 0.3, y - 0.08],
      [high - 0.3, y - 0.08],
      [center, y + 0.88],
    ],
    stepped: [
      [center - 2.2, y - 0.09],
      [center + 2.2, y - 0.09],
      [center + 2.2, y + 0.43],
      [center - 2.2, y + 0.43],
    ],
    segment,
    cornice: [
      [low - 0.2, y - 0.04],
      [high + 0.2, y - 0.04],
      [high + 0.2, y + 0.31],
      [low - 0.2, y + 0.31],
    ],
  }
  g.block(silhouette[shop.crown], [-0.63, 0.2], trim)
  if (shop.crown === 'stepped') {
    g.rail([center - 1.18, center + 1.18], [y + 0.37, y + 0.68], 0.235, { tint: field })
    g.rail([center - 1.29, center + 1.29], [y + 0.65, y + 0.76], 0.28, { tint: trim })
  } else if (shop.crown === 'segment') {
    g.rail([center - 2.55, center + 2.55], [y - 0.02, y + 0.14], 0.255, { tint: trim })
  } else if (shop.crown === 'cornice') {
    g.rail([low - 0.16, high + 0.16], [y + 0.1, y + 0.24], 0.26, { tint: field })
    for (let z = low + 0.33; z < high - 0.2; z += 0.49) {
      g.rail([z, z + 0.19], [y - 0.06, y + 0.1], 0.29, { tint: trim })
    }
  }
}

function openings(shop: Shop, g: ReturnType<typeof panelGeometry>, low: number, high: number) {
  const center = (low + high) / 2
  const { roof, inset, trim } = shop
  // Closed attic louvres sit over the blank upper walls. Existing door and window openings stay free.
  const vents = {
    gable: [[center, 2.05]],
    stepped: [
      [center - 2.35, 0.56],
      [center, 1.05],
      [center + 2.35, 0.56],
    ],
    segment: [[center, 1.45]],
    cornice: [
      [center - 1.62, 0.72],
      [center + 1.62, 0.72],
    ],
  }[shop.crown]
  for (const [z = 0, span = 0] of vents) {
    const bottom = roof - 2.48
    const top = roof - 0.99
    g.rail([z - span, z + span], [bottom, top], 0.217, { tint: inset })
    for (let y = bottom + 0.12; y < top - 0.12; y += 0.13) {
      const near = z - span + 0.12
      const far = z + span - 0.12
      const slat: Point[] = [
        [near, y],
        [far, y],
        [far, y + 0.075],
        [near, y + 0.075],
      ]
      g.block(slat, [0.21, 0.24], y > top - 0.6 ? trim : inset)
    }
    g.rail([z - span - 0.13, z - span + 0.06], [bottom - 0.14, top + 0.11], 0.25, {
      tint: trim,
      verticalGrain: true,
    })
    g.rail([z + span - 0.06, z + span + 0.13], [bottom - 0.14, top + 0.11], 0.25, {
      tint: trim,
      verticalGrain: true,
    })
    g.rail([z - span - 0.18, z + span + 0.18], [bottom - 0.14, bottom + 0.014], 0.31, {
      tint: trim,
    })
    g.rail([z - span - 0.18, z + span + 0.18], [top - 0.02, top + 0.15], 0.29, { tint: trim })
  }
}

/** Different window surrounds read at eye level. The frames sit outside the original glass. */
function setWindowJoinery(shop: Shop, g: ReturnType<typeof panelGeometry>) {
  const [start, end] = [shop.start, shop.end]
  const windows = [start + 1.8, end - 1.8]
  for (const z of windows) {
    if (shop.crown === 'cornice') {
      g.rail([z - 0.7, z + 0.7], [1.26, 1.4], 0.29, { tint: shop.trim })
      continue
    }
    g.rail([z - 0.69, z + 0.69], [2.76, 2.91], 0.28, { tint: shop.trim })
    if (shop.crown !== 'segment') {
      g.rail([z - 0.58, z + 0.58], [1.27, 1.42], 0.23, { tint: shop.trim })
      continue
    }
    for (const side of [-1, 1]) {
      const outer = z + side * 1.05
      const inner = z + side * 0.59
      const west = Math.min(outer, inner)
      const east = Math.max(outer, inner)
      g.rail([west, east], [1.44, 2.72], 0.21, { tint: shop.field, verticalGrain: true })
      for (const height of [1.59, 2.43]) {
        g.rail([west, east], [height, height + 0.074], 0.24, { tint: shop.trim })
      }
      const rise = side < 0 ? 0.75 : -0.75
      const height = side < 0 ? 1.66 : 2.41
      g.block(
        [
          [west, height],
          [east, height + rise],
          [east, height + rise + 0.062],
          [west, height + 0.062],
        ],
        [0.205, 0.242],
        shop.trim,
      )
    }
  }
}

function installShop(doc: Document, street: Node, material: Material, shop: Shop): void {
  const { start, end, roof, trim, field } = shop
  const g = panelGeometry(shop)
  const low = start + 0.23
  const high = end - 0.23
  const base = 3.28
  if (shop.crown === 'gable' || shop.crown === 'segment') {
    for (let z = low; z < high; z += 0.44) {
      const shade = 0.83 + 0.17 * (0.5 + 0.5 * Math.sin(z * 11.23))
      const paint = field.map((channel) => channel * shade) as [number, number, number]
      g.rail([z, Math.min(high, z + 0.431)], [base, roof - 0.14], 0.126, {
        tint: paint,
        verticalGrain: true,
      })
      g.rail([z + 0.005, Math.min(high, z + 0.064)], [base, roof - 0.14], 0.173, {
        tint: field,
        verticalGrain: true,
      })
    }
  } else {
    for (let y = base; y < roof - 0.14; y += 0.235) {
      const wash = 0.92 + 0.08 * Math.sin(y * 27.17)
      const paint = field.map((channel) => channel * wash) as [number, number, number]
      g.rail([low, high], [y, Math.min(roof - 0.14, y + 0.232)], 0.128, { tint: paint })
    }
  }
  g.rail([low - 0.04, high + 0.04], [base, base + 0.16], 0.24, { tint: trim })
  g.rail([low, high], [roof - 0.38, roof - 0.12], 0.22, { tint: trim })
  openings(shop, g, low, high)
  setWindowJoinery(shop, g)
  crown(shop, g, low, high)
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const stream = (type: 'VEC2' | 'VEC3', values: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer)
  const primitive = doc
    .createPrimitive()
    .setMaterial(material)
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(g.indices)).setBuffer(buffer),
    )
    .setAttribute('POSITION', stream('VEC3', g.positions))
    .setAttribute('NORMAL', stream('VEC3', g.normals))
    .setAttribute('TEXCOORD_0', stream('VEC2', g.uvs))
    .setAttribute('COLOR_0', stream('VEC3', g.colors))
  const mesh = doc.createMesh(shop.name).addPrimitive(primitive)
  street.addChild(doc.createNode(shop.name).setMesh(mesh))
}

export function installDuelShopfronts(doc: Document): void {
  const nodes = doc.getRoot().listNodes()
  const street = nodes.find((node) => node.getName() === 'street')
  const donor = nodes
    .find((node) => node.getName() === 'trim-8')
    ?.getMesh()
    ?.listPrimitives()[0]
    ?.getMaterial()
  if (!(street && donor)) {
    throw new Error('Cannot fit the Main Street storefronts without the timber donor')
  }
  const material = donor.clone().setName('Sanded and painted Main Street joinery')
  material.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(null).setRoughnessFactor(0.94)
  for (const shop of SHOPS) {
    installShop(doc, street, material, shop)
  }
}
