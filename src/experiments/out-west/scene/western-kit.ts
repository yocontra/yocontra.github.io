/** Western tailoring for the shared rig: tucked shirts and plain riding boots, without armor. */
import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Piece } from './bake.ts'
import { type Body, boneKey, bounds, nearestWeights } from './fit.ts'
import { GeoBuilder } from './geo.ts'
import { creaseNormals } from './normals.ts'
import { SLOT } from './roles.ts'
import { bindTrouserYoke } from './trouser-yoke.ts'
import { retainHands } from './western-hands.ts'
import { tailorShirt } from './western-shirt.ts'
import { shirtDetails } from './western-shirt-details.ts'

const LEATHER = new Color(0x2e_1f_18)
const SOLE = new Color(0x15_12_10)

const bonePoint = (body: Body, key: string) =>
  body.bones.find((bone) => boneKey(bone.name) === key)?.getWorldPosition(new Vector3())

/** A stitched leather boot measured from the original foot, retaining the original bone weights. */
function ridingBoot(body: Body, side: number): Piece | null {
  const samples = body.samples.filter((s) => s.slot === SLOT.Boots && s.p.x * side > 0)
  if (samples.length === 0) {
    return null
  }
  const b = bounds(samples)
  const foot = body.bones.find((bone) => boneKey(bone.name) === `Foot${side > 0 ? 'L' : 'R'}`)
  const shin = body.bones.find((bone) => boneKey(bone.name) === `LowerLeg${side > 0 ? 'L' : 'R'}`)
  const width = b.max.x - b.min.x
  const length = b.max.z - b.min.z
  const center =
    bonePoint(body, `Foot${side > 0 ? 'L' : 'R'}`) ?? b.center.clone().setY(b.min.y + 0.12)
  const calf = bonePoint(body, `LowerLeg${side > 0 ? 'L' : 'R'}`) ?? center
  const top = Math.min(b.max.y, calf.y - 0.035)
  const cx = b.center.x
  const cz = center.z
  const bottom = b.min.y
  const height = Math.max(0.2, top - bottom)
  const toeZ = b.center.z
  const rings = [
    [bottom + 0.014, width * 0.45, length * 0.47, toeZ],
    [bottom + 0.033, width * 0.455, length * 0.47, toeZ],
    [bottom + 0.043, width * 0.46, length * 0.475, toeZ],
    [bottom + 0.061, width * 0.44, length * 0.46, toeZ],
    [bottom + 0.09, width * 0.42, length * 0.39, toeZ - 0.006],
    [bottom + 0.13, width * 0.35, length * 0.29, cz + 0.012],
    [bottom + 0.17, width * 0.31, length * 0.22, cz],
    [bottom + height * 0.56, width * 0.33, length * 0.22, cz],
    [bottom + height * 0.82, width * 0.36, length * 0.23, cz],
    [top - 0.007, width * 0.37, length * 0.235, cz],
    [top, width * 0.375, length * 0.24, cz],
  ] as const
  const geo = bootSurface(rings, { cx, calf, center, bottom, toeZ })
  const heel = new GeoBuilder(0.1)
  heel.box(
    cx,
    bottom + 0.024,
    toeZ - length * 0.32,
    width * 0.7,
    0.048,
    length * 0.27,
    SOLE.getHex(),
  )
  const cuffAxis = Math.max(0, Math.min(1, (top - center.y) / Math.max(0.1, calf.y - center.y)))
  const calfX = center.x + (calf.x - center.x) * cuffAxis
  const calfZ = center.z + (calf.z - center.z) * cuffAxis
  heel.box(calfX + side * width * 0.365, top - 0.005, calfZ, 0.009, 0.032, 0.023, LEATHER.getHex())
  bootStitches(heel, { cx, calf, center, bottom, top, width, length, cz })
  const heelGeo = heel.build()
  heelGeo.setIndex(Array.from({ length: heelGeo.getAttribute('position').count }, (_, i) => i))
  const finished = mergeGeometries([geo, heelGeo])
  if (!finished) {
    throw new Error('Riding boot surfaces could not merge')
  }
  geo.dispose()
  heelGeo.dispose()
  return {
    geo: finished,
    name: 'RidingBoot',
    slot: SLOT.Boots,
    roughness: 0.88,
    roughnessAt: Float32Array.from({ length: finished.getAttribute('position').count }, (_, i) => {
      const y = finished.getAttribute('position').getY(i) - bottom
      return y > 0.18 ? 0.98 : 0.82
    }),
    rim: 0.8,
    swatch: 'leather',
    // A leather sole/vamp moves as a shoe, not as a soft blend inherited from the old armor.
    // Only the shaft grades into the shin across the ankle.
    weights:
      foot && shin
        ? (point) => {
            const t = Math.max(
              0,
              Math.min(
                1,
                (point.y - bottom - 0.17) / Math.max(0.04, center.y + 0.11 - bottom - 0.17),
              ),
            )
            const amount = t * t * (3 - 2 * t)
            return [
              [foot, 1 - amount],
              [shin, amount],
            ]
          }
        : nearestWeights(body, samples),
  }
}

