/** Sewn collar, placket and work pocket follow the measured cotton surface and spine binding. */
import { Color, Vector3 } from 'three'
import type { Piece } from './bake.ts'
import { type Body, boneKey } from './fit.ts'
import { GeoBuilder } from './geo.ts'
import { creaseNormals } from './normals.ts'
import { SLOT } from './roles.ts'
import { shirtTorsoWeights } from './western-weights.ts'

interface Neckline {
  x: number
  y: number
  z: number
}
const point = (x: number, y: number, z: number) => new Vector3(x, y, z)

export function shirtDetails(
  body: Body,
  shirt: Piece | undefined,
  surface?: (x: number, y: number) => number,
  neckline?: Neckline,
): Piece[] {
  const at = (name: string) =>
    body.bones.find((bone) => boneKey(bone.name) === name)?.getWorldPosition(new Vector3())
  const neck = at('Neck')
  const hips = at('Hips')
  if (!(shirt && neck && hips)) {
    return []
  }
  const cx = neckline?.x ?? neck.x
  const cz = neckline?.z ?? neck.z
  const zAt = (x: number, y: number) => (surface?.(x, y) ?? cz + 0.1) + 0.004
  const colors = shirt.geo.getAttribute('color')
  const tint = new Color().setRGB(colors.getX(0), colors.getY(0), colors.getZ(0))
  const base = tint.getHex()
  const seam = tint.clone().multiplyScalar(0.68).getHex()
  const fold = tint.clone().multiplyScalar(0.9).getHex()
  const cloth = new GeoBuilder(0.24)
  collarStand(cloth, { cx, cz, y: neck.y, color: base })
  // Both collar leaves fold onto the upper chest; their tips do not float above a flat panel.
  for (const side of [-1, 1]) {
    const a = point(cx + side * 0.018, neck.y + 0.012, cz + 0.05)
    const b = point(cx + side * 0.063, neck.y + 0.004, zAt(cx + side * 0.063, neck.y))
    const c = point(
      cx + side * 0.051,
      neck.y - 0.084,
      zAt(cx + side * 0.051, neck.y - 0.084) + 0.002,
    )
    const d = point(cx + side * 0.012, neck.y - 0.034, zAt(cx, neck.y - 0.034) + 0.008)
    if (side > 0) {
      cloth.quad(a, d, c, b, base)
    } else {
      cloth.quad(a, b, c, d, base)
    }
    edge(cloth, b, c, { width: 0.0012, color: fold })
    edge(cloth, c, d, { width: 0.0012, color: fold })
  }
  const top = neck.y - 0.037
  const bottom = hips.y + 0.035
  for (let row = 0; row < 24; row++) {
    const y0 = top + ((bottom - top) * row) / 24
    const y1 = top + ((bottom - top) * (row + 1)) / 24
    for (const [left, right, color] of [
      [-0.012, 0.012, fold],
      [-0.0135, -0.012, seam],
      [0.011, 0.012, seam],
    ] as const) {
      cloth.quad(
        point(cx + left, y0, zAt(cx + left, y0)),
        point(cx + left, y1, zAt(cx + left, y1)),
        point(cx + right, y1, zAt(cx + right, y1)),
        point(cx + right, y0, zAt(cx + right, y0)),
        color,
      )
    }
  }
  pocket(cloth, { cx: cx + 0.071, y: neck.y - 0.18, surface: zAt, color: base, seam })
  const buttons = new GeoBuilder()
  for (let y = neck.y - 0.077; y > hips.y + 0.055; y -= 0.067) {
    button(buttons, point(cx, y, zAt(cx, y) + 0.002))
  }
  const common = { slot: SLOT.Shirt, roughness: 0.87, rim: 0.7, weights: shirtTorsoWeights(body) }
  const tailoring = cloth.build()
  creaseNormals(tailoring, 65)
  // GeoBuilder's town UVs are world-scale. Garments need an in-bounds chart in the atlas swatch.
  const positions = tailoring.getAttribute('position')
  const uv = tailoring.getAttribute('uv')
  for (let i = 0; i < positions.count; i++) {
    uv.setXY(
      i,
      0.5 + (positions.getX(i) - cx) / 0.36,
      (positions.getY(i) - hips.y - 0.02) / (neck.y - hips.y + 0.04),
    )
  }
  return [
    {
      ...common,
      geo: tailoring,
      name: 'ShirtTailoring',
      paletteSlot: shirt.paletteSlot,
      swatch: 'linen',
      lum: shirt.lum ?? 0.398,
    },
    { ...common, geo: buttons.build(), name: 'ShirtButtons', swatch: 'plain', roughness: 0.48 },
  ]
}

