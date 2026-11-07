/** Western tailoring for the shared rig: tucked shirts and plain riding boots, without armor. */
import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, boneKey, bounds, nearestWeights, shell } from './fit.ts'
import { GeoBuilder } from './geo.ts'
import { creaseNormals } from './normals.ts'
import { SLOT } from './roles.ts'
import { retainHands } from './western-hands.ts'
import { tailorShirt } from './western-shirt.ts'

const LEATHER = new Color(0x2e_1f_18)
const SOLE = new Color(0x15_12_10)

/** A stitched leather boot measured from the original foot, retaining the original bone weights. */
function ridingBoot(body: Body, side: number): Piece | null {
  const samples = body.samples.filter((s) => s.slot === SLOT.Boots && s.p.x * side > 0)
  if (samples.length === 0) {
    return null
  }
  const b = bounds(samples)
  const width = b.max.x - b.min.x
  const length = b.max.z - b.min.z
  const ankle = body.bones.find((bone) => boneKey(bone.name) === `Foot${side > 0 ? 'L' : 'R'}`)
  const center = ankle?.getWorldPosition(new Vector3()) ?? b.center.clone().setY(b.min.y + 0.12)
  const cx = b.center.x
  const cz = center.z
  const bottom = b.min.y
  const height = Math.max(0.2, b.max.y - bottom)
  const toeZ = b.center.z
  const rings = [
    [bottom, width * 0.48, length * 0.49, toeZ],
    [bottom + 0.047, width * 0.5, length * 0.5, toeZ],
    [bottom + 0.082, width * 0.48, length * 0.46, toeZ],
    [bottom + 0.13, width * 0.42, length * 0.32, cz + 0.018],
    [bottom + 0.17, width * 0.37, length * 0.23, cz],
    [bottom + height * 0.56, width * 0.4, length * 0.24, cz],
    [bottom + height * 0.82, width * 0.47, length * 0.27, cz],
    [b.max.y, width * 0.49, length * 0.28, cz],
  ] as const
  const segs = 16
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const index: number[] = []
  for (const [r, [y, rx, rz, z]] of rings.entries()) {
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2
      // The shallow V at the front and back is the cut of a riding boot, not an armor cuff.
      const scallop = r === rings.length - 1 ? 0.025 * Math.abs(Math.cos(a)) : 0
      const toe = r < 4 ? 1 - 0.22 * Math.max(0, Math.cos(a)) : 1
      positions.push(cx + Math.sin(a) * rx * toe, y - scallop, z + Math.cos(a) * rz)
      const shade = r === 0 || r === 1 ? SOLE : LEATHER
      colors.push(shade.r, shade.g, shade.b)
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
  positions.push(cx, bottom, toeZ)
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
  return {
    geo,
    name: 'RidingBoot',
    slot: SLOT.Boots,
    roughness: 0.85,
    rim: 0.8,
    swatch: 'leather',
    weights: nearestWeights(body, samples),
  }
}

/** A folded shirt collar and button placket; measured on the same body as the waistcoat. */
function shirtDetails(
  body: Body,
  shirt: Piece | undefined,
  surface?: (x: number, y: number) => number,
  neckline?: { x: number; y: number; z: number },
): Piece[] {
  if (!shirt) {
    return []
  }
  const neckBone = body.bones
    .find((bone) => boneKey(bone.name) === 'Neck')
    ?.getWorldPosition(new Vector3())
  const neck = body.samples.filter(
    (s) =>
      s.slot === SLOT.Skin &&
      (!neckBone ||
        (Math.abs(s.p.x - neckBone.x) < 0.085 &&
          Math.abs(s.p.z - neckBone.z) < 0.085 &&
          s.p.y > neckBone.y - 0.065 &&
          s.p.y < neckBone.y + 0.02)),
  )
  const chest = body.samples.filter((s) =>
    ['Chest', 'Torso', 'Abdomen', 'Hips', 'Neck'].includes(s.bone),
  )
  if (neck.length === 0 || chest.length === 0) {
    return []
  }
  const nb = bounds(neck)
  const cx = neckline?.x ?? nb.center.x
  const cz = neckline?.z ?? nb.center.z
  const yTop = neckline?.y ?? nb.max.y - 0.005
  const yBot = Math.max(nb.min.y, yTop - 0.035)
  const colors = shirt.geo.getAttribute('color')
  const color = new Color().setRGB(colors.getX(0), colors.getY(0), colors.getZ(0))
  const ring = shell({
    samples: neck,
    cx,
    cz,
    yTop,
    yBot,
    rings: 2,
    segs: 20,
    margin: 0.008,
    band: 0.02,
    color,
  })
  const cloth = new GeoBuilder(0.25)
  const zAt = (x: number, y: number): number => {
    let z = cz + 0.08
    for (const s of chest) {
      if (Math.abs(s.p.x - x) < 0.035 && Math.abs(s.p.y - y) < 0.04) {
        z = Math.max(z, s.p.z)
      }
    }
    return surface ? surface(x, y) + 0.003 : z + 0.008
  }
  for (const side of [-1, 1]) {
    const a = new Vector3(cx + side * 0.015, yBot + 0.018, zAt(cx, yBot) + 0.008)
    const b = new Vector3(cx + side * 0.062, yBot + 0.005, zAt(cx + side * 0.06, yBot))
    const c = new Vector3(cx + side * 0.04, yBot - 0.053, zAt(cx + side * 0.04, yBot - 0.05))
    const d = new Vector3(cx + side * 0.012, yBot - 0.015, zAt(cx, yBot - 0.02) + 0.01)
    if (side > 0) {
      cloth.quad(a, d, c, b, color.getHex())
    } else {
      cloth.quad(a, b, c, d, color.getHex())
    }
  }
  const buttons = new GeoBuilder()
  const hips =
    body.bones.find((bone) => boneKey(bone.name) === 'Hips')?.getWorldPosition(new Vector3()).y ??
    yBot - 0.4
  const placketTop = yBot - 0.065
  const placketBottom = hips + 0.035
  for (let row = 0; row < 20; row++) {
    const y0 = placketTop + ((placketBottom - placketTop) * row) / 20
    const y1 = placketTop + ((placketBottom - placketTop) * (row + 1)) / 20
    cloth.quad(
      new Vector3(cx - 0.011, y0, zAt(cx - 0.011, y0)),
      new Vector3(cx - 0.011, y1, zAt(cx - 0.011, y1)),
      new Vector3(cx + 0.011, y1, zAt(cx + 0.011, y1)),
      new Vector3(cx + 0.011, y0, zAt(cx + 0.011, y0)),
      color.clone().multiplyScalar(0.94).getHex(),
    )
  }
  for (let y = yBot - 0.09; y > hips + 0.055; y -= 0.065) {
    buttons.box(cx, y, zAt(cx, y) + 0.001, 0.0065, 0.0065, 0.003, 0x67_5c_48)
  }
  const weights = nearestWeights(body, chest)
  return [
    {
      geo: ring,
      slot: SLOT.Shirt,
      name: 'ShirtCollar',
      paletteSlot: shirt.paletteSlot,
      swatch: 'linen',
      roughness: 0.9,
      rim: 0.7,
      weights,
    },
    {
      geo: cloth.build(),
      name: 'ShirtPlacket',
      paletteSlot: shirt.paletteSlot,
      slot: SLOT.Shirt,
      swatch: 'linen',
      roughness: 0.9,
      rim: 0.7,
      weights,
    },
    {
      geo: buttons.build(),
      name: 'ShirtButtons',
      slot: SLOT.Shirt,
      swatch: 'plain',
      roughness: 0.55,
      rim: 0.9,
      weights,
    },
  ]
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