function tuckShirt(piece: Piece, hips: Vector3): void {
  const pos = piece.geo.getAttribute('position')
  // A long fantasy/peasant hem becomes a tucked shirt; the waistcoat and gunbelt sit over it.
  const waist = hips.y - 0.015
  const tucked = new Uint8Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < waist) {
      tucked[i] = 1
      pos.setY(i, waist)
      pos.setX(i, Math.max(hips.x - 0.15, Math.min(hips.x + 0.15, pos.getX(i))))
      pos.setZ(i, Math.max(hips.z - 0.105, Math.min(hips.z + 0.105, pos.getZ(i))))
    }
  }
  const idx = piece.geo.getIndex()
  if (idx) {
    const keep: number[] = []
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i)
      const b = idx.getX(i + 1)
      const c = idx.getX(i + 2)
      if (!(tucked[a] && tucked[b] && tucked[c])) {
        keep.push(a, b, c)
      }
    }
    piece.geo.setIndex(keep)
  }
  piece.geo.computeVertexNormals()
}

/** Run on root-space base pieces before fitted garments and the gunbelt are baked. */
export function westernKit(pieces: Piece[], body: Body, shirtCut: 'straight' | 'fitted'): Piece[] {
  const hips = body.bones
    .find((bone) => boneKey(bone.name) === 'Hips')
    ?.getWorldPosition(new Vector3())
  const out: Piece[] = []
  const sourceShirt = pieces.find((piece) => piece.slot === SLOT.Shirt)
  const tailored = sourceShirt ? tailorShirt(body, sourceShirt, shirtCut === 'fitted') : null
  for (const piece of pieces) {
    if (tailored && (piece === sourceShirt || piece.slot === SLOT.Sleeves)) {
      out.push(...retainHands(piece, body))
      piece.geo.dispose()
      if (piece === sourceShirt) {
        out.push(tailored.piece, tailored.sleeves)
      }
      continue
    }
    if (
      piece.slot === SLOT.Bracer ||
      piece.slot === SLOT.Pauldron ||
      piece.slot === SLOT.Belt ||
      piece.slot === SLOT.Boots
    ) {
      piece.geo.dispose()
      continue
    }
    if (piece.slot === SLOT.Shirt && hips) {
      tuckShirt(piece, hips)
    }
    if (piece.slot === SLOT.Pants) {
      bindTrouserYoke(piece, body)
    }
    if (piece.slot === SLOT.Shirt || piece.slot === SLOT.Sleeves) {
      // Replace the source's leather wraps and laced tunic texture with plain woven cotton.
      piece.swatch = 'linen'
      piece.lum = 0.398
      piece.roughness = 0.9
      piece.rim = 0.8
    }
    out.push(piece)
  }
  const shirt = out.find((piece) => piece.slot === SLOT.Shirt)
  out.push(...shirtDetails(body, shirt, tailored?.surface, tailored?.neckline))
  for (const side of [-1, 1]) {
    const boot = ridingBoot(body, side)
    if (boot) {
      out.push(boot)
    }
  }
  return out
}

