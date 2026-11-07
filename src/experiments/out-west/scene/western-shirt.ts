/** A continuous cotton shirt replaces the ranger tunic, with an open neck and a tucked waist. */
import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, boneKey, type WeightFn } from './fit.ts'
import { type Cuff, compactGarment } from './garment-mesh.ts'
import { SLOT } from './roles.ts'
import { sewSleeve, sleeveUv } from './western-sleeves.ts'
import { outlineFront, waistOutline } from './western-waist.ts'
import { shirtSkin, shirtTorsoWeights } from './western-weights.ts'

export interface TailoredShirt {
  piece: Piece
  sleeves: Piece
  surface: (x: number, y: number) => number
  neckline: { x: number; z: number; y: number }
}
interface ShirtProfile {
  rx: number
  rz: number
  cx: number
  cz: number
}
const ROWS = 16
const SEGS = 32
const percentile = (values: number[], fallback: number): number => {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length * 0.9)] ?? fallback
}

export function tailorShirt(body: Body, source: Piece, fitted = false): TailoredShirt | null {
  const at = (name: string) =>
    body.bones.find((bone) => boneKey(bone.name) === name)?.getWorldPosition(new Vector3())
  const hips = at('Hips')
  const neck = at('Neck')
  const left = at('UpperArmL')
  const right = at('UpperArmR')
  if (!(hips && neck && left && right)) {
    return null
  }
  const shoulderY = (left.y + right.y) / 2
  const lo = hips.y + 0.045
  const hi = neck.y + 0.008
  const samples = body.samples.filter((s) => s.slot === SLOT.Shirt || s.slot === SLOT.Sleeves)
  const core = samples.filter((s) =>
    ['Hips', 'Abdomen', 'Torso', 'Chest', 'Neck', 'ShoulderL', 'ShoulderR'].includes(s.bone),
  )
  const profile: ShirtProfile[] = []
  for (let row = 0; row <= ROWS; row++) {
    const y = lo + ((hi - lo) * row) / ROWS
    const band = core.filter((s) => Math.abs(s.p.y - y) < 0.035)
    const shoulderWidth = Math.abs(left.x - right.x) * 0.48
    const rawRx = percentile(
      band.map((s) => Math.abs(s.p.x - hips.x)),
      0.15,
    )
    const zs = band.map((s) => s.p.z).sort((a, b) => a - b)
    const back = zs[Math.floor(zs.length * 0.05)] ?? hips.z - 0.11
    const front = zs[Math.floor(zs.length * 0.95)] ?? hips.z + 0.11
    const rz = Math.max(0.055, (front - back) * 0.5 - 0.006)
    const shoulderT = Math.max(0, Math.min(1, (y - (shoulderY - 0.12)) / 0.12))
    const waist = fitted ? 0.125 : 0.15
    const rx = Math.max(rawRx, waist + (shoulderWidth - waist) * shoulderT)
    const neckT = Math.max(0, Math.min(1, (y - shoulderY) / (hi - shoulderY)))
    profile.push({
      rx: Math.min(shoulderWidth, Math.max(fitted ? 0.12 : 0.13, rx)) * (1 - neckT) + 0.058 * neckT,
      rz: Math.min(0.14, rz) * (1 - neckT) + 0.048 * neckT,
      cx: hips.x + (neck.x - hips.x) * ((y - lo) / (hi - lo)),
      cz: (front + back) * 0.5 * (1 - neckT) + neck.z * neckT,
    })
  }
  softenProfile(profile)
  const outlines = profile.map((shape, row) => {
    const y = lo + ((hi - lo) * row) / ROWS
    return waistOutline(body, shape, y, y < hips.y + 0.2)
  })
  const surface = (x: number, y: number) => {
    const t = Math.max(0, Math.min(ROWS, ((y - lo) / (hi - lo)) * ROWS))
    const row = Math.floor(t)
    const a = outlineFront(outlines[row] ?? [], x)
    const b = outlineFront(outlines[Math.min(ROWS, row + 1)] ?? [], x)
    return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * (t - row) : hips.z + 0.1
  }
  const colors = source.geo.getAttribute('color')
  const color = new Color().setRGB(colors.getX(0), colors.getY(0), colors.getZ(0))
  color.multiplyScalar(0.58)
  const pos: number[] = []
  const col: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const cuffs: Cuff[] = []
  const bindings = new Map<number, ReturnType<WeightFn>>()
  const sleeveUvs = new Map<number, readonly [number, number]>()
  const grid = {
    positions: pos,
    colors: col,
    uv,
    indices: index,
    rows: ROWS,
    segs: SEGS,
    lo,
    hi,
    cuffs,
    bindings,
    sleeveUvs,
  }
  for (let row = 0; row <= ROWS; row++) {
    const y = lo + ((hi - lo) * row) / ROWS
    const r = profile[row] ?? { rx: 0.15, rz: 0.11, cx: hips.x, cz: hips.z }
    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2
      // Broad woven folds stay soft and sewn into the shirt, without a separate front patch.
      const fold = 1 + 0.009 * Math.sin(a * 5) * Math.sin((row / ROWS) * Math.PI)
      pos.push(
        (outlines[row]?.[j % SEGS]?.[0] ?? r.cx) * fold,
        y - 0.018 * Math.max(0, (row - ROWS + 3) / 3) * Math.max(0, Math.cos(a)) ** 8,
        (outlines[row]?.[j % SEGS]?.[1] ?? r.cz) * fold,
      )
      col.push(color.r, color.g, color.b)
      uv.push(j / SEGS, row / ROWS)
      if (row > 0 && j < SEGS) {
        const v = row * (SEGS + 1) + j
        const p = v - SEGS - 1
        index.push(p, p + 1, v, p + 1, v + 1, v)
      }
    }
  }
  for (const side of ['L', 'R'] as const) {
    sewSleeve(grid, side, body, color)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  geo.setIndex(index)
  geo.computeVertexNormals()
  const torso: number[] = []
  const arms: number[] = []
  const torsoVertices = (ROWS + 1) * (SEGS + 1)
  for (let i = 0; i < index.length; i += 3) {
    const triangle = index.slice(i, i + 3)
    const target = triangle.some((vertex) => vertex >= torsoVertices) ? arms : torso
    target.push(...triangle)
  }
  geo.userData.cuffs = cuffs
  const sleeveGeo = compactGarment(geo, arms)
  sleeveUv(sleeveGeo, sleeveUvs)
  const torsoGeo = compactGarment(geo, torso)
  geo.dispose()
  const cloth = {
    swatch: 'linen' as const,
    paletteSlot: source.paletteSlot,
    lum: 0.398,
    roughness: 0.9,
    rim: 0.8,
    weights: shirtTorsoWeights(body),
  }
  return {
    surface,
    sleeves: {
      geo: sleeveGeo,
      name: 'WesternSleeves',
      slot: SLOT.Sleeves,
      ...cloth,
      skin: shirtSkin(sleeveGeo, body, { torso: cloth.weights, rings: bindings }),
    },
    neckline: { x: neck.x, z: neck.z, y: hi },
    piece: {
      geo: torsoGeo,
      name: 'WesternShirt',
      slot: SLOT.Shirt,
      skin: shirtSkin(torsoGeo, body, { torso: cloth.weights, rings: bindings }),
      hide: (_p, bone, garment) =>
        garment === SLOT.Skin &&
        ['UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR'].includes(bone),
      ...cloth,
    },
  }
}

function softenProfile(profile: ShirtProfile[]): void {
  for (let pass = 0; pass < 3; pass++) {
    const previous = profile.map((row) => ({ ...row }))
    for (let row = 1; row < profile.length - 1; row++) {
      const a = previous[row - 1]
      const b = previous[row]
      const c = previous[row + 1]
      if (a && b && c) {
        profile[row] = {
          rx: (a.rx + b.rx * 2 + c.rx) / 4,
          rz: (a.rz + b.rz * 2 + c.rz) / 4,
          cx: (a.cx + b.cx * 2 + c.cx) / 4,
          cz: (a.cz + b.cz * 2 + c.cz) / 4,
        }
      }
    }
  }
}