function collarStand(
  geo: GeoBuilder,
  o: { cx: number; cz: number; y: number; color: number },
): void {
  const segments = 28
  for (let i = 0; i < segments; i++) {
    const a = 0.32 + ((Math.PI * 2 - 0.64) * i) / segments
    const b = 0.32 + ((Math.PI * 2 - 0.64) * (i + 1)) / segments
    const at = (angle: number, y: number, amount = 1) =>
      point(o.cx + Math.sin(angle) * 0.058 * amount, y, o.cz + Math.cos(angle) * 0.049 * amount)
    geo.quad(
      at(a, o.y - 0.012),
      at(b, o.y - 0.012),
      at(b, o.y + 0.024),
      at(a, o.y + 0.024),
      o.color,
    )
    geo.quad(
      at(a, o.y + 0.024),
      at(b, o.y + 0.024),
      at(b, o.y + 0.025, 0.96),
      at(a, o.y + 0.025, 0.96),
      o.color,
    )
  }
}

function edge(geo: GeoBuilder, a: Vector3, b: Vector3, o: { width: number; color: number }): void {
  const across = new Vector3(b.y - a.y, a.x - b.x, 0).normalize().multiplyScalar(o.width)
  geo.quad(
    a.clone().add(across),
    b.clone().add(across),
    b.clone().sub(across),
    a.clone().sub(across),
    o.color,
  )
}

function pocket(
  geo: GeoBuilder,
  o: {
    cx: number
    y: number
    surface: (x: number, y: number) => number
    color: number
    seam: number
  },
): void {
  const at = (x: number, y: number) => point(x, y, o.surface(x, y) + 0.006)
  const halfWidth = (v: number) => 0.032 * (1 - 0.92 * Math.max(0, (v - 0.78) / 0.22))
  const rows = 10
  const columns = 8
  for (let row = 0; row < rows; row++) {
    const v0 = row / rows
    const v1 = (row + 1) / rows
    const y0 = o.y - v0 * 0.089
    const y1 = o.y - v1 * 0.089
    for (let col = 0; col < columns; col++) {
      const u0 = (col / columns) * 2 - 1
      const u1 = ((col + 1) / columns) * 2 - 1
      geo.quad(
        at(o.cx + u0 * halfWidth(v0), y0),
        at(o.cx + u0 * halfWidth(v1), y1),
        at(o.cx + u1 * halfWidth(v1), y1),
        at(o.cx + u1 * halfWidth(v0), y0),
        o.color,
      )
    }
    for (const side of [-1, 1]) {
      edge(geo, at(o.cx + side * halfWidth(v0), y0), at(o.cx + side * halfWidth(v1), y1), {
        width: 0.0007,
        color: o.seam,
      })
    }
  }
  edge(geo, at(o.cx - 0.032, o.y), at(o.cx + 0.032, o.y), { width: 0.001, color: o.seam })
}

function button(geo: GeoBuilder, center: Vector3): void {
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    const b = ((i + 1) / 10) * Math.PI * 2
    geo.tri(
      center.clone().setZ(center.z + 0.0018),
      point(center.x + Math.cos(a) * 0.0037, center.y + Math.sin(a) * 0.0037, center.z),
      point(center.x + Math.cos(b) * 0.0037, center.y + Math.sin(b) * 0.0037, center.z),
      0xcf_c7_b1,
    )
  }
}