function bootSurface(
  rings: readonly (readonly [number, number, number, number])[],
  frame: { cx: number; calf: Vector3; center: Vector3; bottom: number; toeZ: number },
): BufferGeometry {
  const { cx, calf, center, bottom, toeZ } = frame
  const segs = 20
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const index: number[] = []
  for (const [r, [y, rx, rz, z]] of rings.entries()) {
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2
      // The shallow V at the front and back is the cut of a riding boot, not an armor cuff.
      const scallop = r === rings.length - 1 ? 0.025 * Math.abs(Math.cos(a)) : 0
      const toe = r < 6 ? 1 - 0.1 * Math.max(0, Math.cos(a)) : 1
      const shaft = Math.max(0, Math.min(1, (y - center.y) / Math.max(0.1, calf.y - center.y)))
      const x = cx + (calf.x - center.x) * shaft
      const seam = Math.max(0, Math.min(1, (y - bottom - 0.13) / 0.08))
      const blend = seam * seam * (3 - 2 * seam)
      const shaftX = x + (center.x + (calf.x - center.x) * shaft - x) * blend
      const shaftZ = z + (center.z + (calf.z - center.z) * shaft - z) * blend
      const arch = r < 2 ? 0.024 * Math.max(0, -Math.cos(a)) : 0
      positions.push(shaftX + Math.sin(a) * rx * toe, y - scallop + arch, shaftZ + Math.cos(a) * rz)
      const shade = r < 2 ? SOLE : LEATHER
      const wear = r === 2 ? 1.55 : 1 + 0.07 * Math.cos(a * 2)
      colors.push(shade.r * wear, shade.g * wear, shade.b * wear)
      uvs.push(j / segs, r / (rings.length - 1))
      if (r > 0 && j < segs) {
        const v = r * (segs + 1) + j
        const p = v - segs - 1
        index.push(p, p + 1, v, p + 1, v + 1, v)
      }
    }
  }
  // Close the sole: the underside is visible during a stride, a fall and a death pose.
  const cap = positions.length / 3
  positions.push(cx, bottom + 0.025, toeZ)
  colors.push(SOLE.r, SOLE.g, SOLE.b)
  uvs.push(0.5, 0)
  for (let j = 0; j < segs; j++) {
    index.push(cap, j + 1, j)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geo.setIndex(index)
  geo.computeVertexNormals()
  creaseNormals(geo, 65)
  return geo
}

function bootStitches(
  geo: GeoBuilder,
  o: {
    cx: number
    calf: Vector3
    center: Vector3
    bottom: number
    top: number
    width: number
    length: number
    cz: number
  },
): void {
  const lo = o.bottom + 0.21
  const hi = o.top - 0.035
  const at = (t: number, side: number, edge: number) => {
    const y = lo + (hi - lo) * t
    const height = Math.max(0, Math.min(1, (y - o.bottom - 0.17) / (o.top - o.bottom - 0.17)))
    const rx = o.width * (0.31 + 0.065 * height)
    const rz = o.length * (0.22 + 0.02 * height)
    const x = side * (0.007 + 0.018 * Math.sin(t * Math.PI) * Math.sin(t * Math.PI * 2)) + edge
    const axis = Math.max(0, Math.min(1, (y - o.center.y) / Math.max(0.1, o.calf.y - o.center.y)))
    return new Vector3(
      o.center.x + (o.calf.x - o.center.x) * axis + x,
      y,
      o.center.z +
        (o.calf.z - o.center.z) * axis +
        rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2)) +
        0.0008,
    )
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 20; i++) {
      const a = i / 20
      const b = (i + 1) / 20
      geo.quad(
        at(a, side, -0.000_65),
        at(a, side, 0.000_65),
        at(b, side, 0.000_65),
        at(b, side, -0.000_65),
        0x4f_3a_2b,
      )
    }
  }
}
